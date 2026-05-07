import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

export const sesChannelProviderConfigSchema = z.strictObject({
  accessKeyId: z.string().describe('AWS Access Key ID'),
  secretAccessKey: z.string().describe('AWS Secret Access Key'),
  region: z.string().describe('AWS region (e.g., us-east-1)'),
  fromAddress: z.string().email().describe('Sender email address'),
  threadingStrategy: z.enum(['messageId', 'senderSubject']).default('messageId').describe('How to derive thread ID for conversation continuity'),
}).openapi('SesChannelConfig');

export type SesChannelProviderConfig = z.infer<typeof sesChannelProviderConfigSchema>;
