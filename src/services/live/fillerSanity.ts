/**
 * Rejects a filler that is not a filler.
 *
 * A filler is one short acknowledgement of at most four words, spoken as the opening of the
 * agent's turn - "Got it", "Mm-hm", "Of course". It is produced by a very small model on a tight
 * token budget, and small models on tight budgets sometimes emit a piece of their own instructions
 * instead of following them. On 2026-08-28 a caller in a Delta Sky Club was told:
 *
 *   "Acknowledge only: OkayRight, I didn't catch that - can you say that again for me?"
 *
 * "Acknowledge only" is a line from the filler's prompt. Asking the model more firmly not to do
 * that is not a fix, because the shape of a correct filler is exactly expressible - and anything
 * exactly expressible should be certain rather than probable, which is the same argument the voice
 * output guard makes about digits.
 *
 * Dropping a filler costs nothing. The reply follows it either way, and a caller who hears no
 * acknowledgement hears a slightly more abrupt agent. A caller who hears the prompt hears a broken
 * one.
 */

/** Words that only appear in instructions about fillers, never in one. */
const INSTRUCTION_WORDS = /\b(?:acknowledge|acknowledgement|output|prompt|rule|rules|instruction|caller|assistant|response|sentence|absolute|exactly)\b/i;

export function sanitiseFiller(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // A colon is the shape of "Label: value", which is what a leaked instruction looks like and
  // what an acknowledgement never does.
  if (text.includes(':')) return null;

  // Four words is the documented ceiling; five is the allowance for a stray article before the
  // rule is treated as broken.
  if (text.split(/\s+/).length > 5) return null;

  if (INSTRUCTION_WORDS.test(text)) return null;

  // Newlines mean it produced a list, which the prompt forbids and the synthesiser would read
  // out as one run-on line.
  if (/[\n\r]/.test(text)) return null;

  return text;
}
