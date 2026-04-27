import { injectable, inject } from 'tsyringe';
import { eq, and, SQL, desc } from 'drizzle-orm';
import { db } from '../../db/index';
import { scenarioRuns } from '../../db/schema';
import type { ScenarioRunStatus } from '../../db/schema';
import type { CreateScenarioRunRequest, ScenarioRunResponse, ScenarioRunListResponse } from '../../http/contracts/scenarioRun';
import type { ListParams } from '../../http/contracts/common';
import { scenarioRunResponseSchema, scenarioRunListResponseSchema } from '../../http/contracts/scenarioRun';
import { AuditService } from '../AuditService';
import { NotFoundError } from '../../errors';
import { buildFilterCondition, buildOrderBy } from '../../utils/queryBuilder';
import { countRows, normalizeListLimit } from '../../utils/pagination';
import { logger } from '../../utils/logger';
import { BaseService } from '../BaseService';
import type { RequestContext } from '../RequestContext';
import { PERMISSIONS } from '../../permissions';
import { generateId, ID_PREFIXES } from '../../utils/idGenerator';

/**
 * Service for managing scenario runs.
 * Scenario runs are system-generated instances of a scenario executed with one or more testers.
 * Only creation and reads are supported via the API; status updates are managed by the execution engine.
 */
@injectable()
export class ScenarioRunService extends BaseService {
  constructor(@inject(AuditService) private readonly auditService: AuditService) {
    super();
  }

  /**
   * Creates a new scenario run with initial status 'queued'
   * @param projectId - The project to create the run in
   * @param input - Scenario run creation data
   * @param context - Request context for auditing and authorization
   * @returns The created scenario run
   */
  async createScenarioRun(projectId: string, input: CreateScenarioRunRequest, context: RequestContext): Promise<ScenarioRunResponse> {
    this.requirePermission(context, PERMISSIONS.SCENARIO_RUN_WRITE);
    await this.requireProjectNotArchived(projectId);
    const runId = generateId(ID_PREFIXES.SCENARIO_RUN);
    logger.info({ runId, projectId, scenarioId: input.scenarioId, operatorId: context?.operatorId }, 'Creating scenario run');

    try {
      const totalConversations = Object.values(input.testers).reduce((sum, count) => sum + count, 0);
      const run = await db.insert(scenarioRuns).values({ id: runId, projectId, scenarioId: input.scenarioId, testers: input.testers, totalConversations, status: 'queued', metadata: input.metadata ?? null, version: 1 }).returning();

      const created = run[0];

      await this.auditService.logCreate('scenario_run', created.id, created, context?.operatorId);

      logger.info({ runId: created.id }, 'Scenario run created successfully');

      return scenarioRunResponseSchema.parse(created);
    } catch (error) {
      logger.error({ error, runId }, 'Failed to create scenario run');
      throw error;
    }
  }

  /**
   * Retrieves a scenario run by its unique identifier
   * @param projectId - The project the run belongs to
   * @param id - The unique identifier of the scenario run
   * @returns The scenario run if found
   * @throws {NotFoundError} When scenario run is not found
   */
  async getScenarioRunById(projectId: string, id: string): Promise<ScenarioRunResponse> {
    logger.debug({ runId: id }, 'Fetching scenario run by ID');

    try {
      const run = await db.query.scenarioRuns.findFirst({ where: and(eq(scenarioRuns.projectId, projectId), eq(scenarioRuns.id, id)) });

      if (!run) {
        throw new NotFoundError(`Scenario run with id ${id} not found`);
      }

      return scenarioRunResponseSchema.parse(run);
    } catch (error) {
      logger.error({ error, runId: id }, 'Failed to fetch scenario run');
      throw error;
    }
  }

  /**
   * Lists scenario runs with filtering, sorting, and pagination
   * @param projectId - The project to list runs for
   * @param params - List parameters including filters, sorting, and pagination
   * @returns Paginated array of scenario runs
   */
  async listScenarioRuns(projectId: string, params?: ListParams): Promise<ScenarioRunListResponse> {
    logger.debug({ params }, 'Listing scenario runs');

    try {
      const conditions: SQL[] = [eq(scenarioRuns.projectId, projectId)];
      const offset = params?.offset ?? 0;
      const limit = normalizeListLimit(params?.limit);

      const columnMap = {
        id: scenarioRuns.id,
        projectId: scenarioRuns.projectId,
        scenarioId: scenarioRuns.scenarioId,
        status: scenarioRuns.status,
        version: scenarioRuns.version,
        createdAt: scenarioRuns.createdAt,
        updatedAt: scenarioRuns.updatedAt,
      };

      if (params?.filters) {
        for (const [field, filter] of Object.entries(params.filters)) {
          const condition = buildFilterCondition(field, filter, columnMap, logger);
          if (condition) conditions.push(condition);
        }
      }

      const orderByClause = buildOrderBy(params?.orderBy, columnMap);
      const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

      const total = await countRows(scenarioRuns, whereCondition);

      const runList = await db.query.scenarioRuns.findMany({
        where: whereCondition,
        orderBy: orderByClause.length > 0 ? orderByClause : [desc(scenarioRuns.createdAt)],
        limit,
        offset,
      });

      return scenarioRunListResponseSchema.parse({ items: runList, total, offset, limit });
    } catch (error) {
      logger.error({ error, params }, 'Failed to list scenario runs');
      throw error;
    }
  }

  /**
   * Returns all scenario runs with status 'queued'
   * @param projectId - Optional project ID to scope the query
   * @returns Array of queued scenario runs
   */
  async findQueuedRuns(projectId?: string): Promise<ScenarioRunResponse[]> {
    try {
      const conditions: SQL[] = [eq(scenarioRuns.status, 'queued')];
      if (projectId) conditions.push(eq(scenarioRuns.projectId, projectId));
      const runs = await db.query.scenarioRuns.findMany({ where: and(...conditions), orderBy: [desc(scenarioRuns.createdAt)] });
      return runs.map((r) => scenarioRunResponseSchema.parse(r));
    } catch (error) {
      logger.error({ error }, 'Failed to find queued scenario runs');
      throw error;
    }
  }

  /**
   * Atomically transitions a scenario run from 'queued' to 'in_progress'.
   * Returns null if the run was already claimed by another executor instance.
   * @param runId - The scenario run ID to claim
   * @param projectId - The project the run belongs to
   * @returns The claimed run, or null if already claimed
   */
  async claimQueuedRun(runId: string, projectId: string): Promise<ScenarioRunResponse | null> {
    try {
      const updated = await db.update(scenarioRuns).set({ status: 'in_progress', updatedAt: new Date() }).where(and(eq(scenarioRuns.id, runId), eq(scenarioRuns.projectId, projectId), eq(scenarioRuns.status, 'queued'))).returning();
      if (updated.length === 0) return null;
      return scenarioRunResponseSchema.parse(updated[0]);
    } catch (error) {
      logger.error({ error, runId }, 'Failed to claim scenario run');
      throw error;
    }
  }

  /**
   * Updates the status of a scenario run
   * @param runId - The scenario run ID
   * @param projectId - The project the run belongs to
   * @param status - The new status to set
   */
  async updateRunStatus(runId: string, projectId: string, status: ScenarioRunStatus): Promise<void> {
    try {
      await db.update(scenarioRuns).set({ status, updatedAt: new Date() }).where(and(eq(scenarioRuns.id, runId), eq(scenarioRuns.projectId, projectId)));
      logger.info({ runId, status }, 'Scenario run status updated');
    } catch (error) {
      logger.error({ error, runId, status }, 'Failed to update scenario run status');
      throw error;
    }
  }
}
