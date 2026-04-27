import { injectable } from 'tsyringe';
import { eq, and, SQL, desc } from 'drizzle-orm';
import { db } from '../../db/index';
import { scenarioConversations } from '../../db/schema';
import type { ScenarioConversationResponse, ScenarioConversationListResponse, ScenarioConversationListParams } from '../../http/contracts/scenarioConversation';
import { scenarioConversationResponseSchema, scenarioConversationListResponseSchema } from '../../http/contracts/scenarioConversation';
import { NotFoundError } from '../../errors';
import { buildFilterCondition, buildOrderBy } from '../../utils/queryBuilder';
import { countRows, normalizeListLimit } from '../../utils/pagination';
import { logger } from '../../utils/logger';
import { BaseService } from '../BaseService';

/**
 * Service for reading scenario conversations.
 * Scenario conversations are system-generated and read-only via the API.
 */
@injectable()
export class ScenarioConversationService extends BaseService {
  /**
   * Retrieves a scenario conversation by its unique identifier
   * @param projectId - The project the conversation belongs to
   * @param id - The unique identifier of the scenario conversation
   * @returns The scenario conversation if found
   * @throws {NotFoundError} When scenario conversation is not found
   */
  async getScenarioConversationById(projectId: string, id: string): Promise<ScenarioConversationResponse> {
    logger.debug({ scenarioConversationId: id }, 'Fetching scenario conversation by ID');

    try {
      const conversation = await db.query.scenarioConversations.findFirst({ where: and(eq(scenarioConversations.projectId, projectId), eq(scenarioConversations.id, id)) });

      if (!conversation) {
        throw new NotFoundError(`Scenario conversation with id ${id} not found`);
      }

      return scenarioConversationResponseSchema.parse(conversation);
    } catch (error) {
      logger.error({ error, scenarioConversationId: id }, 'Failed to fetch scenario conversation');
      throw error;
    }
  }

  /**
   * Lists scenario conversations with filtering, sorting, and pagination.
   * Supports filtering by scenarioRunId.
   * @param projectId - The project to list conversations for
   * @param params - List parameters including optional scenarioRunId filter
   * @returns Paginated array of scenario conversations
   */
  async listScenarioConversations(projectId: string, params?: ScenarioConversationListParams): Promise<ScenarioConversationListResponse> {
    logger.debug({ params }, 'Listing scenario conversations');

    try {
      const conditions: SQL[] = [eq(scenarioConversations.projectId, projectId)];
      const offset = params?.offset ?? 0;
      const limit = normalizeListLimit(params?.limit);

      if (params?.scenarioRunId) {
        conditions.push(eq(scenarioConversations.scenarioRunId, params.scenarioRunId));
      }

      const columnMap = {
        id: scenarioConversations.id,
        projectId: scenarioConversations.projectId,
        scenarioRunId: scenarioConversations.scenarioRunId,
        scenarioId: scenarioConversations.scenarioId,
        testerId: scenarioConversations.testerId,
        status: scenarioConversations.status,
        version: scenarioConversations.version,
        createdAt: scenarioConversations.createdAt,
        updatedAt: scenarioConversations.updatedAt,
      };

      if (params?.filters) {
        for (const [field, filter] of Object.entries(params.filters)) {
          const condition = buildFilterCondition(field, filter, columnMap, logger);
          if (condition) conditions.push(condition);
        }
      }

      const orderByClause = buildOrderBy(params?.orderBy, columnMap);
      const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

      const total = await countRows(scenarioConversations, whereCondition);

      const conversationList = await db.query.scenarioConversations.findMany({
        where: whereCondition,
        orderBy: orderByClause.length > 0 ? orderByClause : [desc(scenarioConversations.createdAt)],
        limit,
        offset,
      });

      return scenarioConversationListResponseSchema.parse({ items: conversationList, total, offset, limit });
    } catch (error) {
      logger.error({ error, params }, 'Failed to list scenario conversations');
      throw error;
    }
  }
}
