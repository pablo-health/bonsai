import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { listParamsSchema, listResponseLimitSchema } from './common';
import type { ListParams } from './common';

extendZodWithOpenApi(z);

export { listParamsSchema, type ListParams };

/** Possible statuses for a scenario run or scenario conversation */
export const scenarioRunStatusSchema = z.enum(['queued', 'in_progress', 'passed', 'failed']).openapi('ScenarioRunStatus');

/**
 * Schema for scenario run route params
 */
export const scenarioRunRouteParamsSchema = z.object({
  projectId: z.string().min(1).describe('Project ID'),
  id: z.string().describe('Scenario Run ID'),
});

/**
 * Schema for creating a new scenario run
 */
export const createScenarioRunSchema = z.object({
  scenarioId: z.string().min(1).describe('ID of the scenario to run'),
  testerIds: z.array(z.string().min(1)).min(1).describe('IDs of the tester personas to use in this run'),
  totalConversations: z.number().int().min(1).describe('Total number of conversations to execute in this run'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Additional metadata for this run'),
});

/**
 * Schema for scenario run response
 */
export const scenarioRunResponseSchema = z.object({
  id: z.string().describe('Unique identifier for the scenario run'),
  projectId: z.string().describe('ID of the project this run belongs to'),
  scenarioId: z.string().describe('ID of the scenario being run'),
  testerIds: z.array(z.string()).describe('IDs of the tester personas used in this run'),
  totalConversations: z.number().int().describe('Total number of conversations to execute'),
  status: scenarioRunStatusSchema.describe('Current status of the scenario run'),
  metadata: z.record(z.string(), z.unknown()).nullable().describe('Additional metadata'),
  version: z.number().int().describe('Version number for optimistic locking'),
  createdAt: z.coerce.date().describe('Timestamp when the run was created'),
  updatedAt: z.coerce.date().describe('Timestamp when the run was last updated'),
});

/**
 * Schema for paginated list of scenario runs
 */
export const scenarioRunListResponseSchema = z.object({
  items: z.array(scenarioRunResponseSchema).describe('Array of scenario runs in the current page'),
  total: z.number().int().min(0).describe('Total number of scenario runs matching the query'),
  offset: z.number().int().min(0).describe('Starting index of the current page'),
  limit: listResponseLimitSchema,
});

/** Request body for creating a new scenario run */
export type CreateScenarioRunRequest = z.infer<typeof createScenarioRunSchema>;

/** Response for a single scenario run */
export type ScenarioRunResponse = z.infer<typeof scenarioRunResponseSchema>;

/** Response for paginated list of scenario runs */
export type ScenarioRunListResponse = z.infer<typeof scenarioRunListResponseSchema>;
