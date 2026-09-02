import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  LanguageCode,
  MediaEncoding,
  PartialResultsStability,
} from '@aws-sdk/client-transcribe-streaming';
import type { AudioStream, TranscriptResultStream } from '@aws-sdk/client-transcribe-streaming';
import { AsrProviderBase } from './AsrProviderBase';
import { logger } from '../../../utils/logger';
import type { AudioFormat } from '../../../types/audio';
import { pcmSampleRate } from '../../audio/AudioFormatUtils';
import { generateId, ID_PREFIXES } from '../../../utils/idGenerator';
import type { AsrFeedTap } from '../../live/AsrFeedTap';

extendZodWithOpenApi(z);

/**
 * Schema for Amazon Transcribe ASR provider configuration.
 *
 * Credentials are optional on purpose. When omitted the AWS default credential chain is used,
 * which resolves an EC2 instance role or ECS task role. That is the preferred deployment: it keeps
 * long-lived keys out of the database entirely.
 */
export const transcribeAsrProviderConfigSchema = z.strictObject({
  region: z.string().default('us-east-1').describe('AWS region hosting the Transcribe streaming endpoint'),
  accessKeyId: z.string().optional().describe('AWS access key id. Omit to use the default credential chain (instance or task role).'),
  secretAccessKey: z.string().optional().describe('AWS secret access key. Omit to use the default credential chain.'),
  sessionToken: z.string().optional().describe('AWS session token, when using temporary credentials.'),
});

export type TranscribeAsrProviderConfig = z.infer<typeof transcribeAsrProviderConfigSchema>;

/**
 * Schema for Amazon Transcribe ASR settings.
 */
export const transcribeAsrSettingsSchema = z.looseObject({
  audioFormat: z.enum(['pcm_8000', 'pcm_16000', 'pcm_24000', 'pcm_48000']).default('pcm_16000').describe('Audio encoding format for speech-to-text, defaults to pcm_16000'),
  language: z.string().default('en-US').describe('BCP-47 language tag, e.g. "en-US"'),
  interimResults: z.boolean().default(true).describe('Emit partial transcription results while the caller is still speaking, defaults to true'),
  partialResultsStability: z.enum(['high', 'medium', 'low']).default('medium').describe('How aggressively Transcribe stabilises partial results. Higher stability means fewer rewrites but more latency.'),
  vocabularyName: z.string().optional().describe('Name of a custom vocabulary to bias recognition'),
  vocabularyFilterName: z.string().optional().describe('Name of a vocabulary filter to apply'),
  contentRedactionEnabled: z.boolean().default(false).describe('Enable PII redaction in transcripts, defaults to false'),
  piiEntityTypes: z.string().optional().describe('Comma-separated PII entity types to redact when content redaction is enabled, e.g. "NAME,PHONE"'),
  continuousStream: z.boolean().default(false).describe('Hold ONE Transcribe stream open for the whole call, marking turn boundaries instead of opening a session per turn. Recognition is measurably better - a one-word answer inside a running stream beats the same word handed to a cold session - at about 4.25x the streamed audio, since silence is billed too. Off by default: it changes the session lifecycle the runner depends on, so it is opt-in per project.'),
}).openapi('TranscribeAsrSettings').describe('Amazon Transcribe speech-to-text settings');

export type TranscribeAsrSettings = z.infer<typeof transcribeAsrSettingsSchema>;

/** How long an idle stream waits before emitting keepalive silence. Transcribe's limit is 15s. */
const KEEPALIVE_INTERVAL_MS = 4000;

/** Duration of each keepalive silence frame. */
const KEEPALIVE_FRAME_MS = 100;

/**
 * Mean confidence over the spoken words of a final result.
 *
 * Transcribe reports confidence per item rather than per result, and only for finals. Punctuation
 * carries its own confidence that says nothing about whether a word was heard, so it is left out.
 * Returns undefined when nothing usable is present, which downstream reads as "unknown" rather
 * than "low" - the distinction matters, because a gate that treated the two alike would mute a
 * provider the moment it stopped reporting.
 */
export function meanItemConfidence(items?: Array<{ Type?: string; Confidence?: number }>): number | undefined {
  const scored = (items ?? []).filter((item) => item.Type === 'pronunciation' && typeof item.Confidence === 'number');
  if (scored.length === 0) return undefined;
  return scored.reduce((total, item) => total + (item.Confidence as number), 0) / scored.length;
}

/** Maps the settings stability enum onto the SDK enum. */
const STABILITY_MAP: Record<string, PartialResultsStability> = {
  high: PartialResultsStability.HIGH,
  medium: PartialResultsStability.MEDIUM,
  low: PartialResultsStability.LOW,
};

/**
 * Amazon Transcribe streaming ASR provider.
 *
 * Transcribe's streaming API is pull-based: the SDK consumes an `AsyncIterable` of audio events
 * for the lifetime of the session. The {@link IAsrProvider} contract is push-based - the runner
 * calls {@link sendAudio} whenever a frame arrives. This class bridges the two with a small queue
 * and a single pending waiter, so audio is handed to the SDK as fast as it arrives without
 * spinning or dropping frames.
 *
 * Choosing Transcribe over a third-party ASR is a compliance decision, not a quality one: it keeps
 * speech recognition inside the same AWS BAA that already covers Bedrock, Polly and S3, so a voice
 * conversation carrying PHI never leaves that agreement.
 */
export class TranscribeAsrProvider extends AsrProviderBase<TranscribeAsrProviderConfig> {
  private client: TranscribeStreamingClient | null = null;
  private settings: TranscribeAsrSettings;
  private audioFormat: AudioFormat;
  private currentChunkId: string;

  /** Frames waiting to be handed to the SDK. */
  private queue: Buffer[] = [];
  /** Resolver for a generator currently parked on an empty queue. */
  private waiter: (() => void) | null = null;
  /** Set once the session should wind down; makes the generator return. */
  private ended = false;
  private isRecognizing = false;
  /** Whether the Transcribe stream has been opened. Opening is deferred until the first frame. */
  private streamOpen = false;
  /** Text of the most recent partial result, promoted to a final chunk if the stream ends abruptly. */
  private lastPartial = '';
  /** Resolves when the result stream has been fully drained, so stop() can wait for the real final. */
  private consumeDone: Promise<void> | null = null;

  /**
   * How long stop() will wait for Transcribe to finalise before giving up and using the partial.
   *
   * Partials trail the audio by roughly 300-1000ms and are explicitly revisable, so the last one
   * seen is a hypothesis from before the caller finished speaking. Returning it immediately is
   * what produced transcripts cut mid-word - "I'd like to book that appoint" - even when the
   * endpoint decision itself was correct.
   *
   * The ceiling matters as much as the wait. This sits directly between the caller finishing and
   * the agent replying, so an unbounded wait would trade one visible fault for a slower one.
   */
  private static readonly FINALIZE_TIMEOUT_MS = 800;

  /**
   * How long a continuous-mode turn waits for an outstanding final before falling back to the
   * partial it already has.
   *
   * Shorter than FINALIZE_TIMEOUT_MS because it is a different wait: that one followed an EOF and
   * had to cover a whole stream draining, this one is the tail of a segment on a stream that is
   * still running, and our VAD has already spent 800ms of silence getting here.
   */
  private static readonly FINAL_WAIT_MS = 500;

  /**
   * Optional recorder of what this provider actually feeds Transcribe. Off unless set, and when
   * set it may only push and count - see the contract on AsrFeedTap.
   */
  private tap: AsrFeedTap | null = null;

  /** Resolved by consume() the moment a final arrives, so a turn can wait for one. */
  private finalArrived: (() => void) | null = null;

  setFeedTap(tap: AsrFeedTap | null): void { this.tap = tap; }

  constructor(config: TranscribeAsrProviderConfig, settings: TranscribeAsrSettings) {
    super(config);
    this.settings = settings;
    this.audioFormat = settings.audioFormat;
    this.currentChunkId = generateId(ID_PREFIXES.CHUNK);
  }

  /**
   * Supported input formats, best first.
   *
   * Order matters: the runner picks the first entry it can supply, so listing 8 kHz first made it
   * downsample 16 kHz telephony audio before Transcribe ever saw it, measurably hurting accuracy
   * for nothing. 16 kHz is the sweet spot for Transcribe and is what the LiveKit channel already
   * delivers, so no conversion happens at all.
   */
  getSupportedInputFormats(): AudioFormat[] {
    return ['pcm_16000', 'pcm_8000', 'pcm_24000', 'pcm_48000'];
  }

  /** @inheritdoc */
  async init(): Promise<void> {
    await super.init();

    const credentials = this.config.accessKeyId && this.config.secretAccessKey
      ? {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
        sessionToken: this.config.sessionToken,
      }
      : undefined;

    this.client = new TranscribeStreamingClient({ region: this.config.region, credentials });
    logger.info(`Transcribe ASR provider initialized in ${this.config.region} using ${credentials ? 'static credentials' : 'the default credential chain'}`);
  }

  /**
   * Marks the session ready to receive audio.
   *
   * The Transcribe stream itself is opened lazily, on the first audio frame. Transcribe closes a
   * stream that receives no audio for 15 seconds, and the runner pre-warms the ASR session before
   * the caller has said anything - often before the agent has even finished its own turn. Opening
   * eagerly meant the stream reliably died of that timeout just as real audio began arriving.
   * Deferring also avoids being billed for an idle stream.
   */
  async start(): Promise<void> {
    // CONTINUOUS MODE. One Transcribe stream for the whole call, with turn boundaries marked
    // rather than enforced by opening and closing sessions.
    //
    // Measured on 2026-08-28: the same 61 seconds of audio reads as "... Kurt. K. It's Kurt."
    // through one continuous session and as "So / Kirk. / It's Kurt. / Kirk." through one session
    // per turn. Identical bytes, same recogniser. A one-word answer handed to a cold session with
    // no preceding context is a much harder recognition problem than the same word inside a
    // running stream, and a caller's name is almost always a one-word answer.
    //
    // The two questions this separates were conflated before: WHEN TO RESPOND stays ours, decided
    // by the VAD and by the endpointing tiers in ConversationRunner. WHAT WAS SAID belongs to
    // Transcribe, on its own schedule, off a stream that never stops.
    //
    // Costs 4.25x more streamed audio - measured across seven real calls - which is two to nine
    // cents on a five-minute call depending on whose published rate is right. See THERAPY-b5xwm.38.
    if (this.settings.continuousStream && this.isRecognizing) {
      this.beginTurn();
      return;
    }

    if (this.isRecognizing) return;
    if (!this.client) await this.init();

    // getAllTextChunks() is documented as returning what was recognised SINCE THE LAST start(),
    // and the runner reads it that way: on every end-of-utterance it takes the whole chunk list
    // as the caller's utterance. Every other provider clears here; this one did not, so the
    // chunks survived into the next turn and the runner replayed the previous sentence as if it
    // had just been spoken. On a barged-in call that repeats: each replay opens a turn, and the
    // new turn's TTS cancels the reply still being spoken, so the agent talks over itself and
    // never finishes a sentence.
    this.textChunks = [];
    this.queue = [];
    this.waiter = null;
    this.ended = false;
    this.lastPartial = '';
    this.currentChunkId = generateId(ID_PREFIXES.CHUNK);
    this.isRecognizing = true;
    this.streamOpen = false;

    this.tap?.newSession();
    this.onRecognitionStartedCallback?.();
  }

  /**
   * Opens the Transcribe streaming session and begins consuming results.
   *
   * The command promise resolves once the stream is established, after which results are drained
   * in the background until the session ends.
   */
  private async openStream(): Promise<void> {
    if (this.streamOpen || !this.isRecognizing) return;
    this.streamOpen = true;

    const sampleRate = pcmSampleRate(this.audioFormat);

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: this.settings.language as LanguageCode,
      MediaEncoding: MediaEncoding.PCM,
      MediaSampleRateHertz: sampleRate,
      AudioStream: this.buildAudioStream(),
      EnablePartialResultsStabilization: this.settings.interimResults,
      PartialResultsStability: this.settings.interimResults ? STABILITY_MAP[this.settings.partialResultsStability] : undefined,
      VocabularyName: this.settings.vocabularyName,
      VocabularyFilterName: this.settings.vocabularyFilterName,
      ContentRedactionType: this.settings.contentRedactionEnabled ? 'PII' : undefined,
      PiiEntityTypes: this.settings.contentRedactionEnabled ? this.settings.piiEntityTypes : undefined,
    });

    try {
      const response = await this.client!.send(command);
      this.tap?.mark('stream-open');
      logger.info(`Transcribe ASR stream opened at ${sampleRate} Hz for language ${this.settings.language}`);

      if (response.TranscriptResultStream) {
        this.consumeDone = this.consume(response.TranscriptResultStream);
      }
    } catch (error) {
      this.streamOpen = false;
      this.isRecognizing = false;
      await this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Marks a new turn on a stream that is already running.
   *
   * Everything cleared here is PER-TURN state - what the caller said this time. The stream, the
   * queue and the `ended` flag are deliberately untouched, because they belong to the call.
   */
  private beginTurn(): void {
    this.textChunks = [];
    this.lastPartial = '';
    this.currentChunkId = generateId(ID_PREFIXES.CHUNK);
    this.tap?.mark('turn-begin');
  }

  /**
   * Ends the TURN without ending the stream.
   *
   * There is no finalize race here, and that is the point of the mode. In the per-turn design
   * `stop()` had to send EOF and then wait up to 800ms for Transcribe to emit a final, because
   * closing the session was the only way to make it commit - a wait that sat directly between the
   * caller finishing and the agent answering. With the stream still running, whatever Transcribe
   * has already emitted is simply taken, and a stabilised partial that never became a final is
   * promoted exactly as before. Our VAD needs 800ms of silence to call the turn over, by which
   * point Transcribe has almost always finalised on its own.
   */
  private async stopTurn(): Promise<void> {
    this.tap?.mark('turn-end');

    // WAIT FOR THE FINAL. It is going to arrive: on a stream that never closes, Transcribe
    // finalises the segment on its own schedule whether or not we are still listening. A partial
    // is a latency affordance, not the truth, and taking one when the truth is seconds away is how
    // the same words ended up in two turns at once.
    //
    // The wait is rarely paid. Measured over six turns of a replay, four had already finalised by
    // the time the turn ended - unsurprising, since our VAD needs 800ms of silence before it calls
    // a turn over, and that is a long time for a recogniser.
    //
    // THE DEADLINE IS NOT OPTIONAL, and it is the whole reason a partial is still kept. A final
    // that never comes - a stream error, or a segment Transcribe decides was not speech - would
    // hang the turn forever and the agent would simply never speak. Four separate bugs in this
    // system were a suppression path with no exit, and an unbounded wait here would be the fifth.
    // So: prefer the final, fall back to the partial, and never wait indefinitely for either.
    if (this.lastPartial.trim()) {
      await this.waitForFinal();
    }

    if (this.lastPartial.trim()) {
      logger.info(
        { fellBackToPartial: this.lastPartial.trim(), finalsThisTurn: this.textChunks.length },
        `[ASR] No final within ${TranscribeAsrProvider.FINAL_WAIT_MS}ms; using the partial`,
      );
      this.handleRecognized(this.currentChunkId, this.lastPartial.trim());
      this.lastPartial = '';
    } else {
      logger.info({ finalsThisTurn: this.textChunks.length }, '[ASR] Turn ended on finals');
    }

    this.handleRecognitionStopped();
  }

  /**
   * Waits for the next final, or for the deadline, whichever comes first.
   *
   * Cheaper than it looks: the waiter is only armed while something is genuinely outstanding, and
   * it is resolved by the consume loop rather than polled.
   */
  private waitForFinal(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.finalArrived = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, TranscribeAsrProvider.FINAL_WAIT_MS);
      this.finalArrived = finish;
    });
  }

  /**
   * Ends the audio stream and stops recognition.
   *
   * Any stabilised partial that never reached a final result is promoted to a final chunk, so a
   * caller who stops speaking mid-sentence still contributes their words to the turn.
   */
  async stop(): Promise<void> {
    if (!this.isRecognizing) return;

    // In continuous mode the call owns the stream, so ending a turn must not end it. cleanup()
    // is the only thing that closes it.
    if (this.settings.continuousStream) {
      await this.stopTurn();
      return;
    }

    this.tap?.mark('stop');
    this.isRecognizing = false;
    this.streamOpen = false;
    this.ended = true;
    this.wake();

    // Let Transcribe finish what it already has before calling the turn over.
    //
    // Ending the audio generator sends EOF, and Transcribe then emits a non-partial result for
    // the audio it has already been given. Firing handleRecognitionStopped without waiting meant
    // the turn was submitted with whatever PARTIAL happened to be current - a hypothesis from
    // several hundred milliseconds before the caller stopped talking - so transcripts arrived cut
    // mid-word even when the endpoint decision was right. The Azure provider in this same
    // directory already gets this right and says why; this is that behaviour, with a deadline.
    //
    // The deadline is not optional. This wait sits between the caller finishing and the agent
    // answering, so a stream that never closes must not hold the call open indefinitely.
    if (this.consumeDone) {
      const drained = this.consumeDone;
      this.consumeDone = null;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        drained.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(`[ASR] Transcribe did not finalise within ${TranscribeAsrProvider.FINALIZE_TIMEOUT_MS}ms, using the last partial`);
            resolve();
          }, TranscribeAsrProvider.FINALIZE_TIMEOUT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }

    // Only if the real final never arrived. When it did, consume() has already emitted it and
    // cleared lastPartial, and promoting a stale hypothesis on top would duplicate the tail.
    if (this.lastPartial.trim()) {
      this.handleRecognized(this.currentChunkId, this.lastPartial.trim());
      this.lastPartial = '';
    }

    this.handleRecognitionStopped();
  }

  /**
   * Queues an audio frame for the Transcribe stream.
   * @param audio - Raw PCM bytes in the configured format.
   * @param format - Format of this frame; a mismatch is logged and the frame dropped.
   */
  async sendAudio(audio: Buffer, format?: AudioFormat): Promise<void> {
    if (!this.isRecognizing || this.ended) {
      // Both of these discard caller audio and neither has ever left a trace.
      if (this.ended) this.tap?.countDroppedEnded();
      else this.tap?.countDroppedNotRecognizing();
      return;
    }
    this.tap?.countAccepted();

    if (format && format !== this.audioFormat) {
      logger.warn(`Transcribe ASR received ${format} but the session is ${this.audioFormat}, dropping frame`);
      return;
    }

    this.queue.push(audio);
    this.wake();

    // First frame of the turn opens the stream. Queued above first so it is not lost.
    //
    // NOT AWAITED. Opening is a network round trip, and this method sits on the audio frame path:
    // the runner awaits sendAudio for every frame, and the LiveKit pump awaits the runner. When
    // the runner pre-warms the session as the greeting ends, the very next frame used to pay the
    // whole open here, the pump stalled behind it, the audio iterable the open was waiting on
    // starved, and the two waited on each other until the next stop(). Measured on 2026-09-02:
    // the VAD received no frames for 8.3 seconds after every greeting, and every phone call since
    // 2026-08-31 lost the caller's first utterance to it. Frames keep queueing while the stream
    // comes up and drain the moment it does; openStream handles its own failure.
    if (!this.streamOpen) void this.openStream();
  }

  /** @inheritdoc */
  resetForNewTurn(): void {
    this.tap?.mark('reset-for-new-turn');
    if (this.settings.continuousStream) {
      // super.resetForNewTurn() only clears the chunk list, which beginTurn already does, but
      // going through the same door keeps the two paths from drifting apart.
      this.beginTurn();
      return;
    }
    super.resetForNewTurn();
    this.currentChunkId = generateId(ID_PREFIXES.CHUNK);
    this.lastPartial = '';
  }

  /** @inheritdoc */
  async cleanup(): Promise<void> {
    // The call is over, so the stream really does end here - stop() would only have ended a turn.
    if (this.settings.continuousStream) {
      this.isRecognizing = false;
      this.streamOpen = false;
      this.ended = true;
      this.wake();
      this.tap?.mark('stop');
    }
    await this.stop();
    this.client?.destroy();
    this.client = null;
    this.queue = [];
    await super.cleanup();
  }

  /**
   * Builds the pull-based audio iterable the Transcribe SDK consumes.
   *
   * Parks on a promise when the queue is empty rather than polling, so an idle session costs
   * nothing and a newly queued frame is handed over immediately.
   */
  private async *buildAudioStream(): AsyncGenerator<AudioStream> {
    while (!this.ended) {
      if (this.queue.length === 0) {
        // Transcribe closes any stream that goes 15 seconds without audio, and a caller who is
        // listening to the agent is legitimately silent for longer than that. Rather than let the
        // stream die mid-conversation, wait a bounded interval and emit a frame of silence to keep
        // it open. Silence costs a few hundred bytes and does not affect the transcript.
        const gotAudio = await this.waitForAudio(KEEPALIVE_INTERVAL_MS);
        if (!gotAudio && !this.ended) {
          const silence = this.silenceFrame();
          this.tap?.fed(silence, true);
          yield { AudioEvent: { AudioChunk: silence } };
        }
        continue;
      }

      const chunk = this.queue.shift();
      if (chunk) { this.tap?.fed(chunk); yield { AudioEvent: { AudioChunk: chunk } }; }
    }

    // Drain anything queued between the final wake and the end flag being observed.
    while (this.queue.length > 0) {
      const chunk = this.queue.shift();
      if (chunk) { this.tap?.fed(chunk); yield { AudioEvent: { AudioChunk: chunk } }; }
    }
  }

  /**
   * Drains the Transcribe result stream, emitting partial and final recognition events.
   * @param stream - The result stream returned by StartStreamTranscription.
   */
  private async consume(stream: AsyncIterable<TranscriptResultStream>): Promise<void> {
    try {
      for await (const event of stream) {
        const results = event.TranscriptEvent?.Transcript?.Results;
        if (!results?.length) continue;

        for (const result of results) {
          const text = result.Alternatives?.[0]?.Transcript ?? '';
          if (!text) continue;

          if (result.IsPartial) {
            this.lastPartial = text;
            this.handleRecognizing(this.currentChunkId, text);
          } else {
            this.lastPartial = '';
            this.handleRecognized(this.currentChunkId, text, meanItemConfidence(result.Alternatives?.[0]?.Items));
            this.currentChunkId = generateId(ID_PREFIXES.CHUNK);
            // Releases a turn that is holding on for exactly this.
            this.finalArrived?.();
          }
        }
      }
    } catch (error) {
      if (this.isRecognizing) {
        await this.handleError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** Releases a generator parked on an empty queue. */
  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  /**
   * Waits for audio to be queued, or for the timeout to elapse.
   * @param timeoutMs - How long to wait before giving up.
   * @returns True if audio arrived, false if the wait timed out.
   */
  private waitForAudio(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiter = null;
        resolve(false);
      }, timeoutMs);

      this.waiter = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  /** A short buffer of PCM silence, used to keep an idle Transcribe stream alive. */
  private silenceFrame(): Buffer {
    const samples = Math.round((pcmSampleRate(this.audioFormat) * KEEPALIVE_FRAME_MS) / 1000);
    return Buffer.alloc(samples * 2);
  }
}
