import { randomBytes } from 'crypto';

/**
 * Extracts the domain from an email address.
 */
export function extractDomainFromEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const parts = email.split('@');
  return parts.length === 2 ? parts[1] : undefined;
}

/**
 * Generates a unique Message-ID for an email.
 *
 * When a conversation ID is provided, the format is:
 *   <{uuid}.{YYYYMMDD}.{HHMMSS}@domain>
 * where {uuid} is the conversation ID without the "conv_" prefix.
 *
 * Falls back to a random ID if no conversation ID is provided.
 * Uses the given domain, or `bonsai.ai` as a last resort.
 */
export function generateEmailMessageId(conversationId?: string, domain?: string): string {
  const fallbackDomain = domain || 'bonsai.ai';

  if (conversationId) {
    const id = conversationId.replace(/^conv_/, '').replace(/-/g, '');
    return `<${id}@${fallbackDomain}>`;
  }

  return `<${randomBytes(16).toString('hex')}@${fallbackDomain}>`;
}

/**
 * Extracts the conversation ID from a Message-ID or In-Reply-To header.
 *
 * Handles both legacy format (<conv_xxx@domain>) and compact UUID format
 * (<uuid32@domain>) with any domain.
 */
export function extractConversationIdFromMessageId(header?: string): string | undefined {
  if (!header) return undefined;

  const match = header.match(/<([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.[^>]*)?@[^\>]+>/);
  if (match) {
    const uuid = match[1];
    const formatted = uuid.length === 32
      ? `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`
      : uuid;
    return `conv_${formatted}`;
  }

  const legacyMatch = header.match(/<conv_([0-9a-f-]+)@[^\>]+>/);
  if (legacyMatch) return `conv_${legacyMatch[1]}`;

  return undefined;
}

/**
 * Extracts a conversation ID from a References header (space-separated list of Message-IDs).
 * Returns the first match found.
 */
export function extractConversationIdFromReferences(header?: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/\s+/)) {
    const match = part.match(/<([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.[^>]*)?@[^\>]+>/);
    if (match) {
      const uuid = match[1];
      const formatted = uuid.length === 32
        ? `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`
        : uuid;
      return `conv_${formatted}`;
    }

    const legacyMatch = part.match(/<conv_([0-9a-f-]+)@[^\>]+>/);
    if (legacyMatch) return `conv_${legacyMatch[1]}`;
  }
  return undefined;
}
