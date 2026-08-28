/**
 * The booking intake as a sequence of slots, rather than as a classifier's opinion about whether
 * the call is finished.
 *
 * The demo practice runs its whole intake in ONE stage with one large prompt, and nothing in the
 * system knows that a booking needs a name, a callback number and a time before it can end. On
 * 2026-08-28, in a QUIET room with flawless recognition on every turn, the classifier returned
 * `caller_finished` immediately after the caller spelled their surname: no number, no time, call
 * over. The same failure had been read as a noise problem all evening; the quiet call is the
 * control that shows it was not.
 *
 * Two things follow from modelling it as slots, and the second one is the surprise:
 *
 *   1. A required slot that is empty makes ending the call UNAVAILABLE rather than discouraged.
 *      Stage actions already support a `condition`, and an action whose condition is false is
 *      never enumerated to the classifier - so it cannot be emitted, and there is no guard to
 *      forget. {@link intakeState} is what such a condition reads.
 *
 *   2. Knowing which slot is open tells us what a complete answer LOOKS like, which is the
 *      endpointing signal this system does not have. Silence is the primary turn-end cue today,
 *      and in a loud room silence never arrives. "I asked for ten digits and I am holding ten
 *      digits" needs no silence, no speaker identity and no acoustic quality at all - it is the
 *      same judgement in a concert queue as in a hotel room. See {@link turnLooksComplete}.
 *
 * ACCELERATOR, NOT A GATE. Every deterministic check here can only end a turn sooner or refuse a
 * value that cannot be right. None of them can hold a turn open or block progress: `null` means
 * "no opinion, use the acoustic signal", which is exactly today's behaviour. Four separate bugs in
 * this system were a suppression path with no exit, and a completeness check that could block
 * would be the fifth.
 */
import { z } from 'zod';

/**
 * What kind of answer a slot expects. This is the whole reason the module exists: `phone` and
 * `spelling` are exactly expressible, so they are checked rather than hoped for, and they are
 * also precisely what a noisy line damages most.
 */
export const slotKindSchema = z.enum(['text', 'name', 'spelling', 'phone', 'datetime', 'yes_no']);
export type SlotKind = z.infer<typeof slotKindSchema>;

export const slotDefinitionSchema = z.object({
  /** Stage variable this slot fills. */
  name: z.string().min(1),
  kind: slotKindSchema,
  /** A required slot that is empty blocks the end of the call. */
  required: z.boolean().default(true),
  /** How the agent should refer to this slot when it asks for it, in plain words. */
  asks: z.string().min(1),
  /**
   * Attempts before the slot stops being asked for. Spending more than this on one field is the
   * failure that ends calls: the budget is the caller's patience, not the recogniser's accuracy.
   */
  maxAttempts: z.number().int().positive().default(3),
});
export type SlotDefinition = z.infer<typeof slotDefinitionSchema>;

export const intakeDefinitionSchema = z.object({ slots: z.array(slotDefinitionSchema).min(1) });
export type IntakeDefinition = z.infer<typeof intakeDefinitionSchema>;

/** Suffix of the companion variable counting attempts spent on a slot. */
export const ATTEMPTS_SUFFIX = '__attempts';
/**
 * Suffix of the companion variable marking a slot as parked.
 *
 * A required slot must be fillable-or-parked, never silently filled wrong. On 2026-08-27 there
 * was no way to park one: to see whether the rest of the flow worked, a wrong name had to be
 * allowed into the record. Parking is the same mechanism as the provisional-booking-plus-text
 * path, and it is what makes the flow testable end to end without corrupting anything.
 */
export const DEFERRED_SUFFIX = '__deferred';

/** Reads an intake definition off stage metadata. Absent or malformed means "no sequence here". */
export function parseIntakeDefinition(metadata: unknown): IntakeDefinition | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).intake;
  if (!raw) return null;
  const parsed = intakeDefinitionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Placeholders the ASR layer writes when it heard nothing usable. These are not answers, and
 * every one of them has reached a slot on a real call: `[silence]` three turns running while the
 * caller was plainly speaking his name.
 */
const NON_ANSWERS = new Set(['[silence]', '[unclear]', '[unintelligible]', '[inaudible]', '[noise]']);

/**
 * The outcome of checking one value against its slot.
 *
 * A flat shape rather than a discriminated union on purpose: this project compiles with
 * `strict: false`, which widens the literal `true`/`false` and leaves a union unnarrowable at
 * every call site. `value` is set when `ok`; `reason` when not, and it is for the record rather
 * than for the caller - nothing here is ever read out loud.
 */
export type SlotValidation = { ok: boolean; value?: string; reason?: string };

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|correct|right|please|absolutely|definitely|certainly|uh huh|mhm|that'?s right|go ahead|sounds good)\b/i;
const NEGATIVE = /\b(no|nope|nah|negative|don'?t|do not|not really|rather not|incorrect|wrong)\b/i;

/**
 * Expands the way people actually spell things out loud into the letters they mean.
 *
 * "N as in Nancy, I, E, M as in Mary, I" is NIEMI, not a person called Nancy. Callers do this
 * unprompted, the agent is instructed to read spellings back this way, and the words arrive in the
 * transcript as words. Any word can follow "as in"; it is never part of the name.
 *
 * The NATO alphabet is accepted bare for the same reason it is used on the way out: single letters
 * are close to the worst input a narrowband line can carry - N and M are both nasals and most of
 * what separates them lives above 3400 Hz - whereas "November" and "Mike" differ across a whole
 * word. That is why NATO on the way IN is the channel that carries enough information, and not a
 * politeness.
 */
const NATO: Record<string, string> = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F',
  golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L',
  mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S',
  tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', xray: 'X', 'x-ray': 'X',
  yankee: 'Y', zulu: 'Z',
};

/**
 * Reads a spoken spelling as the letters it names, or explains why it could not.
 *
 * @param raw - The transcript of the spelling turn.
 * @returns The letters in order, uppercased, with no separators.
 */
export function parseSpelling(raw: string): SlotValidation {
  // "M as in Mary" and "M for Mary" both mean M. Drop the anchor before anything else looks at it.
  const withoutAnchors = raw.replace(/\b([a-z])\s+(?:as in|for|like)\s+[a-z]+/gi, ' $1 ');
  const tokens = withoutAnchors.split(/[\s,.\-]+/).map(t => t.trim()).filter(Boolean);

  const letters: string[] = [];
  for (const token of tokens) {
    const word = token.toLowerCase().replace(/[^a-z-]/g, '');
    if (!word) continue;
    if (word.length === 1) { letters.push(word.toUpperCase()); continue; }
    if (NATO[word]) { letters.push(NATO[word]); continue; }
    // Filler around a spelling is ordinary speech and not a failure to spell.
    if (['its', 'it', 'is', 'the', 'uh', 'um', 'so', 'and', 'then', 'that', 'okay', 'ok', 'yes', 'sure', 'spelled', 'spelt', 'spell'].includes(word)) continue;
    return { ok: false, reason: `not a spelling: ${token}` };
  }

  if (letters.length < 2) return { ok: false, reason: 'too few letters to be a spelling' };
  return { ok: true, value: letters.join('') };
}

/** Number words as people read a phone number aloud, including the "oh" nobody writes as zero. */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', oh: '0', o: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

/** Compounds, because "forty-two oh one" is how the second half of a number usually arrives. */
const TEEN_WORDS: Record<string, string> = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
};
const TENS_WORDS: Record<string, string> = {
  twenty: '2', thirty: '3', forty: '4', fourty: '4', fifty: '5',
  sixty: '6', seventy: '7', eighty: '8', ninety: '9',
};

/**
 * Reads a spoken number as the digits it names.
 *
 * The count is the only check that catches a dropped area code, and it cannot count what arrives
 * as "four oh four". Transcribe returns number words as words far more often than not, so a
 * digits-only strip silently turns a correct ten-digit number into a seven-digit one and asks the
 * caller to repeat something they already said correctly - the exact loop that burned a minute and
 * a half of a real call.
 *
 * Anything that is not a number word is skipped rather than rejected: "my number is", "it's",
 * "area code" all appear in front of real numbers.
 */
export function spokenDigitsToDigits(raw: string): string {
  const tokens = raw.toLowerCase().split(/[\s,.\-]+/).map(t => t.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  let out = '';
  let repeat = 1;

  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];

    if (/^\d+$/.test(word)) { out += word.repeat(repeat); repeat = 1; continue; }
    if (word === 'double') { repeat = 2; continue; }
    if (word === 'triple') { repeat = 3; continue; }
    if (DIGIT_WORDS[word]) { out += DIGIT_WORDS[word].repeat(repeat); repeat = 1; continue; }
    if (TEEN_WORDS[word]) { out += TEEN_WORDS[word]; repeat = 1; continue; }

    // "forty two" is one number spoken as two words, and "forty" alone is 40. Both mean the tens
    // digit is only ever emitted once the following token has been looked at - reading them
    // independently turns "forty two" into 4-0-2 and quietly adds a digit that was never said.
    const glued = word.match(/^(twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)(one|two|three|four|five|six|seven|eight|nine)?$/);
    const tens = glued ? TENS_WORDS[glued[1]] : undefined;
    if (tens) {
      const next = tokens[i + 1];
      const unit = next && DIGIT_WORDS[next] && next !== 'oh' && next !== 'o' ? DIGIT_WORDS[next] : null;
      // "fortytwo" also survives the hyphen strip as a single token.
      if (glued && glued[2]) { out += tens + DIGIT_WORDS[glued[2]]; }
      else if (unit) { out += tens + unit; i++; }
      else { out += tens + '0'; }
      repeat = 1;
      continue;
    }

    repeat = 1;
  }

  return out;
}

/**
 * Reads a spoken phone number as ten NANP digits, or refuses it.
 *
 * THE COUNT IS THE CHECK. A readback only invites the caller to agree with what it says, and on a
 * noisy line "yes" is the cheapest thing a caller can produce - this line has already read back
 * "4-7-5-4-4-2-0-1", been told yes, and left the practice with no way to reach anyone. A number
 * that cannot exist must never reach a readback.
 */
export function parsePhone(raw: string): SlotValidation {
  let digits = spokenDigitsToDigits(raw);
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10) return { ok: false, reason: `${digits.length} digits, not 10` };
  // NANP: neither the area code nor the exchange may begin with 0 or 1, so a number that starts
  // that way is a mishearing rather than a number, however confident the recogniser was.
  if (/^[01]/.test(digits) || /^[01]/.test(digits.slice(3))) return { ok: false, reason: 'not a valid NANP number' };
  return { ok: true, value: digits };
}

/**
 * Checks a value against what its slot expects, before it is written anywhere.
 *
 * Where a kind is not exactly expressible - a name, a free-text answer - this only refuses what
 * cannot be an answer at all. It never second-guesses a plausible one.
 */
export function validateSlotValue(kind: SlotKind, raw: unknown): SlotValidation {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' };
  const text = String(raw).trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (NON_ANSWERS.has(text.toLowerCase())) return { ok: false, reason: 'ASR placeholder, not an answer' };

  switch (kind) {
    case 'phone': return parsePhone(text);
    case 'spelling': return parseSpelling(text);
    case 'yes_no': {
      if (AFFIRMATIVE.test(text)) return { ok: true, value: 'yes' };
      if (NEGATIVE.test(text)) return { ok: true, value: 'no' };
      return { ok: false, reason: 'neither affirmative nor negative' };
    }
    case 'name':
      // A name is whatever the caller says it is. The only thing worth refusing is a transcript
      // that is plainly not one - punctuation, digits, or a sentence.
      if (!/[a-z]/i.test(text)) return { ok: false, reason: 'no letters' };
      if (/\d/.test(text)) return { ok: false, reason: 'digits in a name' };
      return { ok: true, value: text };
    case 'datetime':
    case 'text':
    default:
      return { ok: true, value: text };
  }
}

/** A slot and everything the rest of the system needs to know about its state. */
export type SlotState = {
  slot: SlotDefinition;
  value: string | null;
  attempts: number;
  deferred: boolean;
};

export type IntakeState = {
  /** True when every required slot is either filled or deliberately parked. */
  complete: boolean;
  /** The slot being collected now: the first required one that is neither filled nor parked. */
  current: SlotDefinition | null;
  /** Required slots still outstanding, in order. */
  remaining: SlotDefinition[];
  /** Filled slots, by name, for the prompt to refer to without re-asking. */
  filled: Record<string, string>;
  /**
   * How many slots are filled.
   *
   * Exists for the prompt rather than for the logic: Handlebars treats an empty object as truthy,
   * so `{{#if intake.filled}}` would print "already taken: {}" on the first turn of every call and
   * invite the model to reason about it. A number can be compared.
   */
  filledCount: number;
  /** Slots parked after their attempts ran out; these need a text confirmation, not another ask. */
  deferred: string[];
};

/**
 * Computes where the intake has got to from the stage variables alone.
 *
 * Deliberately a pure function of the variables: it is read by the prompt, by action conditions
 * and by the turn-taking loop, and all three must agree without any of them holding state.
 */
export function intakeState(def: IntakeDefinition, vars: Record<string, unknown>): IntakeState {
  const filled: Record<string, string> = {};
  const deferred: string[] = [];
  const remaining: SlotDefinition[] = [];

  for (const slot of def.slots) {
    const raw = vars[slot.name];
    const isDeferred = Boolean(vars[`${slot.name}${DEFERRED_SUFFIX}`]);
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      filled[slot.name] = String(raw);
      continue;
    }
    if (isDeferred) { deferred.push(slot.name); continue; }
    if (slot.required) remaining.push(slot);
  }

  return {
    complete: remaining.length === 0,
    current: remaining[0] ?? null,
    remaining,
    filled,
    filledCount: Object.keys(filled).length,
    deferred,
  };
}

/**
 * Whether the answer in hand already completes the turn, given what was asked for.
 *
 * Returns `null` for "no opinion", which must be read as "fall back to the acoustic and temporal
 * signals" - today's behaviour, unchanged. There are many ways to say yes, a matcher will always
 * miss some, and a missed "I guess so" has to cost nothing worse than the status quo.
 *
 * The useful coincidence: the kinds this is CERTAIN about - digits, spellings - are precisely the
 * ones noise damages most, and the kind it is weakest on - yes or no - is the one the recogniser
 * handles best anyway, being short and common. The check is strong exactly where the acoustics
 * are weak.
 *
 * @param kind - What the open slot expects, or null when the turn was an open question.
 * @param text - The transcript so far for this turn.
 */
export function turnLooksComplete(kind: SlotKind | null, text: string): boolean | null {
  if (!kind) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  switch (kind) {
    case 'phone': return parsePhone(trimmed).ok ? true : null;
    case 'spelling': return parseSpelling(trimmed).ok ? true : null;
    case 'yes_no': return AFFIRMATIVE.test(trimmed) || NEGATIVE.test(trimmed) ? true : null;
    default: return null;
  }
}
