import type { AudioFormat } from '../../types/audio';
import type { ErrorCallback, SimpleCallback } from '../../types/callbacks';
import type { GeneratedAudioChunk, ITtsProvider, SpeechGenerationCallback } from '../providers/tts/ITtsProvider';
import { logger } from '../../utils/logger';

/**
 * A rule the agent's spoken output must not break, and what to say instead.
 *
 * Substitution rather than suppression, deliberately: dropping the sentence leaves dead air on a
 * phone call, which reads as a fault and invites the caller to push again. Saying something
 * declines the request out loud and moves on.
 */
type OutputRule = {
  name: string;
  test: RegExp;
  replacement: string;
};

/**
 * Four or more digits in a row, however they are grouped or separated.
 *
 * An output class, not a data-loss check: the agent has no business reading ANY long digit
 * sequence aloud on a screening call, including one it invented. A fabricated card number is
 * still a card number to whoever is recording, and a model that will say a made-up one will say
 * a real one. Times and short counts survive - "at 3pm", "in 2 hours", "for 15 minutes".
 */
const DIGIT_RUN = /(?:\d[\s.\-()]*){4,}/;

/**
 * The same, spelled out. ASR and TTS both round-trip digits as words, so a numeric-only rule is
 * trivially bypassed by a model that writes "four one one two".
 */
const SPELLED_DIGIT_RUN =
  /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){3,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i;

/**
 * Deliberately NOT a rule here: a standalone "yes".
 *
 * The scam it would defend against is harvesting a recorded affirmative and replaying it as
 * authorisation. Kurt's call, and it is the right one: a clipped "yes" is not assent, and an
 * assistant saying it on a recording that plainly shows an assistant screening a call is further
 * from assent still. Meanwhile a hard gate on affirmatives mangles legitimate speech on the
 * known-caller path, where "Yes, he is free Thursday" is exactly what should be said.
 *
 * The prompt still instructs the agent not to agree to anything. That is the appropriate strength
 * of control for a risk this size. The control that actually matters is that a caller can never
 * reach the operator at all - see ProtectedProfileFields.
 */

const RULES: OutputRule[] = [
  {
    name: 'digits',
    test: DIGIT_RUN,
    replacement: "I'm not able to give out numbers on this call.",
  },
  {
    name: 'digits-spelled',
    test: SPELLED_DIGIT_RUN,
    replacement: "I'm not able to give out numbers on this call.",
  },
];

/** What the guard did to one sentence, for logging and for the call record. */
export type GuardViolation = {
  rule: string;
  original: string;
  spoken: string;
};

/**
 * Deterministic gate on everything the agent says out loud.
 *
 * Scoped tightly on purpose. It holds exactly one rule - never read a long digit sequence aloud -
 * because that rule is exactly expressible as a pattern, and anything exactly expressible should
 * be certain rather than probable. Judgement calls stay in the prompt where they belong.
 *
 * A regex and not a classifier, for the same reason. Bonsai's own guardrails are
 * classifier-driven, which is a second model rather than no model, and "the guard usually fires"
 * is a different thing from a guarantee. The value here is entirely in being unconditional.
 *
 * Text, not audio - which is the whole reason this runtime does not use a speech-to-speech model.
 * A speech-to-speech core emits sound before any text gate could approve it, making enforcement
 * reactive damage control rather than a guarantee.
 */
export class VoiceOutputGuard {
  private readonly violations: GuardViolation[] = [];

  /**
   * Screens one complete sentence, returning what should be spoken in its place.
   * @param sentence - A complete sentence of agent output.
   */
  screen(sentence: string): string {
    if (!sentence.trim()) return sentence;

    for (const rule of RULES) {
      if (!rule.test.test(sentence)) continue;

      this.record(rule.name, sentence, rule.replacement);
      return rule.replacement;
    }

    return sentence;
  }

  /** Everything the guard changed this session. */
  getViolations(): GuardViolation[] {
    return [...this.violations];
  }

  private record(rule: string, original: string, spoken: string): void {
    this.violations.push({ rule, original, spoken });
    logger.warn({ rule, original: original.slice(0, 200) }, 'VoiceOutputGuard: blocked agent output');
  }
}

/**
 * Wraps a TTS provider so nothing reaches synthesis without passing {@link VoiceOutputGuard}.
 *
 * Wrapping the provider rather than gating at each call site is what makes this a control instead
 * of a convention: the runner streams text to TTS from several places, and a check bolted onto
 * some of them is a check that a future call site quietly bypasses. There is one door.
 *
 * Text is buffered to sentence boundaries before screening, because it arrives in model-sized
 * fragments and a digit run may straddle two of them. For a provider that already accumulates until
 * `end()` - Amazon Polly, as configured here - that buffering costs nothing.
 */
export class GuardedTtsProvider implements ITtsProvider {
  private buffer = '';

  constructor(
    private readonly inner: ITtsProvider,
    private readonly guard: VoiceOutputGuard,
  ) {}

  async sendText(text: string): Promise<void> {
    this.buffer += text;

    // Flush only complete sentences; the tail waits for more text or for end().
    const boundary = /[^.!?]*[.!?]+[\s"')\]]*/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    const out: string[] = [];

    while ((match = boundary.exec(this.buffer)) !== null) {
      out.push(this.guard.screen(match[0]));
      consumed = boundary.lastIndex;
    }

    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed);
      await this.inner.sendText(out.join(''));
    }
  }

  async end(): Promise<void> {
    if (this.buffer.trim()) {
      const remainder = this.guard.screen(this.buffer);
      this.buffer = '';
      await this.inner.sendText(remainder);
    } else {
      this.buffer = '';
    }
    await this.inner.end();
  }

  async cancel(): Promise<void> {
    this.buffer = '';
    if (this.inner.cancel) await this.inner.cancel();
  }

  async start(): Promise<void> {
    this.buffer = '';
    await this.inner.start();
  }

  // Everything below is pass-through. The guard has no opinion about formats or callbacks.
  getSupportedFormats(): AudioFormat[] { return this.inner.getSupportedFormats(); }
  getOutputFormat(): AudioFormat { return this.inner.getOutputFormat(); }
  async init(): Promise<void> { await this.inner.init(); }
  setOnGenerationStarted(cb: SimpleCallback): void { this.inner.setOnGenerationStarted(cb); }
  setOnGenerationEnded(cb: SimpleCallback): void { this.inner.setOnGenerationEnded(cb); }
  setOnError(cb: ErrorCallback): void { this.inner.setOnError(cb); }
  setOnSpeechGenerating(cb: SpeechGenerationCallback<GeneratedAudioChunk>): void { this.inner.setOnSpeechGenerating(cb); }
  async cleanup(): Promise<void> { await this.inner.cleanup(); }
}
