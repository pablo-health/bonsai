import { LlmContent } from '../services/providers/llm/ILlmProvider';

/**
 * Extract text content from LlmContent array
 */
export function extractTextFromContent(content: LlmContent[]): string {
  return content
    .filter(block => block.contentType === 'text')
    .map(block => (block as any).text)
    .join('');
}

/**
 * Join the spoken filler to the reply that continues it.
 *
 * The reply is a continuation, not a new sentence, so it frequently opens with the punctuation
 * that closes the filler's clause: "Got it" continued by " - so you're looking at..." or "Okay"
 * by ", I can hear you fine". Joining those with a space strands it - "Got it  - so", "Okay ,
 * I can hear" - which is silent in speech and visible in every transcript, summary and email the
 * turn ends up in.
 */
export function joinFillerToReply(filler: string | null, reply: string): string {
  if (!filler) return reply.trim();
  const rest = reply.replace(/^\s+/, '');
  // Only the marks that CLOSE a clause attach tight. A dash opens one - "Got it - you're looking
  // for a different Pablo" - and closing it up to "Got it- you're" is just a different typo from
  // the one this function exists to prevent.
  const needsSpace = rest.length > 0 && !/^[,.!?;:)\]}]/.test(rest);
  if (!needsSpace) return `${filler}${rest}`.trim();

  // A filler that ends mid-thought and a reply that starts a new sentence are two utterances, and
  // a bare space between them is not a boundary the synthesiser can hear: "Sure" + "Of course.
  // What's your first and last name?" was spoken as "Sure Of course", running the two together
  // with no pause. Terminal punctuation is what tells TTS to breathe.
  //
  // Only when the reply genuinely starts a new sentence, though. The reply model is prefilled
  // with the filler and is meant to continue it - "Let me check that" + "for you right now" is
  // one sentence in two pieces, and a full stop in the middle of it would be the same defect
  // pointing the other way. A lowercase opening is that continuation; a capital is not.
  const fillerEndsMidThought = !/[.!?…,;:)\]}\u2014\u2013-]$/.test(filler.trimEnd());
  const replyStartsSentence = /^["'\u201c\u2018(\[]?[A-Z0-9]/.test(rest);
  const separator = fillerEndsMidThought && replyStartsSentence ? '. ' : ' ';

  return `${filler.trimEnd()}${separator}${rest}`.trim();
}

/**
 * Calculate total content size for logging
 */
export function getContentSize(content: LlmContent[]): number {
  let size = 0;
  for (const block of content) {
    if (block.contentType === 'text') {
      size += (block as any).text.length;
    } else if (block.contentType === 'image' || block.contentType === 'audio') {
      size += (block as any).data.length;
    }
  }
  return size;
}
