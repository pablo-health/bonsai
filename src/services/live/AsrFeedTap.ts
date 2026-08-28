/**
 * Records what the recogniser was actually handed, as distinct from what the microphone produced.
 *
 * The recorder taps inbound audio before the ASR does, so `user_voice` is the caller's audio and
 * not the recogniser's input. Every time those two have been assumed identical it has cost a day:
 * replaying `user_voice` offline returns transcripts the live call never got, and on 2026-08-28 a
 * pre-warmed ASR session was silently transcribing the same audio as the turn's session, so the
 * head of every utterance arrived twice. Neither was visible in any recording or log.
 *
 * This closes that gap by capturing the stream at the point it is yielded to Transcribe, including
 * the keepalive silence the provider inserts on its own initiative.
 *
 * PERFORMANCE CONTRACT, and it is not advisory. This sits on a real-time audio path. It may do
 * nothing but push a reference onto an array and increment a number. No serialisation, no I/O, no
 * awaits, no logging - a tap that stalls the generator feeding Transcribe would starve the stream,
 * which is one of the faults it exists to investigate. Everything expensive happens at flush.
 */

/** A moment in a session's life, placed against the audio rather than the wall clock. */
export type AsrSessionMarker = {
  /** e.g. 'start', 'stop', 'stream-open', 'reset-for-new-turn'. */
  event: string;
  /** Bytes of audio fed before this happened - the only timeline that matters for a diff. */
  atByte: number;
  /** Milliseconds since the tap was created, for correlating against logs. */
  atMs: number;
  /** Which ASR session this belongs to. Two live at once is the bug class this exists to see. */
  session: number;
};

export class AsrFeedTap {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private readonly markers: AsrSessionMarker[] = [];
  private readonly startedAt = Date.now();
  private session = 0;

  /** Frames accepted by the provider, and frames it silently refused. */
  private accepted = 0;
  private droppedNotRecognizing = 0;
  private droppedEnded = 0;

  /**
   * A ceiling, because this holds audio in memory for the length of a call. Twenty minutes at
   * 16kHz 16-bit is ~38MB; past the cap the tap stops growing and says so, which is a truthful
   * partial record rather than an out-of-memory kill on a live call.
   */
  constructor(private readonly maxBytes = 40 * 1024 * 1024) {}

  private silenceBytes = 0;

  /**
   * Called with each buffer yielded to the recogniser. Must stay this cheap.
   *
   * @param isKeepaliveSilence - true for the silence the provider inserts on its own to stop
   *   Transcribe closing an idle stream. Counted apart from the caller's audio because otherwise
   *   the totals have to be picked apart by hand afterwards: on the first real call this was
   *   needed, three of the eight seconds fed turned out to be silence, and working that out took
   *   arithmetic and an assumption about frame size that the tap should simply have recorded.
   */
  fed(chunk: Buffer, isKeepaliveSilence = false): void {
    if (this.bytes >= this.maxBytes) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    if (isKeepaliveSilence) this.silenceBytes += chunk.length;
  }

  countAccepted(): void { this.accepted++; }
  countDroppedNotRecognizing(): void { this.droppedNotRecognizing++; }
  countDroppedEnded(): void { this.droppedEnded++; }

  /** Starts a new ASR session. Returns its number so markers can be attributed to it. */
  newSession(): number {
    this.session++;
    this.mark('session-begin');
    return this.session;
  }

  mark(event: string): void {
    if (this.markers.length >= 4096) return;
    this.markers.push({ event, atByte: this.bytes, atMs: Date.now() - this.startedAt, session: this.session });
  }

  /** Everything expensive lives here, and here runs once, after the call. */
  drain(): { audio: Buffer; report: Record<string, unknown> } {
    const audio = Buffer.concat(this.chunks);
    this.chunks = [];
    return {
      audio,
      report: {
        fedBytes: this.bytes,
        fedKeepaliveSilenceBytes: this.silenceBytes,
        fedCallerAudioBytes: this.bytes - this.silenceBytes,
        truncated: this.bytes >= this.maxBytes,
        framesAccepted: this.accepted,
        framesDroppedNotRecognizing: this.droppedNotRecognizing,
        framesDroppedAfterEnded: this.droppedEnded,
        sessions: this.session,
        markers: this.markers,
      },
    };
  }
}
