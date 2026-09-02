import { AudioFrame } from '@livekit/rtc-node';
import type { AudioSource, Room } from '@livekit/rtc-node';
import type { Session, SessionManager } from '../SessionManager';
import type { IClientConnection } from '../IClientConnection';
import type { CALOutputMessage } from '../messages';
import { isPcmFormat, pcmSampleRate } from '../../services/audio/AudioFormatUtils';
import { logger } from '../../utils/logger';

/**
 * Converts a little-endian signed 16-bit PCM buffer into a LiveKit {@link AudioFrame}.
 *
 * The samples are copied rather than viewed in place: a Node `Buffer` is a slice of a shared pool
 * and its `byteOffset` is frequently odd, which would make an `Int16Array` view over it throw.
 * Returns `null` for an empty or odd-length payload.
 *
 * Shared with the channel host, which publishes announcement audio onto a second track of its own.
 * @param audioData - Raw PCM16LE bytes.
 * @param sampleRate - Sample rate the payload was produced at.
 */
export function pcmToAudioFrame(audioData: Buffer, sampleRate: number): AudioFrame | null {
  const sampleCount = Math.floor(audioData.byteLength / 2);
  if (sampleCount === 0) return null;

  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = audioData.readInt16LE(i * 2);
  }

  return new AudioFrame(samples, sampleRate, 1, sampleCount);
}

/**
 * How much audio goes into one captured frame.
 *
 * Twenty milliseconds is what the transport wants and what every other participant sends. A TTS
 * vendor is under no obligation to deliver audio in those units, and the streaming ones do not:
 * a sentence can arrive as a single buffer holding seconds of speech.
 */
const CAPTURE_FRAME_MS = 20;

/**
 * How much unplayed audio may sit in the source before more is pushed into it.
 *
 * The source holds a second and rejects anything beyond it, so this is backpressure, not tuning.
 * A streaming vendor returns audio far faster than real time - flash renders three seconds of
 * speech in four hundred milliseconds - and without a wait the tail of a long sentence arrives
 * at a full queue and is refused. Left at 800ms there is room for a frame plus the jitter of
 * getting to it, and nothing is lost.
 */
const QUEUE_HIGH_WATER_MS = 800;

/**
 * A gap between frames longer than this, mid-utterance, is audible as a break in the voice.
 *
 * Chosen against what the source itself tolerates: it holds a second of audio, so a stall only
 * becomes a hole once the queue drains, and by 400ms of pushing nothing the caller is hearing
 * silence in the middle of a sentence. Below that a stall is absorbed and nobody can tell.
 */
const STALL_MS = 400;

/**
 * How long after the source has played out a goodbye the line is held before it is dropped.
 *
 * `waitForPlayout` answers for the source's own queue and nothing past it: the WebRTC leg, the
 * SIP bridge and the carrier each hold a little audio in flight, and none of it is visible here.
 * On 2026-08-31 the caller was removed 300ms after the last byte of "Take care." was synthesised,
 * and heard it cut off. A measured guess, deliberately generous - re-measure it against a
 * dual-channel Twilio recording (`hear_it.py --collect`) rather than tuning it by ear.
 */
export const PSTN_TAIL_MS = 700;

/**
 * The most any drain will wait, whatever the accounting says.
 *
 * A stuck counter or a source that never reports empty must not leave the line open forever with
 * nobody listening. Long enough for the longest goodbye this line speaks, and short enough that
 * a fault reads as a late hang-up rather than a dead line.
 */
export const DRAIN_BOUND_MS = 15_000;

/** The clock the playout accounting reads. Replaced in tests so a drain can be measured without waiting it out. */
export interface DrainClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_CLOCK: DrainClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Splits a PCM payload into transport-sized frames.
 *
 * Handing a whole vendor chunk to the source as ONE frame works right up until the vendor sends a
 * big one, and then it fails in a way that reads as anything but a size problem: the source
 * rejects the frame with a bare `InvalidState`, the chunk is dropped, and - because the source
 * counts a frame's duration against its queue before it tries to capture it - the queue is left
 * carrying seconds of audio that never played. Every later frame in the turn then fails too, so
 * one oversized buffer silences the rest of the sentence.
 *
 * Measured on this path: chunks of 15,732 to 77,461 samples, the largest 4.8 seconds of speech in
 * a single frame, driving the queue to nineteen seconds. Amazon Polly never showed it because the
 * sentence splitter hands over small pieces; ElevenLabs streams in bursts.
 */
export function* pcmToAudioFrames(audioData: Buffer, sampleRate: number): Generator<AudioFrame> {
  const perFrame = Math.max(1, Math.floor((sampleRate * CAPTURE_FRAME_MS) / 1000));
  const total = Math.floor(audioData.byteLength / 2);

  for (let offset = 0; offset < total; offset += perFrame) {
    const count = Math.min(perFrame, total - offset);
    const samples = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = audioData.readInt16LE((offset + i) * 2);
    }
    yield new AudioFrame(samples, sampleRate, 1, count);
  }
}

/**
 * LiveKit-backed implementation of {@link IClientConnection}.
 *
 * Each instance represents one call session inside a LiveKit room. Agent audio is published to
 * the room through a single {@link AudioSource}; user audio is fed in by the channel host from
 * the remote participant's track.
 *
 * LiveKit has no equivalent of Twilio's `clear` / `mark` round trip, so the two behaviours that
 * mechanism provided are rebuilt on the audio source itself:
 * - **Barge-in** is `AudioSource.clearQueue()`, which drops every frame not yet played.
 * - **Turn end** is `AudioSource.waitForPlayout()`, which resolves once the queue has drained.
 *   This is strictly better than the Twilio mark echo, because it is local state rather than a
 *   network round trip through the carrier.
 *
 * Outbound CAL messages are handled as follows:
 * - `start_ai_generation_output`: clears the queue so a barge-in turn does not play stale audio.
 *   When `flushBuffer` is explicitly `false` (filler delivery on non-barge-in turns) the clear is
 *   skipped, matching the Twilio channel's behaviour.
 * - `abort_ai_generation_output`: clears the queue immediately on user barge-in.
 * - `send_ai_voice_chunk`: converts the PCM payload to an {@link AudioFrame} and captures it.
 *   `captureFrame` paces to real time, which applies natural backpressure to the TTS stream.
 *   Non-PCM chunks are logged and dropped.
 * - `end_ai_generation_output`: waits for playout, then opens the next user input turn.
 * - All other message types are silently dropped (voice-only channel).
 */
export class LiveKitConnection implements IClientConnection {
  readonly connectionType = 'livekit' as const;

  private session: Session | null = null;
  /**
   * Incremented whenever the queue is cleared. A pending playout wait compares the generation it
   * captured against this value and stays silent if it changed, so an aborted turn can never open
   * the next input turn late.
   */
  private generation = 0;
  private closed = false;
  /** True while the agent's voice is withheld from the room. See {@link setMuted}. */
  private muted = false;
  /** True from the first chunk of a turn until its audio has finished playing out. */
  private speaking = false;
  /** True once the agent has completed at least one turn - normally the greeting. */
  private hasSpoken = false;

  /**
   * Audio captured into the source since the current turn's first frame, in milliseconds, and
   * the wall-clock at which that first frame went in. Together they say how much of the turn
   * can possibly have played: the source paces to real time, so what has played is bounded by
   * elapsed wall-clock, and the difference is what is still to come.
   */
  private pushedMs = 0;
  private firstCaptureAt = 0;
  /**
   * Chunk loops still handing frames to the source. `waitForPlayout` sees the source's queue and
   * nothing else, so between one frame and the next the queue can read empty while a loop still
   * holds seconds of a sentence. A drain has to wait for these first.
   */
  private inFlightChunks = 0;
  private inFlightWaiters: Array<() => void> = [];

  /**
   * Whether it is safe to write non-conversational audio into this connection right now.
   *
   * False while the agent is mid-turn, and false before it has said anything at all. Both
   * matter: ringback and the agent share one audio source, so anything written while a turn is
   * in flight competes with it for the same queue - and the greeting arrived SECOND on a real
   * call, because the tone had already started filling the source before start_conversation
   * produced a word.
   */
  get canPlayFiller(): boolean {
    return !this.speaking && this.hasSpoken && !this.closed;
  }

  constructor(
    /** The connected LiveKit room for this call. */
    private readonly room: Room,
    /** The published audio source carrying agent speech into the room. */
    private readonly audioSource: AudioSource,
    private readonly sessionManager: SessionManager,
    /** Called once buffered agent audio has finished playing, to open the next user input turn. */
    private readonly onAiTurnEnd: () => Promise<void>,
    /**
     * Called for every conversation event the runner emits.
     *
     * The runner forwards all of them here - classifications, stage jumps, transformations - and
     * the channel watches for the ones that mean something to a phone call. A stage change is how
     * the conversation tells the channel to do something it cannot do itself, like dial.
     */
    private readonly onConversationEvent?: (eventType: string, eventData: Record<string, unknown>) => void,
    /**
     * Called the moment the caller starts talking over the agent.
     *
     * Ordinary agent speech needs nothing here - barge-in already flushes the queue. This exists
     * for audio the CHANNEL is playing rather than the runner, which the runner therefore cannot
     * stop: a recording keeps going until something tells it not to, and a caller talking over a
     * recording that will not stop is worse than never playing one.
     */
    private readonly onUserInterrupt?: () => void,
    /** Injected for tests; the default is the real clock. Drives the playout accounting. */
    private readonly clock: DrainClock = REAL_CLOCK,
  ) {}

  /**
   * The audio source carrying this agent's voice into the room.
   *
   * Exposed so the channel can write non-conversational audio to the caller - ringback while a
   * second line is being tried - without opening a second track. It is the same source the agent
   * speaks through, so anything the agent says naturally takes over from it.
   */
  get outboundSource(): AudioSource {
    return this.audioSource;
  }

  /**
   * Attaches the session record to this connection instance.
   * Must be called immediately after {@link SessionManager.registerSession}.
   * @param session - The session to attach.
   */
  attachSession(session: Session): void {
    this.session = session;
  }

  /**
   * Sends a CAL output message toward the LiveKit room.
   * @param msg - The CAL output message to transmit.
   */
  async sendMessage(msg: CALOutputMessage): Promise<void> {
    if (this.closed) return;

    switch (msg.type) {
      case 'start_ai_generation_output': {
        if (msg.flushBuffer !== false) this.flush();
        this.lastFrameAt = 0;
        this.worstGapMs = 0;
        // A filler turn (flushBuffer false) continues into the reply, so its audio counts toward
        // the same turn; only a fresh turn restarts the accounting.
        if (msg.flushBuffer !== false) {
          this.pushedMs = 0;
          this.firstCaptureAt = 0;
        }
        break;
      }
      case 'abort_ai_generation_output': {
        this.flush();
        this.onUserInterrupt?.();
        break;
      }
      // Not otherwise handled here - there is no UI to notify - but it is the earliest signal
      // that the caller has started talking, which is what stops a recording playing over them.
      case 'user_speaking_started': {
        this.onUserInterrupt?.();
        break;
      }
      case 'send_ai_voice_chunk': {
        // Dropped rather than queued: the point of muting is that nothing generated while the
        // room belongs to someone else plays out when it is handed back.
        if (this.muted) return;
        this.speaking = true;
        if (!isPcmFormat(msg.audioFormat)) {
          logger.warn({ audioFormat: msg.audioFormat, sessionId: this.session?.id }, 'LiveKit: received non-PCM audio chunk, dropping');
          return;
        }
        // Captured in transport-sized pieces rather than as one buffer - see pcmToAudioFrames.
        // The generation is re-checked between frames so a barge-in still cuts the agent off
        // mid-sentence: the whole point of flushing is that what was already generated does not
        // keep playing, and a loop that ignored it would reintroduce exactly that.
        const generation = this.generation;
        this.inFlightChunks += 1;
        try {
          for (const frame of pcmToAudioFrames(msg.audioData, pcmSampleRate(msg.audioFormat))) {
            if (this.muted || this.generation !== generation) break;
            await this.waitForQueueRoom(generation);
            if (this.muted || this.generation !== generation) break;
            this.noteFrameTiming();
            if (this.firstCaptureAt === 0) this.firstCaptureAt = this.clock.now();
            await this.audioSource.captureFrame(frame);
            this.pushedMs += (frame.samplesPerChannel * 1000) / frame.sampleRate;
          }
        } catch (error) {
          // The facts that distinguish the causes, because the FFI error text does not: an
          // InvalidState from the Rust side covers a closed source, a rate or channel mismatch
          // and an over-large frame alike. A dropped chunk is audible, so this is worth knowing
          // precisely rather than by elimination - it is how the oversized-frame cause was found.
          logger.warn({
            error,
            sessionId: this.session?.id,
            chunkBytes: msg.audioData.byteLength,
            declaredFormat: msg.audioFormat,
            queuedMs: this.audioSource.queuedDuration,
            muted: this.muted,
          }, 'LiveKit: captureFrame failed, dropping the rest of this chunk');
        } finally {
          this.inFlightChunks -= 1;
          if (this.inFlightChunks === 0) {
            const waiters = this.inFlightWaiters;
            this.inFlightWaiters = [];
            for (const wake of waiters) wake();
          }
        }
        break;
      }
      case 'conversation_event': {
        try {
          this.onConversationEvent?.(msg.eventType, (msg.eventData ?? {}) as Record<string, unknown>);
        } catch (error) {
          logger.warn({ error, eventType: msg.eventType }, 'LiveKit: conversation event handler failed');
        }

        // The runner has ended the conversation. On a phone call that has to mean HANGING UP -
        // there is no window to close and no client to navigate away, so a caller who has said
        // goodbye is otherwise left holding a live line, working out whether they are supposed
        // to hang up on us. One did, twice, and said goodbye a second time in between.
        //
        // Draining first is the whole trick: the goodbye is still in the audio queue at this
        // point, and closing immediately would cut it off mid-word, which is a worse ending than
        // no ending at all.
        if (msg.eventType !== 'conversation_end') break;

        const generation = this.generation;
        this.drainOutbound()
          .then(async (drained) => {
            if (this.closed || generation !== this.generation) return;
            logger.info({ sessionId: this.session?.id, ...drained }, 'LiveKit: conversation ended, hanging up');
            await this.close();
          })
          .catch((error) => logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: could not hang up after the conversation ended'));
        break;
      }
      case 'end_ai_generation_output': {
        // One number per utterance, so continuity is something a test can assert on. WARN when it
        // crosses the threshold because at that point a person can hear it, and a person hearing
        // it before we do is how this measurement came to exist.
        const generation = this.generation;
        this.audioSource.waitForPlayout()
          .then(async () => {
            if (this.closed || generation !== this.generation) return;

            // Reported here rather than when the TEXT stream ended, because at that moment the
            // audio is still arriving and the worst gap has not happened yet - which is why the
            // first version of this measurement silently reported nothing at all.
            //
            // At INFO even when healthy, deliberately: the version before that logged the good
            // case at debug, which the deployed log level drops, so a clean run and a broken
            // instrument looked identical. Both mistakes are the same mistake this measurement
            // exists to catch, made inside the measurement.
            if (this.worstGapMs > 0) {
              const stalled = this.worstGapMs >= STALL_MS;
              logger[stalled ? 'warn' : 'info'](
                { sessionId: this.session?.id, worstGapMs: this.worstGapMs, stalled },
                stalled ? 'LiveKit: agent audio stalled mid-utterance' : 'LiveKit: agent audio continuity',
              );
              this.worstGapMs = 0;
            }

            this.speaking = false;
            this.hasSpoken = true;
            await this.onAiTurnEnd();
          })
          .catch((error) => logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: waitForPlayout failed, next input turn not opened'));
        break;
      }
      default:
        break;
    }
  }

  /**
   * Disconnects from the LiveKit room and unregisters the session.
   *
   * Any audio still queued is dropped rather than played out: the caller has either hung up or the
   * conversation has ended, so draining would only delay teardown.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    logger.info({ sessionId: this.session?.id, room: this.room.name }, 'LiveKit: close() called, leaving room');

    try {
      this.audioSource.clearQueue();
      await this.audioSource.close();
    } catch (error) {
      logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: failed to close audio source');
    }

    try {
      await this.room.disconnect();
    } catch (error) {
      logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: failed to disconnect room');
    }

    if (this.session) {
      await this.sessionManager.unregisterSession(this.session.id);
    }

    logger.info({ sessionId: this.session?.id }, 'LiveKit: close() completed');
  }

  /**
   * Withholds the agent's voice from the room, or gives it back, without ending the call.
   *
   * Used when the conversation stops being the agent's: once two people are bridged, the agent is
   * still a publishing participant - which is what lets it whisper to one side or take the call
   * back later - but nothing it generates belongs in their conversation.
   *
   * Muting both drops what is already queued AND discards chunks that arrive afterwards. Only
   * flushing would not be enough: a greeting whose TTS is still streaming when the call connects
   * would carry on arriving chunk by chunk and play over the top of the person who just picked
   * up. The pending playout wait is invalidated with the flush, so a turn cut off here cannot
   * open a user input turn behind the bridge.
   * @param muted - True to silence the agent, false to give it the room back.
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;

    this.muted = muted;
    logger.info({ sessionId: this.session?.id, muted }, 'LiveKit: agent voice muted state changed');
    if (muted) {
      this.speaking = false;
      this.flush();
    }
  }

  /**
   * Records how long it has been since the last frame was pushed.
   *
   * The reason this exists: a caller reported the voice breaking up on a build whose logs were
   * clean - no dropped chunks, no packet loss, the right number of packets published. Every
   * automated check passed because they all measured whether audio was PRODUCED, and none
   * measured whether it was produced WITHOUT INTERRUPTION. A stall does not lose audio; it
   * delivers all of it, late, in a lump.
   *
   * Tracked per utterance and reported when the utterance ends, so it is one number a test can
   * assert on rather than a shape somebody has to hear.
   */
  /** When the last frame was pushed, and the worst gap seen this utterance. */
  private lastFrameAt = 0;
  private worstGapMs = 0;

  private noteFrameTiming(): void {
    const now = Date.now();
    if (this.lastFrameAt !== 0) {
      const gap = now - this.lastFrameAt;
      if (gap > this.worstGapMs) this.worstGapMs = gap;
    }
    this.lastFrameAt = now;
  }

  /**
   * Waits until everything the agent has said this turn has actually reached the caller's ear.
   *
   * Three waits, in order, each covering something the one before cannot see:
   * 1. Chunk loops still handing frames to the source. The source's queue can read empty
   *    between frames while a loop holds the rest of a sentence.
   * 2. `waitForPlayout`, the source's own queue draining.
   * 3. The remainder implied by the accounting - audio captured minus wall-clock elapsed since
   *    the first frame - plus PSTN_TAIL_MS for what sits in flight past the source.
   *
   * Bounded by DRAIN_BOUND_MS in total, so a fault here is a late hang-up and never a line left
   * open with nobody on it. Abandons early, without the tail, if the turn is superseded: a
   * barge-in has already flushed whatever this was waiting for.
   *
   */
  async drainOutbound(): Promise<{ pushedMs: number; elapsedMs: number; waitedMs: number; boundHit: boolean }> {
    const clock = this.clock;
    const generation = this.generation;
    const startedAt = clock.now();
    const deadline = startedAt + DRAIN_BOUND_MS;
    let boundHit = false;

    // 1. Loops still pushing.
    while (this.inFlightChunks > 0 && this.generation === generation && !this.closed) {
      if (clock.now() >= deadline) { boundHit = true; break; }
      await Promise.race([
        new Promise<void>((resolve) => this.inFlightWaiters.push(resolve)),
        clock.sleep(Math.max(1, Math.min(CAPTURE_FRAME_MS * 5, deadline - clock.now()))),
      ]);
    }

    // 2. The source's own queue. Polled against the deadline rather than raced against one long
    //    sleep, so a playout that finishes first leaves no stray timer behind to flip the bound.
    if (!boundHit && this.generation === generation && !this.closed) {
      let playoutDone = false;
      const playout = this.audioSource.waitForPlayout().then(
        () => { playoutDone = true; },
        (error) => {
          logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: waitForPlayout failed during drain');
          playoutDone = true;
        },
      );
      while (!playoutDone && this.generation === generation && !this.closed) {
        if (clock.now() >= deadline) { boundHit = true; break; }
        await Promise.race([playout, clock.sleep(Math.max(1, Math.min(CAPTURE_FRAME_MS * 5, deadline - clock.now())))]);
      }
    }

    // 3. What the accounting says has not had time to play, plus the carrier's share.
    const elapsedMs = this.firstCaptureAt === 0 ? 0 : clock.now() - this.firstCaptureAt;
    const pushedMs = Math.round(this.pushedMs);
    if (!boundHit && this.generation === generation && !this.closed) {
      const remainingMs = Math.max(0, pushedMs - elapsedMs) + PSTN_TAIL_MS;
      const allowedMs = Math.max(0, deadline - clock.now());
      if (remainingMs > allowedMs) boundHit = true;
      await clock.sleep(Math.min(remainingMs, allowedMs));
    }

    return { pushedMs, elapsedMs: Math.round(elapsedMs), waitedMs: Math.round(clock.now() - startedAt), boundHit };
  }

  /**
   * Waits until the source has room for another frame.
   *
   * Abandoned the moment the turn is superseded, so backpressure can never delay a barge-in: a
   * caller who interrupts must be heard immediately, and a loop that finished draining first
   * would hold the floor for exactly as long as the audio it was told to stop playing.
   */
  private async waitForQueueRoom(generation: number): Promise<void> {
    while (this.audioSource.queuedDuration > QUEUE_HIGH_WATER_MS) {
      if (this.muted || this.generation !== generation) return;
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_FRAME_MS));
    }
  }

  /**
   * Drops every queued frame and invalidates any pending playout wait.
   */
  private flush(): void {
    this.generation++;
    try {
      this.audioSource.clearQueue();
    } catch (error) {
      logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: clearQueue failed');
    }
  }

  /**
   * Converts a PCM payload into a frame this connection can capture.
   * @param audioData - Raw PCM16LE bytes.
   * @param sampleRate - Sample rate the payload was produced at.
   */
  private toAudioFrame(audioData: Buffer, sampleRate: number): AudioFrame | null {
    return pcmToAudioFrame(audioData, sampleRate);
  }
}
