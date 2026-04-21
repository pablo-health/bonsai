/**
 * Migration script: Encrypt plain-text secrets in provider configs and environment passwords.
 *
 * This script scans all provider.config JSONB objects and environment.password fields for
 * plain-text values at known sensitive keys and encrypts them using the local secrets manager.
 * It is idempotent — already-encrypted values (those matching @sec:*) are skipped.
 *
 * Usage:
 *   npm run secrets:migrate             # dry run (no changes)
 *   npm run secrets:migrate -- --apply  # apply changes
 *
 * Prerequisites:
 *   - MASTER_ENCRYPTION_KEY env var must be set
 *   - DB_CONNECTION_STRING env var must be set
 *   - Migrations must be up to date (npm run db:migrate)
 */
import 'reflect-metadata';
import { container } from 'tsyringe';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { providers, environments } from '../db/schema';
import { SecretsManagerRegistry } from '../services/secrets/SecretsManagerRegistry';
import { LocalSecretsManager, LOCAL_SECRETS_MANAGER_NAME } from '../services/secrets/LocalSecretsManager';
import { SENSITIVE_PROVIDER_CONFIG_FIELDS } from '../services/secrets/SecretRefUtils';

const isDryRun = !process.argv.includes('--apply');

if (isDryRun) {
  console.log('[dry-run] Pass --apply to apply changes.');
}

/** Secretizes sensitive string fields in an object, returning the modified copy and change count. */
async function secretizeObject(obj: Record<string, unknown>, registry: SecretsManagerRegistry, managerName: string): Promise<{ updated: Record<string, unknown>; changes: number }> {
  const result = { ...obj };
  let changes = 0;
  for (const key of SENSITIVE_PROVIDER_CONFIG_FIELDS) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0 && !registry.isSecretReference(value)) {
      if (!isDryRun) {
        result[key] = await registry.storeSecret(managerName, value);
      }
      changes++;
    }
  }
  return { updated: result, changes };
}

async function run(): Promise<void> {
  // Bootstrap registry
  const registry = container.resolve(SecretsManagerRegistry);
  const localManager = container.resolve(LocalSecretsManager);
  registry.register(LOCAL_SECRETS_MANAGER_NAME, localManager);

  let totalProviderChanges = 0;
  let totalEnvChanges = 0;

  // Migrate providers
  const allProviders = await db.select({ id: providers.id, name: providers.name, config: providers.config }).from(providers);
  for (const row of allProviders) {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const { updated, changes } = await secretizeObject(config, registry, LOCAL_SECRETS_MANAGER_NAME);
    if (changes > 0) {
      console.log(`[provider] ${row.id} (${row.name}): ${changes} field(s) ${isDryRun ? 'would be' : 'were'} encrypted`);
      if (!isDryRun) {
        await db.update(providers).set({ config: updated }).where(eq(providers.id, row.id));
      }
      totalProviderChanges += changes;
    }
  }

  // Migrate environment passwords
  const allEnvs = await db.select({ id: environments.id, description: environments.description, password: environments.password }).from(environments);
  for (const row of allEnvs) {
    if (row.password && typeof row.password === 'string' && !registry.isSecretReference(row.password)) {
      console.log(`[environment] ${row.id} (${row.description}): password ${isDryRun ? 'would be' : 'was'} encrypted`);
      if (!isDryRun) {
        const ref = await registry.storeSecret(LOCAL_SECRETS_MANAGER_NAME, row.password);
        await db.update(environments).set({ password: ref }).where(eq(environments.id, row.id));
      }
      totalEnvChanges++;
    }
  }

  console.log(`\nDone. ${totalProviderChanges} provider field(s), ${totalEnvChanges} environment password(s) ${isDryRun ? 'would be' : 'were'} encrypted.`);
  if (isDryRun && (totalProviderChanges > 0 || totalEnvChanges > 0)) {
    console.log('Run with --apply to apply changes.');
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
