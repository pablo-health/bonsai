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

  constructor(
    /** The connected LiveKit room for this call. */
    private readonly room: Room,
    /** The published audio source carrying agent speech into the room. */
    private readonly audioSource: AudioSource,
    private readonly sessionManager: SessionManager,
    /** Called once buffered agent audio has finished playing, to open the next user input turn. */
    private readonly onAiTurnEnd: () => Promise<void>,
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
        break;
      }
      case 'abort_ai_generation_output': {
        this.flush();
        break;
      }
      case 'send_ai_voice_chunk': {
        // Dropped rather than queued: the point of muting is that nothing generated while the
        // room belongs to someone else plays out when it is handed back.
        if (this.muted) return;
        if (!isPcmFormat(msg.audioFormat)) {
          logger.warn({ audioFormat: msg.audioFormat, sessionId: this.session?.id }, 'LiveKit: received non-PCM audio chunk, dropping');
          return;
        }
        const frame = this.toAudioFrame(msg.audioData, pcmSampleRate(msg.audioFormat));
        if (!frame) return;
        try {
          await this.audioSource.captureFrame(frame);
        } catch (error) {
          logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: captureFrame failed, dropping chunk');
        }
        break;
      }
      case 'conversation_event': {
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
        this.audioSource.waitForPlayout()
          .then(async () => {
            if (this.closed || generation !== this.generation) return;
            logger.info({ sessionId: this.session?.id }, 'LiveKit: conversation ended, hanging up');
            await this.close();
          })
          .catch((error) => logger.warn({ error, sessionId: this.session?.id }, 'LiveKit: could not hang up after the conversation ended'));
        break;
      }
      case 'end_ai_generation_output': {
        const generation = this.generation;
        this.audioSource.waitForPlayout()
          .then(async () => {
            if (this.closed || generation !== this.generation) return;
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
    if (muted) this.flush();
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
