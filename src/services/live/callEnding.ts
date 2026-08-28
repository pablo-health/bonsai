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
  agentAskedAQuestion = false,
): 'end' | 'confirm-first' | 'ignore' {
  // A plain goodbye ends the call from anywhere. Making somebody say it twice is its own insult,
  // and it is unambiguous enough to trust.
  if (EXPLICIT_FAREWELL.test(lastUserUtterance ?? '')) return 'end';

  // The caller is ANSWERING A QUESTION. They cannot also be leaving.
  //
  // This is the case that keeps happening, and it needs no knowledge of what the intake requires:
  // on 2026-08-28 the agent asked "how do you spell Mimi?", the caller said "N I E M I.", and the
  // classifier returned caller_finished. Twice, in two consecutive calls. A reply to a question
  // the agent itself just asked is the middle of an exchange by construction, whatever a
  // classifier makes of its content.
  //
  // Ignored outright rather than confirmed, because asking "is there anything else?" in the middle
  // of taking somebody's name derails the booking just as thoroughly as hanging up would - it is
  // simply less rude about it. The agent should carry on with what it was doing.
  // Checked BEFORE the question rule, and the order is load-bearing. The closing question is
  // itself a question, so a caller answering it would otherwise be read as mid-exchange forever
  // and the call could never end - a suppression path with no exit, which is the same mistake
  // this file was written to correct.
  if (alreadyAsked) return 'end';

  if (agentAskedAQuestion) return 'ignore';

  return 'confirm-first';
}

/**
 * Whether the agent's own last utterance put a question to the caller.
 *
 * Read off the agent's speech rather than any model's opinion of it. A question mark is the
 * signal; the trailing-fragment allowance exists because a turn often ends with a short aside
 * after the question - "Can I get your first and last name? Take your time."
 */
export function endsWithAQuestion(agentUtterance: string | null | undefined): boolean {
  const text = (agentUtterance ?? '').trim();
  if (!text) return false;
  const tail = text.slice(-160);
  if (!tail.includes('?')) return false;
  // Nothing but a short aside may follow the question mark, or this was a question earlier in a
  // turn that has since moved on to something else.
  const after = tail.slice(tail.lastIndexOf('?') + 1).trim();
  return after.split(/\s+/).filter(Boolean).length <= 8;
}

/** Asked before hanging up on a caller who has not actually said goodbye. */
export const CLOSING_QUESTION = 'Before I let you go - is there anything else I can help you with?';
