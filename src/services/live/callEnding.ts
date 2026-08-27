/**
 * Whether a call may actually be hung up, or should be confirmed first.
 *
 * Kept pure and in its own file so the decision can be tested without a conversation, and so the
 * rule lives somewhere other than inside a long method in the runner.
 */

/**
 * The caller plainly saying they are done.
 *
 * Tight on purpose. This is the bypass that lets a normal goodbye end a call immediately, so
 * anything it matches skips the confirmation below - and the failure this whole module exists to
 * prevent was a classifier being too generous about what counts as an ending. A statement that
 * merely sounds content ("that's great", "I got the apartment") is not here, and must not be.
 */
const EXPLICIT_FAREWELL =
  /\b(?:good\s?bye|bye now|bye bye|bye|take care|have a good (?:one|day|night)|that(?:'s| is) (?:all|everything|it)|that(?:'s| is) all i (?:needed|wanted)|no(?:pe)?,? (?:that(?:'s| is) (?:all|everything|it)|thank you|thanks|(?:i(?:'m| am) )?(?:good|all set)|you(?:'ve| have) covered it)|i(?:'m| am) all set|all set,? thanks|nothing else)\b/i;

/**
 * What to do when an action asks to end the call.
 *
 * `end_conversation` is irreversible in the way that matters on a phone: the caller has to dial
 * again and start over, having already given their name and their number. On 2026-08-27 this line
 * ended a call because one utterance - itself a mishearing on a noisy line - was classified as the
 * caller being finished. They had asked for nothing and been given nothing.
 *
 * So the irreversible step needs a confirming exchange, exactly as cancelling the agent's speech
 * on barge-in does: do the cheap reversible thing first, and take the expensive one only once
 * something has agreed with it.
 *
 * @param lastUserUtterance - the caller's most recent transcript, or null if there is none.
 * @param alreadyAsked - true when the agent has already put a closing question and this is the
 *   answer to it.
 */
export function decideCallEnding(
  lastUserUtterance: string | null | undefined,
  alreadyAsked: boolean,
): 'end' | 'confirm-first' {
  if (alreadyAsked) return 'end';
  if (EXPLICIT_FAREWELL.test(lastUserUtterance ?? '')) return 'end';
  return 'confirm-first';
}

/** Asked before hanging up on a caller who has not actually said goodbye. */
export const CLOSING_QUESTION = 'Before I let you go - is there anything else I can help you with?';
