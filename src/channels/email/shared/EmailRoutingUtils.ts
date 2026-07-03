import { logger } from '../../../utils/logger';

export interface EmailRoutingResult {
  projectId: string;
  targetEmail: string;
}

export function extractRecipientEmails(to: string | string[] | undefined): string[] {
  if (!to) return [];

  const addresses = Array.isArray(to) ? to : [to];

  const results: string[] = [];

  for (const addr of addresses) {
    const normalized = addr.trim().toLowerCase();
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

export function resolveEmailRouting(
  emailToProject: Record<string, string> | undefined,
  recipientEmails: string[],
  fallbackProjectId: string,
  fallbackTargetEmail: string,
): EmailRoutingResult {
  if (!emailToProject || Object.keys(emailToProject).length === 0) {
    return {
      projectId: fallbackProjectId,
      targetEmail: recipientEmails[0] ?? fallbackTargetEmail,
    };
  }

  const normalizedMap: Record<string, string> = {};

  for (const [email, projectId] of Object.entries(emailToProject)) {
    normalizedMap[email.trim().toLowerCase()] = projectId;
  }

  for (const recipientEmail of recipientEmails) {
    const normalized = recipientEmail.trim().toLowerCase();

    if (normalizedMap[normalized]) {
      logger.info({ recipientEmail, projectId: normalizedMap[normalized] }, 'Email routed via emailToProject mapping');
      return {
        projectId: normalizedMap[normalized],
        targetEmail: normalized,
      };
    }
  }

  logger.warn({ recipientEmails }, 'No matching emailToProject entry, falling back to default projectId');
  return {
    projectId: fallbackProjectId,
    targetEmail: recipientEmails[0] ?? fallbackTargetEmail,
  };
}
