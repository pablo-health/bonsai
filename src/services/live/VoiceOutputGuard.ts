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
  /** When true, the sentence is allowed if every digit run in it was spoken by the caller. */
  allowCallerEcho?: boolean;
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

/**
 * The agent asking for a number it can reach the caller on.
 *
 * Matched against the agent's OWN output, which is the trick that makes this need no wiring: the
 * guard already sees every sentence before it is spoken, so it can notice its own question and
 * does not have to be told what stage the conversation is in.
 *
 * Deliberately narrow. "Is it alright to leave a message on that number?" mentions a number and
 * is not a request for one, and matching it would arm the length check over a stretch of the call
 * where no number is coming.
 */
const PHONE_ASK =
  /\b(?:(?:phone|contact|callback|call-back|cell|mobile|best|good)\s+number|number\s+(?:to|that|we\s+can|I\s+can|where\s+we\s+can)\s+(?:reach|call|contact))\b/i;

/**
 * Said instead of reading back a number that cannot be a number.
 *
 * A retry, not a refusal: the caller has done nothing wrong and the call should continue. Naming
 * the area code is deliberate - it is the part that goes missing, because it is spoken first and
 * a line that has just been noisy loses the beginning of an utterance rather than the end.
 */
const PHONE_RETRY =
  "Sorry - I only caught part of that number. Could you give me the whole thing, starting with the area code?";

/**
 * A North American number as a caller would say one: ten digits, or eleven with a leading 1.
 *
 * The area code and the exchange may not begin with 0 or 1 - that is the numbering plan, not a
 * heuristic, and a number that breaks it cannot be dialled. Everything else is left alone: this
 * exists to catch a number with digits MISSING, which is the failure that actually happened, and
 * a stricter rule would start rejecting real numbers to catch nothing.
 */
function isPlausibleNanp(run: string): boolean {
  const digits = run.length === 11 && run.startsWith('1') ? run.slice(1) : run;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(digits);
}

const RULES: OutputRule[] = [
  {
    name: 'digits',
    test: DIGIT_RUN,
    replacement: "I'm not able to give out numbers on this call.",
    allowCallerEcho: true,
  },
  {
    name: 'digits-spelled',
    test: SPELLED_DIGIT_RUN,
    replacement: "I'm not able to give out numbers on this call.",
    allowCallerEcho: true,
  },
];

/** Number words to digits, so a run written either way normalises to the same string. */
const WORD_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

/**
 * Every long digit run in a piece of text, each reduced to bare digits.
 *
 * Grouping and spelling are noise here: a number read back as "555-0182", "555 0182" or
 * "five five five oh one eight two" is the same number, and a comparison that treats them as
 * different would defeat the echo exemption exactly when a caller speaks naturally.
 */
function digitRuns(text: string): string[] {
  const normalised = text
    .toLowerCase()
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => WORD_DIGITS[w]);
  // Commas count as separators HERE but not in DIGIT_RUN, and the asymmetry is deliberate. For
  // detection a comma-tolerant pattern would swallow "in 2024, 15 minutes" as one long run and
  // refuse a perfectly ordinary sentence. For comparison the opposite is true: a caller reading
  // a number aloud is transcribed with commas in it, and splitting there makes their own number
  // look like two shorter ones that match nothing.
  return (normalised.match(/(?:\d[\s.,\-()]*){4,}/g) ?? []).map((run) => run.replace(/\D/g, ''));
}

/** What the guard did to one sentence, for logging and for the call record. */
export type GuardViolation = {
  rule: string;
  original: string;
  spoken: string;
};

/**
 * Deterministic gate on everything the agent says out loud.
 *
 * Scoped tightly on purpose. It holds exactly one rule - never say a long digit sequence the
 * caller did not say first - because that rule is exactly expressible as a pattern, and anything
 * exactly expressible should be certain rather than probable. Judgement calls stay in the prompt
 * where they belong.
 *
 * The echo exemption is what makes the rule usable on a line that takes messages rather than
 * screens them. Without it the guard is not merely strict, it is wrong: it fires on the single
 * most important sentence a reception line says, the one reading a caller's number back to check
 * it, and substitutes a refusal that sounds like a policy the practice chose.
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
  /** Digit runs the CALLER has spoken this conversation, normalised to bare digits. */
  private readonly callerDigits = new Set<string>();
  /**
   * True once the agent has asked for a callback number, until a usable one is read back.
   *
   * This is the "are we in the part of the call where a number is expected" question, answered
   * from the agent's own speech rather than from conversation state the guard would otherwise
   * have to be handed and kept in step with.
   */
  private awaitingPhoneNumber = false;
  /** Digit runs the operator wrote into the agent's own script, normalised the same way. */
  private readonly scriptedDigits = new Set<string>();

  /**
   * Records what the caller said, so the guard can tell an echo from a disclosure.
   *
   * Called for each finalised caller turn. Only digit runs are kept - the guard has no use for
   * the rest of the sentence, and not keeping it means the guard never becomes a second copy of
   * the transcript.
   */
  noteCallerSpeech(text: string): void {
    // Bounded: a long call should not let the set grow without limit, and a caller who has
    // recited sixty-four distinct numbers is not the case this exemption exists for.
    for (const run of digitRuns(text)) {
      if (this.callerDigits.size >= 64) return;
      this.callerDigits.add(run);
    }
  }

  /**
   * Records digit runs the operator deliberately put in the agent's own prompt.
   *
   * The rule is "never say a number nobody gave you", and a number written into the script by the
   * person who configured the agent was given to it. Without this the guard has a blind spot in
   * the shape of an agent that is a CALLER rather than a receptionist: it has a number of its own
   * to hand over, there is no earlier caller turn to echo, and so the one sentence it exists to
   * say gets replaced by a refusal it never chose. Found by a synthetic patient reciting her
   * callback number three times while the practice kept asking for it.
   *
   * Nothing loosens for a screening line. A screening prompt contains no long digit runs - if one
   * ever does, that number was put there on purpose and is exactly as sayable as this makes it.
   */
  noteScriptedDigits(text: string): void {
    for (const run of digitRuns(text)) {
      if (this.scriptedDigits.size >= 64) return;
      this.scriptedDigits.add(run);
    }
  }

  /**
   * Screens one complete sentence, returning what should be spoken in its place.
   * @param sentence - A complete sentence of agent output.
   */
  screen(sentence: string): string {
    if (!sentence.trim()) return sentence;

    for (const rule of RULES) {
      if (!rule.test.test(sentence)) continue;
      if (rule.allowCallerEcho && this.isCallerEcho(sentence)) continue;

      this.record(rule.name, sentence, rule.replacement);
      return rule.replacement;
    }

    // A second question, on a different axis from the rules above.
    //
    // Those ask "may this number be said at all", and the echo exemption answers yes for anything
    // the caller said - which is right, and is why an eight-digit number sailed through on
    // 2026-08-27. The caller HAD said it; nobody had asked whether it could be a phone number.
    // This asks that.
    if (this.isImplausiblePhoneReadback(sentence)) {
      this.record('phone-length', sentence, PHONE_RETRY);
      return PHONE_RETRY;
    }

    // Only sentences that survive arm the check, and only after they have been screened - a
    // sentence that was replaced was never said, so it cannot have asked the caller for anything.
    this.noteOwnQuestion(sentence);

    return sentence;
  }

  /** Arms the length check when the agent asks for a number it can call back on. */
  private noteOwnQuestion(sentence: string): void {
    if (PHONE_ASK.test(sentence)) this.awaitingPhoneNumber = true;
  }

  /**
   * True when the agent is about to read back, as a phone number, something that cannot be one.
   *
   * Scoped three ways, because the cost of a false positive here is refusing to repeat a number
   * the caller correctly gave:
   *
   *  - only while a callback number has actually been asked for, so a date of birth or a member
   *    ID read back elsewhere in the call is not held to a phone number's shape;
   *  - only for runs the CALLER spoke, since a run the agent invented is the other rule's
   *    business and has already been dealt with above;
   *  - and never when any run in the sentence is a plausible number, which also disarms the
   *    check - once a usable number has been read back, the call has moved on.
   */
  private isImplausiblePhoneReadback(sentence: string): boolean {
    if (!this.awaitingPhoneNumber) return false;

    const echoed = digitRuns(sentence).filter((run) => this.callerDigits.has(run));
    if (echoed.length === 0) return false;

    if (echoed.some(isPlausibleNanp)) {
      this.awaitingPhoneNumber = false;
      return false;
    }

    return true;
  }

  /**
   * True when every long digit run in the sentence is one the caller themselves spoke.
   *
   * The rule this preserves is "never volunteer or invent a number", not "never say digits". A
   * reception line has to read a callback number back to check it, and refusing to is both
   * useless and conspicuous. Repeating what the caller just said discloses nothing they do not
   * already know, while a number the agent produced from anywhere else - the operator's own
   * details, a fabricated card number - still cannot be spoken.
   *
   * EVERY run must match, so a sentence that pairs the caller's number with an unknown one is
   * still blocked rather than smuggled through on the strength of the half that checks out.
   *
   * A run the operator wrote into the agent's own prompt counts too - see noteScriptedDigits.
   */
  private isCallerEcho(sentence: string): boolean {
    const runs = digitRuns(sentence);
    if (runs.length === 0) return false;
    return runs.every((run) => this.callerDigits.has(run) || this.scriptedDigits.has(run));
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

  /**
   * Speak what is buffered without ending the turn. See ITtsProvider.flushPendingText.
   *
   * This wrapper holds text of its own, screening it before it is spoken, so a flush has to push
   * that through first - flushing only the inner provider would speak the earlier text and leave
   * this one's behind, which is the opposite of what was asked for.
   */
  async flushPendingText(): Promise<void> {
    if (this.buffer.trim()) {
      const remainder = this.guard.screen(this.buffer);
      this.buffer = '';
      await this.inner.sendText(remainder);
    }
    if (this.inner.flushPendingText) await this.inner.flushPendingText();
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
