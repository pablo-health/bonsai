/**
 * The caller's own telephone number, as the phone network reported it.
 *
 * Kept in its own file deliberately. This is a pure string test that the output guard, the
 * context builder and the runner all need, and importing it should not pull in the conversation
 * machinery - which, among other things, is what makes it testable without a native VM.
 */
export type CallerNumber = {
  /** E.164, e.g. "+14047544201". Null when the channel has no number for this caller. */
  number: string | null;
  /**
   * The last four digits, e.g. "4201".
   *
   * What a prompt should normally speak. The caller already knows their own number, so the rest
   * of it is nobody's business on a line that may be on speakerphone in a waiting room - and four
   * digits is enough for them to recognise it.
   */
  lastFour: string | null;
};

/**
 * Reads a caller's telephone number out of the conversation's user id.
 *
 * The SIP channel sets the user id to the caller's number in E.164 (see LiveKitChannelHost's
 * toUserId), so on a phone call the id IS the number. Every other channel sets it to something
 * that is not one, hence the shape test rather than a channel check: a generated id, an email or
 * a Telegram handle all fail it and yield nulls, which is the honest answer for them.
 */
export function callerFromUserId(userId: string | null | undefined): CallerNumber {
  const candidate = (userId ?? '').trim();
  // E.164: a leading +, a country code that cannot start with 0, and at most 15 digits. Anything
  // shorter than 8 is not a dialable number and is far more likely to be an id that happens to
  // look numeric.
  if (!/^\+[1-9]\d{7,14}$/.test(candidate)) return { number: null, lastFour: null };
  return { number: candidate, lastFour: candidate.slice(-4) };
}
