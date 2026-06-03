import { randomBytes } from 'crypto';

/**
 * Generates a unique Message-ID for an email.
 *
 * When a conversation ID is provided, the format is:
 *   <{uuid}.{YYYYMMDD}.{HHMMSS}@bonsai.ai>
 * where {uuid} is the conversation ID without the "conv_" prefix.
 *
 * Without a conversation ID a random fallback is used.
 */
export function generateEmailMessageId(conversationId?: string): string {
  if (conversationId) {
    const ts = new Date().toISOString().replace(/[-T:Z]/g, '').replace(/\.\d{3}/, '');
    const id = conversationId.replace(/^conv_/, '');
    return `<${id}.${ts.slice(0, 8)}.${ts.slice(8)}@bonsai.ai>`;
  }

  const rand = randomBytes(16).toString('hex');
  return `<${rand}@bonsai.ai>`;
}

/**
 * Extracts the conversation ID from a Message-ID or In-Reply-To header.
 *
 * Handles both legacy format (<conv_xxx@bonsai.ai>) and timestamped format
 * (<uuid.YYYYMMDD.hhmmss@bonsai.ai>), always returning the full "conv_xxx" ID.
 */
export function extractConversationIdFromMessageId(header?: string): string | undefined {
  if (!header) return undefined;

  const match = header.match(/<([0-9a-f-]{36})(?:\.[^>]*)?@bonsai\.ai>/);
  if (match) return `conv_${match[1]}`;

  const legacyMatch = header.match(/<conv_([0-9a-f-]+)@bonsai\.ai>/);
  if (legacyMatch) return `conv_${legacyMatch[1]}`;

  return undefined;
}
