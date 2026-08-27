import type { TextChunk } from '../providers/asr/IAsrProvider';

/**
 * Decides whether a transcript is the caller talking to us, or the room being audible.
 *
 * A phone call is one mixed stream. The caller's mouth is centimetres from the microphone and
 * everyone else in the room is metres away, so the recogniser returns nearby speech with high
 * per-word confidence and background speech as short fragments with low scores behind them. That
 * score is the only thing in the audio that separates the two, and it is worth acting on before a
 * turn exists at all: once a turn is open the agent has already stopped listening to answer.
 *
 * Confidence that is absent means the provider does not report one, and must read as "unknown",
 * never as "low". Reading it as low would silence every provider except Transcribe the moment a
 * threshold was switched on.
 *
 * CALLERS: this belongs to barge-in and nowhere else. The two directions are not symmetric. While
 * the agent is talking, a false reject costs a repeat. While the agent is WAITING for an answer
 * it has just asked for, a false reject ends the call in silence - and the answer most likely to
 * score low is a name, since a proper noun is precisely what a language model cannot help with.
 * Applying this to an awaited answer aims the rejection at the input least able to afford it.
 *
 * @param chunks - the turn's recognised chunks.
 * @param threshold - minimum mean confidence, 0..1. Undefined disables the gate entirely.
 * @returns the mean confidence weighed, and whether it passes.
 */
export function assessTranscriptConfidence(
  chunks: TextChunk[],
  threshold: number | undefined,
): { passes: boolean; meanConfidence: number | undefined } {
  const scored = chunks.filter((chunk) => chunk.text.trim().length > 0 && typeof chunk.confidence === 'number');
  const meanConfidence = scored.length === 0
    ? undefined
    : scored.reduce((total, chunk) => total + (chunk.confidence as number), 0) / scored.length;

  if (threshold === undefined) return { passes: true, meanConfidence };
  if (meanConfidence === undefined) return { passes: true, meanConfidence };

  return { passes: meanConfidence >= threshold, meanConfidence };
}
