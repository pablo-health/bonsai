import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { emailRoutingEntrySchema } from '../../../channels/email/shared/EmailRoutingTypes';

extendZodWithOpenApi(z);

export const sendGridChannelProviderConfigSchema = z.strictObject({
  apiKey: z.string().describe('SendGrid API key'),
  fromAddress: z.string().email().describe('Sender email address'),
  threadingStrategy: z.enum(['messageId', 'senderSubject']).default('messageId').describe('How to derive thread ID for conversation continuity'),
  emailToProject: z.record(z.string().email(), z.union([z.string(), emailRoutingEntrySchema])).optional().describe('Maps email addresses to routing entries for multi-project routing. Each entry can specify projectId, cc, bcc, fromAddress, subject, stageId, and agentId. Plain string values (projectId only) are supported for backward compatibility.'),
}).openapi('SendGridChannelConfig');

export type SendGridChannelProviderConfig = z.infer<typeof sendGridChannelProviderConfigSchema>;
