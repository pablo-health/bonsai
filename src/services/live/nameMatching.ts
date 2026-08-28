/**
 * Resolves a garbled name to a real one by matching on sound, and by knowing which sounds a
 * telephone destroys.
 *
 * WHY NOT A BETTER RECOGNISER. Narrowband telephony is roughly 300-3400 Hz, and the cues that
 * separate many consonants live above that: the burst transient that identifies /k/ is mostly
 * above 3400 Hz, so the codec discards it before any model sees the audio. That is physics, and
 * it is why custom vocabulary was measured on 2026-08-28 and did nothing: with the caller's own
 * name in the vocabulary, "Kurt" still came back "Hertz" at HIGHER confidence, because a
 * vocabulary re-ranks hypotheses the acoustic model already proposed and cannot introduce one the
 * acoustics never generated. Everything here instead reduces what has to be heard.
 *
 * WHY NOT PLAIN METAPHONE. The observed failure is "Niemi" heard as "Ming", and later as "Mimi":
 * the recogniser missed the first letter, N as M. Double Metaphone codes N as N and M as M, so
 * those two names have DIFFERENT keys and an equality match on phonetic keys finds nothing. The
 * error is not that the recogniser produced a different-sounding name; it is that it produced a
 * name differing by exactly one telephone-confusable phoneme.
 *
 * So this is a phonetic key plus a WEIGHTED edit distance, where substituting one sound for
 * another the phone line cannot distinguish is cheap and substituting an unrelated one is not.
 * The confusion classes are not a general phonetic theory - they are the pairs a 300-3400 Hz
 * channel actually merges:
 *
 *   M/N       both nasals, and most of what separates them is out of band. This is the observed
 *             error, and it is why "November" and "Mike" are separable when the bare letters are
 *             not - the discriminating information is spread across a whole word.
 *   B/P D/T   voiced and unvoiced stops at the same place of articulation, separated by voice
 *   G/K       onset time, which is short and easily lost.
 *   F/S/TH    fricatives, whose energy is largely above the band.
 *   S/Z       the same fricative pair, separated only by voicing.
 *   V/B       both labial, and V's frication is out of band.
 *   K/H       not a phonetic pair, but the /k/ burst is out of band, and what remains of an
 *             unreleased /k/ before a vowel is close to aspiration. This is the "Kurt" -> "Hertz"
 *             error, and it is listed as OBSERVED rather than as theory.
 *
 * The output is deliberately a SHORTLIST rather than a winner. Once the candidates are down to
 * two, the right move is to offer the choice - "is that Niemi, N-I-E-M-I, or Mimi, M-I-M-I?" - and
 * a two-way choice survives a noisy line in a way open-vocabulary spelling never will. Asking the
 * caller to spell it again is a lateral move, not an escalation: single letters are close to the
 * worst input a narrowband line can carry, so a re-spell re-samples exactly the information the
 * channel already destroyed.
 */

/**
 * Sounds a telephone band merges, as a map from letter to the class it belongs to.
 *
 * Substitution WITHIN a class is cheap because the channel, not the speaker, is responsible for
 * the confusion. Everything else costs full price.
 */
const CONFUSION_CLASSES: string[][] = [
  ['M', 'N'],
  ['B', 'P'],
  ['D', 'T'],
  ['G', 'K'],
  ['F', 'S', '0'], // '0' is the phonetic key's code for TH
  ['S', 'Z'],
  ['V', 'B'],
  ['K', 'H'],
];

const CONFUSABLE = new Set<string>();
for (const group of CONFUSION_CLASSES) {
  for (const a of group) for (const b of group) if (a !== b) CONFUSABLE.add(`${a}${b}`);
}

/** Cost of replacing one sound with another it is routinely confused with over a phone line. */
const CONFUSABLE_SUBSTITUTION_COST = 0.35;

/**
 * Reduces a name to the sounds a phone line can actually carry.
 *
 * Deliberately coarser than Double Metaphone. Vowels are dropped after the first position, since
 * vowel quality is the first thing a noisy narrowband channel loses and the recogniser's vowel
 * choice carries almost no information about which name was said. Doubled letters collapse.
 *
 * @param name - A name as heard, spelled, or held on a roster.
 */
export function phoneticKey(name: string): string {
  const upper = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (!upper) return '';

  let out = '';
  // Index of the source character that produced the last emitted code, so that a doubled sound is
  // collapsed only when it was ACTUALLY doubled. Collapsing on the emitted string instead turns
  // "Miemi" into "M" - the two Ms are not adjacent in the name, only after the vowels between them
  // have been dropped - and a key that short matches almost anything.
  let lastEmittedFrom = -2;
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i];
    const next = upper[i + 1] ?? '';
    let code: string;

    if (ch === 'T' && next === 'H') { code = '0'; i++; }
    else if (ch === 'P' && next === 'H') { code = 'F'; i++; }
    else if (ch === 'C' && next === 'H') { code = 'X'; i++; }
    else if (ch === 'S' && next === 'H') { code = 'X'; i++; }
    else if (ch === 'C') { code = 'EIY'.includes(next) ? 'S' : 'K'; }
    else if (ch === 'Q') { code = 'K'; }
    else if (ch === 'X') { code = 'KS'; }
    else if (ch === 'W' || ch === 'Y') { code = ''; }
    else if ('AEIOU'.includes(ch)) { code = out === '' ? ch : ''; }
    else { code = ch; }

    // Doubled sounds are one sound; "Niemmi" and "Niemi" must not differ.
    if (code) {
      const isDoubled = out.endsWith(code) && lastEmittedFrom === i - 1;
      if (!isDoubled) { out += code; lastEmittedFrom = i; }
    }
  }
  return out;
}

/**
 * Edit distance between two phonetic keys, discounting substitutions the phone line is responsible
 * for.
 *
 * @returns A cost in units of "one wrong sound", where a telephone-confusable swap is about a
 *   third of one.
 */
export function soundAlikeDistance(a: string, b: string): number {
  const rows = a.length + 1, cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const from = a[i - 1], to = b[j - 1];
      const substitution = from === to ? 0 : CONFUSABLE.has(`${from}${to}`) ? CONFUSABLE_SUBSTITUTION_COST : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + substitution,
      );
    }
  }
  return d[rows - 1][cols - 1];
}

/** A roster name and how well it accounts for what the recogniser produced. */
export type NameCandidate = {
  /** The real name, spelled as the practice holds it. */
  name: string;
  /** Distance in wrong sounds; 0 is an exact phonetic match. */
  distance: number;
  /** Distance normalised by name length, so a long name is not penalised for being long. */
  score: number;
  /** Which of the recogniser's hypotheses produced this match. */
  heard: string;
};

/**
 * Ranks roster names against everything the recogniser offered.
 *
 * TAKES THE WHOLE N-BEST LIST, because `consume()` reading `Alternatives[0]` and throwing the rest
 * away is a decision made before anything downstream knows what the turn is for. The right name is
 * frequently in the n-best when the top hypothesis is wrong, and a name slot is exactly the case
 * where that matters.
 *
 * @param hypotheses - What the recogniser heard, best first. Pass the n-best list, not just the top.
 * @param roster - Candidate names: the practice's patients, plus a frequency-ranked public list.
 * @param maxDistance - Beyond this many wrong sounds a match is not worth offering.
 */
export function matchName(hypotheses: string[], roster: string[], maxDistance = 1.2): NameCandidate[] {
  const candidates = new Map<string, NameCandidate>();

  for (const heard of hypotheses) {
    const heardKey = phoneticKey(heard);
    if (!heardKey) continue;

    for (const name of roster) {
      const nameKey = phoneticKey(name);
      if (!nameKey) continue;

      const distance = soundAlikeDistance(heardKey, nameKey);
      if (distance > maxDistance) continue;

      const score = distance / Math.max(heardKey.length, nameKey.length);
      const existing = candidates.get(name);
      // A name reached from two hypotheses keeps its best evidence, not its last.
      if (!existing || distance < existing.distance) candidates.set(name, { name, distance, score, heard });
    }
  }

  return [...candidates.values()].sort((x, y) => x.distance - y.distance || x.name.localeCompare(y.name));
}

/**
 * Decides what to do with a set of matches, which is the part that changes the call.
 *
 * - One clear match: take it. The caller is not asked anything.
 * - Two or more: OFFER THEM. A two-way choice is a far more robust channel than asking somebody
 *   to spell a name again, because the caller only has to recognise, not to transmit.
 * - None: this is where a genuinely novel name lives, and it is not reachable with certainty by
 *   voice on a narrowband noisy line. That slice is small once the above is in place, and it is
 *   where a provisional booking plus a text confirmation belongs - as the LAST resort, not the
 *   second move.
 *
 * @param candidates - Output of {@link matchName}.
 * @param offerLimit - How many to read out. More than two is a menu, and a menu on a phone line is
 *   worse than a question.
 */
export function resolveName(candidates: NameCandidate[], offerLimit = 2):
  { outcome: 'accept'; name: string } |
  { outcome: 'offer'; names: string[] } |
  { outcome: 'unresolved' } {
  if (candidates.length === 0) return { outcome: 'unresolved' };

  const best = candidates[0];
  const runnerUp = candidates[1];

  // "Clear" means clear of the alternative, not merely close to the audio. Two names within a
  // hair of each other are exactly the case where confidently picking one writes the wrong name
  // into a record and reads it back convincingly - which is how this line has already failed.
  const isClear = !runnerUp || runnerUp.distance - best.distance >= 0.5;
  if (isClear && best.distance <= 0.5) return { outcome: 'accept', name: best.name };

  return { outcome: 'offer', names: candidates.slice(0, offerLimit).map(c => c.name) };
}
