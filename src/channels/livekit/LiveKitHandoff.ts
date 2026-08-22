import { inject, singleton } from 'tsyringe';
import { and, eq } from 'drizzle-orm';
import { RoomEvent } from '@livekit/rtc-node';
import type { AudioFrame, RemoteParticipant, Room } from '@livekit/rtc-node';
import { db } from '../../db/index';
import { projects, providers, stages } from '../../db/schema';
import { AsrProviderFactory } from '../../services/providers/asr/AsrProviderFactory';
import { LlmProviderFactory } from '../../services/providers/llm/LlmProviderFactory';
import type { IAsrProvider } from '../../services/providers/asr/IAsrProvider';
import { extractTextFromContent } from '../../utils/llm';
import { logger } from '../../utils/logger';

/** Frame granularity of the leg's audio stream, matching how the channel opened it. */
const LEG_FRAME_SIZE_MS = 20;

/** Frame energy above this counts as speech. Same gate voicemail detection uses. */
const HANDOFF_SPEECH_RMS = 500;

/** A pause this long after speech ends the turn. Short: this is an answer, not a conversation. */
const HANDOFF_END_PAUSE_MS = 1200;

/** Nothing said at all within this long means the decision defaults. */
const HANDOFF_NO_SPEECH_MS = 6000;

/** Hard cap on the whole turn, however much the person keeps talking. */
const HANDOFF_MAX_TURN_MS = 15000;

/**
 * Keypad shortcuts, offered because ASR on a handset in a noisy room is not guaranteed and this
 * decision gates whether a call connects. Fixed rather than configurable: 1-to-accept is what
 * every other phone system in the world does, and a per-deployment digit would be a trap.
 */
const DTMF_ACCEPT = '1';
const DTMF_DECLINE = '2';

/**
 * Utterances short and unambiguous enough to resolve without asking a model.
 *
 * Matched against the whole transcript, never as substrings: "not now" contains "no" and means
 * the opposite of what a substring match would conclude. Anything longer than these goes to the
 * LLM, which is also the only path that can carry a message back to the caller.
 */
const PLAIN_ACCEPT = new Set(['yes', 'yeah', 'yep', 'yup', 'accept', 'ok', 'okay', 'sure', 'go ahead', 'put them through', 'put her through', 'put him through']);
const PLAIN_DECLINE = new Set(['no', 'nope', 'decline', 'reject', 'not now', 'no thanks', 'no thank you']);

/** What the person who answered decided to do with the call. */
export type HandoffDecision = {
  /** True to connect the two legs, false to leave the caller with the agent. */
  accept: boolean;
  /** Anything they asked to be passed on, in their own words. Null when there was nothing. */
  relay: string | null;
  /** What the transcript said, for the call summary. Null when nothing was heard. */
  heard: string | null;
  /** How the decision was reached. */
  via: 'dtmf' | 'speech' | 'default';
};

/** Everything needed to run one decision turn against an answered leg. */
export type HandoffRequest = {
  room: Room;
  /**
   * Reader over the answered leg's audio, already open and already partly consumed.
   *
   * Deliberately an iterator handed in rather than a stream opened here. Cancelling an
   * AudioStream detaches the FFI handle for the whole track, so the voicemail detector closing
   * its own reader left any later stream on that track silent forever - the decision turn opened
   * a Transcribe session, received not one frame, and concluded "nothing heard" two milliseconds
   * after connecting. One reader, passed between phases, is the only arrangement that works.
   */
  frames: AsyncIterator<AudioFrame>;
  /** Participant identity of the answered leg. */
  identity: string;
  roomName: string;
  projectId: string;
  /** Stage the conversation runs in, used to find the model that reads the answer. */
  stageId: string | undefined;
};

/**
 * Asks whoever answered a dialed leg whether they want the call, and what to tell the caller.
 *
 * This is the turn that makes an announcement worth making. Having heard "I have someone for
 * you", the person holding the phone can say "yes", or "not now - tell her I'll call back in an
 * hour", and the second answer is the one that carries the product: it declines the bridge AND
 * hands the agent something to say. Both arrive as speech, are transcribed, and are read by the
 * project's own model; the caller then hears the substance in the agent's voice, not a recording
 * of the person who declined.
 *
 * Two things gate the design:
 * - **The default is accept.** Every failure - no ASR configured, a model that will not answer,
 *   silence on the line - ends with the two legs connected, which is the behaviour that existed
 *   before this turn did. Declining by accident drops a call that a person deliberately answered.
 * - **DTMF resolves immediately.** Speech recognition on a handset is not reliable enough to be
 *   the only way to refuse a call.
 */
@singleton()
export class LiveKitHandoff {
  constructor(
    @inject(AsrProviderFactory) private readonly asrProviderFactory: AsrProviderFactory,
    @inject(LlmProviderFactory) private readonly llmProviderFactory: LlmProviderFactory,
  ) {}

  /**
   * Runs one decision turn and returns what the answering party wants done.
   * @param request - The answered leg and its routing context.
   */
  async ask(request: HandoffRequest): Promise<HandoffDecision> {
    const fallback: HandoffDecision = { accept: true, relay: null, heard: null, via: 'default' };

    try {
      const { digit, transcript } = await this.listen(request);

      if (digit === DTMF_ACCEPT) return { accept: true, relay: null, heard: null, via: 'dtmf' };
      if (digit === DTMF_DECLINE) return { accept: false, relay: null, heard: null, via: 'dtmf' };

      if (!transcript) {
        logger.info({ roomName: request.roomName, identity: request.identity }, 'LiveKit: nothing heard in the handoff turn, connecting the call');
        return fallback;
      }

      const plain = this.readPlainAnswer(transcript);
      if (plain !== null) return { accept: plain, relay: null, heard: transcript, via: 'speech' };

      const read = await this.readWithModel(request, transcript);
      if (!read) return { ...fallback, heard: transcript };

      return { accept: read.accept, relay: read.relay, heard: transcript, via: 'speech' };
    } catch (error) {
      logger.error({ error, roomName: request.roomName, identity: request.identity }, 'LiveKit: the handoff turn failed, connecting the call');
      return fallback;
    }
  }

  /**
   * Listens to the answered leg for one turn, returning a keypad digit or a transcript.
   *
   * The turn ends on the first of: a keypress, a pause after speech, silence throughout, or the
   * hard cap. Energy gating decides the boundaries rather than the ASR, because Transcribe will
   * happily hold a stream open across a pause and this turn must not outlast the patience of two
   * people already waiting on the line.
   * @param request - The answered leg and its routing context.
   */
  private async listen(request: HandoffRequest): Promise<{ digit: string | null; transcript: string | null }> {
    const { room, frames, identity, roomName, projectId } = request;

    let digit: string | null = null;
    const onDtmf = (_code: number, pressed: string, participant: RemoteParticipant): void => {
      if (participant.identity !== identity) return;
      if (pressed !== DTMF_ACCEPT && pressed !== DTMF_DECLINE) return;
      digit = pressed;
      logger.info({ roomName, identity, digit: pressed }, 'LiveKit: the answering party used the keypad');
    };
    room.on(RoomEvent.DtmfReceived, onDtmf);

    const asr = await this.openAsr(projectId, roomName);
    // Started after the recogniser is constructed, so the clock measures how long the answering
    // party has been given to speak - not how long a provider took to wake up.
    const startedAt = Date.now();
    let speechMs = 0;
    let silenceMs = 0;

    try {
      while (true) {
        if (digit) break;

        const next = await frames.next();
        if (next.done) break;
        const frame = next.value;

        const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);

        // Deliberately NOT awaited. Transcribe opens its stream lazily on the first chunk, and
        // awaiting that put seconds of connection latency inside the frame loop: the energy gate
        // stopped advancing through the audio in real time, so the turn spent its whole budget
        // still chewing on the first second and never reached the reply. Fire the audio at the
        // recogniser and keep reading.
        void asr?.sendAudio(buffer).catch((error) => {
          logger.debug({ error, roomName }, 'LiveKit: dropped an audio chunk on the way to recognition');
        });

        if (this.frameRms(frame.data) > HANDOFF_SPEECH_RMS) {
          speechMs += LEG_FRAME_SIZE_MS;
          silenceMs = 0;
        } else {
          silenceMs += LEG_FRAME_SIZE_MS;
          // A pause once they have said something is the end of the answer.
          if (speechMs > 0 && silenceMs >= HANDOFF_END_PAUSE_MS) break;
        }

        const elapsed = Date.now() - startedAt;
        if (speechMs === 0 && elapsed > HANDOFF_NO_SPEECH_MS) break;
        if (elapsed > HANDOFF_MAX_TURN_MS) {
          logger.info({ roomName, identity }, 'LiveKit: the handoff turn hit its time cap');
          break;
        }
      }
    } finally {
      room.off(RoomEvent.DtmfReceived, onDtmf);
      // The reader is NOT closed here. It belongs to the caller, which opened it before voicemail
      // detection and closes it once the bridge is settled.
    }

    const transcript = asr ? await this.closeAsr(asr, roomName) : null;
    return { digit, transcript: digit ? null : transcript };
  }

  /**
   * Opens a speech recognition session for the answered leg, or returns null when the project has
   * none configured. A missing ASR is not an error here: the keypad still works and the call still
   * connects.
   * @param projectId - Project whose ASR configuration to use.
   * @param roomName - For log context.
   */
  private async openAsr(projectId: string, roomName: string): Promise<IAsrProvider | null> {
    try {
      const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
      const asrProviderId = project?.asrConfig?.asrProviderId;
      if (!project?.acceptVoice || !asrProviderId) {
        logger.info({ projectId, roomName }, 'LiveKit: no speech recognition configured, the handoff turn is keypad-only');
        return null;
      }

      const entity = await db.query.providers.findFirst({ where: eq(providers.id, asrProviderId) });
      if (!entity) return null;

      const asr = await this.asrProviderFactory.createProvider(entity, project.asrConfig?.settings ?? {});
      await asr.init();
      await asr.start();
      return asr;
    } catch (error) {
      logger.error({ error, projectId, roomName }, 'LiveKit: could not start speech recognition for the handoff turn');
      return null;
    }
  }

  /**
   * Stops recognition and returns everything it heard as one line.
   * @param asr - The recognition session to close.
   * @param roomName - For log context.
   */
  private async closeAsr(asr: IAsrProvider, roomName: string): Promise<string | null> {
    try {
      await asr.stop();
      const transcript = asr.getAllTextChunks().map((chunk) => chunk.text).join(' ').trim();
      return transcript.length > 0 ? transcript : null;
    } catch (error) {
      logger.error({ error, roomName }, 'LiveKit: failed to read back the handoff transcript');
      return null;
    } finally {
      await asr.cleanup().catch(() => undefined);
    }
  }

  /**
   * Resolves a bare yes or no without a model call, or returns null to defer to one.
   * @param transcript - What the answering party said.
   */
  private readPlainAnswer(transcript: string): boolean | null {
    const normalized = transcript.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
    if (PLAIN_ACCEPT.has(normalized)) return true;
    if (PLAIN_DECLINE.has(normalized)) return false;
    return null;
  }

  /**
   * Reads an answer that is more than yes or no, using the stage's own model.
   *
   * The model is asked for two things: whether to connect the call, and what - if anything - the
   * caller should be told. It is explicitly not asked to write the caller-facing sentence; that
   * belongs to the relay stage, where the project's own prompt and guardrails apply. Here it only
   * extracts the substance of what was said.
   * @param request - The answered leg and its routing context.
   * @param transcript - What the answering party said.
   */
  private async readWithModel(request: HandoffRequest, transcript: string): Promise<{ accept: boolean; relay: string | null } | null> {
    const { projectId, stageId, roomName } = request;

    try {
      if (!stageId) return null;

      const stage = await db.query.stages.findFirst({ where: and(eq(stages.projectId, projectId), eq(stages.id, stageId)) });
      if (!stage?.llmProviderId) return null;

      const entity = await db.query.providers.findFirst({ where: eq(providers.id, stage.llmProviderId) });
      if (!entity) return null;

      const llm = await this.llmProviderFactory.createProvider(entity, stage.llmSettings);
      try {
        await llm.init();
        const result = await llm.generate([
          { role: 'system', content: HANDOFF_PROMPT },
          { role: 'user', content: transcript },
        ], { outputFormat: 'json', maxTokens: 200 });

        const parsed = this.parseDecision(extractTextFromContent(result.content));
        if (!parsed) {
          logger.warn({ roomName, transcript }, 'LiveKit: could not read the handoff answer, connecting the call');
          return null;
        }

        logger.info({ roomName, accept: parsed.accept, hasRelay: Boolean(parsed.relay) }, 'LiveKit: read the handoff answer');
        return parsed;
      } finally {
        await llm.cleanup().catch(() => undefined);
      }
    } catch (error) {
      logger.error({ error, roomName }, 'LiveKit: reading the handoff answer failed, connecting the call');
      return null;
    }
  }

  /**
   * Pulls the decision out of a model response, tolerating fenced or prose-wrapped JSON.
   * @param text - Raw model output.
   */
  private parseDecision(text: string): { accept: boolean; relay: string | null } | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      const parsed = JSON.parse(match[0]) as { accept?: unknown; relay?: unknown };
      if (typeof parsed.accept !== 'boolean') return null;

      const relay = typeof parsed.relay === 'string' && parsed.relay.trim().length > 0 ? parsed.relay.trim() : null;
      return { accept: parsed.accept, relay };
    } catch {
      return null;
    }
  }

  /**
   * Root-mean-square amplitude of a PCM frame, used as a cheap speech/silence gate.
   * @param samples - Signed 16-bit PCM samples.
   */
  private frameRms(samples: Int16Array): number {
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }
}

/**
 * Instruction for reading the answering party's reply.
 *
 * Deliberately narrow. It classifies and extracts; it does not compose. The wording the caller
 * eventually hears is produced by the relay stage, so that the project's prompt, its voice and
 * its guardrails all still apply to anything said on its behalf.
 */
const HANDOFF_PROMPT = `Someone was told a call is waiting for them and has just answered whether they want it.

Reply with JSON only, no prose, in exactly this shape:
{"accept": true|false, "relay": string|null}

"accept" is true if they want to be connected to the caller now, false if they do not.

"relay" is what they want passed on to the caller, stated plainly and in the third person - for
example "he will call back in about an hour". Use null when they did not ask for anything to be
passed on. Never invent a message. Never include the decision itself in the relay.

Treat anything that defers the call - "not now", "later", "tell them I'm busy" - as accept false.
If the reply is genuinely unclear, use accept true.`;
