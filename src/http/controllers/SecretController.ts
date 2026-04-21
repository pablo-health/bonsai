import { inject, singleton } from 'tsyringe';
import type { Request, Response, Router } from 'express';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { eq } from 'drizzle-orm';
import { PERMISSIONS } from '../../permissions';
import { secretResponseSchema, secretListResponseSchema, secretRouteParamsSchema } from '../contracts/secret';
import { checkPermissions } from '../../utils/permissions';
import { asyncHandler } from '../../utils/asyncHandler';
import { SecretsManagerRegistry } from '../../services/secrets/SecretsManagerRegistry';
import { LOCAL_SECRETS_MANAGER_NAME } from '../../services/secrets/LocalSecretsManager';
import { db } from '../../db/index';
import { providers, environments } from '../../db/schema';
import { ConflictError, NotFoundError } from '../../errors';

/**
 * Controller for secrets management.
 * Provides read-only listing (with orphan detection) and deletion of stored secrets.
 * Secret values are never returned — only opaque references.
 */
@singleton()
export class SecretController {
  constructor(@inject(SecretsManagerRegistry) private readonly registry: SecretsManagerRegistry) {}

  /** @returns OpenAPI path definitions for this controller */
  static getOpenAPIPaths(): RouteConfig[] {
    return [
      {
        method: 'get',
        path: '/api/secrets',
        tags: ['Secrets'],
        summary: 'List all secrets',
        description: 'Lists all secrets in the store. Secret values are never returned. Also returns orphan refs — secrets that exist in the store but are not referenced by any provider config or environment.',
        responses: {
          200: {
            description: 'Secrets listed successfully',
            content: {
              'application/json': {
                schema: secretListResponseSchema,
              },
            },
          },
        },
      },
      {
        method: 'delete',
        path: '/api/secrets/{id}',
        tags: ['Secrets'],
        summary: 'Delete a secret',
        description: 'Deletes a secret by its ID. Returns 409 if the secret is still referenced by a provider config or environment.',
        request: {
          params: secretRouteParamsSchema,
        },
        responses: {
          204: { description: 'Secret deleted successfully' },
          404: { description: 'Secret not found' },
          409: { description: 'Secret is still in use and cannot be deleted' },
        },
      },
    ];
  }

  /** Register all routes for this controller */
  registerRoutes(router: Router): void {
    router.get('/api/secrets', asyncHandler(this.listSecrets.bind(this)));
    router.delete('/api/secrets/:id', asyncHandler(this.deleteSecret.bind(this)));
  }

  private async listSecrets(req: Request, res: Response): Promise<void> {
    checkPermissions(req, [PERMISSIONS.SECRETS_READ]);

    const allRefs = await this.registry.listAllRefs();
    const referencedRefs = await this.collectReferencedRefs();

    const items = allRefs.map(ref => {
      const parts = ref.split(':');
      const id = parts[2];
      return { id, ref, createdAt: '', updatedAt: '' };
    });

    const orphans = allRefs.filter(ref => !referencedRefs.has(ref));

    res.status(200).json({ items, orphans });
  }

  private async deleteSecret(req: Request, res: Response): Promise<void> {
    checkPermissions(req, [PERMISSIONS.SECRETS_DELETE]);

    const { id } = secretRouteParamsSchema.parse(req.params);

    const ref = `@sec:${LOCAL_SECRETS_MANAGER_NAME}:${id}`;

    const referencedRefs = await this.collectReferencedRefs();
    if (referencedRefs.has(ref)) {
      throw new ConflictError(`Secret ${ref} is still referenced and cannot be deleted`);
    }

    await this.registry.deleteSecret(ref);

    res.status(204).send();
  }

  /**
   * Scans all provider configs and environment passwords to find all `@sec:*` references in use.
   */
  private async collectReferencedRefs(): Promise<Set<string>> {
    const refsInUse = new Set<string>();

    const allProviders = await db.select({ config: providers.config }).from(providers);
    for (const row of allProviders) {
      this.extractRefsFromValue(row.config, refsInUse);
    }

    const allEnvs = await db.select({ password: environments.password }).from(environments);
    for (const row of allEnvs) {
      if (row.password && this.registry.isSecretReference(row.password)) {
        refsInUse.add(row.password);
      }
    }

    return refsInUse;
  }

  /**
   * Recursively extracts all `@sec:*` references from an arbitrary value.
   */
  private extractRefsFromValue(value: unknown, out: Set<string>): void {
    if (typeof value === 'string') {
      if (this.registry.isSecretReference(value)) {
        out.add(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        this.extractRefsFromValue(item, out);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) {
        this.extractRefsFromValue(v, out);
      }
    }
  }
}
