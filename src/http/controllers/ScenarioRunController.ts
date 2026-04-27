import { inject, singleton } from 'tsyringe';
import type { Request, Response, Router } from 'express';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { PERMISSIONS } from '../../permissions';
import { ScenarioRunService } from '../../services/ScenarioRunService';
import { createScenarioRunSchema, scenarioRunResponseSchema, scenarioRunListResponseSchema, scenarioRunRouteParamsSchema } from '../contracts/scenarioRun';
import { listParamsSchema, projectScopedParamsSchema } from '../contracts/common';
import { checkPermissions } from '../../utils/permissions';
import { asyncHandler } from '../../utils/asyncHandler';

/**
 * Controller for scenario run management
 */
@singleton()
export class ScenarioRunController {
  constructor(@inject(ScenarioRunService) private readonly scenarioRunService: ScenarioRunService) { }

  /**
   * Get OpenAPI path definitions for this controller
   */
  static getOpenAPIPaths(): RouteConfig[] {
    return [
      {
        method: 'post',
        path: '/api/projects/{projectId}/scenario-runs',
        tags: ['Scenario Runs'],
        summary: 'Create a new scenario run',
        description: 'Creates a new scenario run instance with status queued, ready to be picked up by the testing engine',
        request: {
          body: {
            content: {
              'application/json': {
                schema: createScenarioRunSchema,
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Scenario run created successfully',
            content: { 'application/json': { schema: scenarioRunResponseSchema } },
          },
          400: { description: 'Invalid request body' },
        },
      },
      {
        method: 'get',
        path: '/api/projects/{projectId}/scenario-runs',
        tags: ['Scenario Runs'],
        summary: 'List scenario runs',
        description: 'Retrieves a paginated list of scenario runs with optional filtering and sorting',
        request: {
          query: listParamsSchema,
        },
        responses: {
          200: {
            description: 'List of scenario runs retrieved successfully',
            content: { 'application/json': { schema: scenarioRunListResponseSchema } },
          },
        },
      },
      {
        method: 'get',
        path: '/api/projects/{projectId}/scenario-runs/{id}',
        tags: ['Scenario Runs'],
        summary: 'Get scenario run by ID',
        description: 'Retrieves a single scenario run by its unique identifier',
        request: {
          params: scenarioRunRouteParamsSchema,
        },
        responses: {
          200: {
            description: 'Scenario run retrieved successfully',
            content: { 'application/json': { schema: scenarioRunResponseSchema } },
          },
          404: { description: 'Scenario run not found' },
        },
      },
    ];
  }

  /**
   * Register all routes for this controller
   */
  registerRoutes(router: Router): void {
    router.post('/api/projects/:projectId/scenario-runs', asyncHandler(this.createScenarioRun.bind(this)));
    router.get('/api/projects/:projectId/scenario-runs', asyncHandler(this.listScenarioRuns.bind(this)));
    router.get('/api/projects/:projectId/scenario-runs/:id', asyncHandler(this.getScenarioRunById.bind(this)));
  }

  private async createScenarioRun(req: Request, res: Response): Promise<void> {
    checkPermissions(req, [PERMISSIONS.SCENARIO_RUN_WRITE]);
    const { projectId } = projectScopedParamsSchema.parse(req.params);
    const body = createScenarioRunSchema.parse(req.body);
    const run = await this.scenarioRunService.createScenarioRun(projectId, body, req.context);
    res.status(201).json(run);
  }

  private async listScenarioRuns(req: Request, res: Response): Promise<void> {
    checkPermissions(req, [PERMISSIONS.SCENARIO_RUN_READ]);
    const { projectId } = projectScopedParamsSchema.parse(req.params);
    const query = listParamsSchema.parse(req.query);
    const runs = await this.scenarioRunService.listScenarioRuns(projectId, query);
    res.status(200).json(runs);
  }

  private async getScenarioRunById(req: Request, res: Response): Promise<void> {
    checkPermissions(req, [PERMISSIONS.SCENARIO_RUN_READ]);
    const params = scenarioRunRouteParamsSchema.parse(req.params);
    const run = await this.scenarioRunService.getScenarioRunById(params.projectId, params.id);
    res.status(200).json(run);
  }
}
