import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface ApiKeySummary {
  id: string;
  name: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

interface ApiKeyCreate extends ApiKeySummary {
  key: string;
}

export async function listApiKeys(): Promise<void> {
  try {
    const res = await get<{ items: ApiKeySummary[]; total: number }>('/api/api-keys');
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'Permissions'.padEnd(30)} │ ${'Last Used'.padEnd(12)} │ Expires`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(30)}─┼─${'─'.repeat(12)}─┼─${'────────'}`);

    for (const k of items) {
      const perms = (k.permissions || []).slice(0, 3).join(', ') + ((k.permissions?.length || 0) > 3 ? '…' : '');
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : chalk.dim('never');
      const expires = k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : chalk.dim('never');
      console.log(`  ${k.id.padEnd(8)} │ ${k.name.padEnd(25)} │ ${perms.padEnd(30)} │ ${String(lastUsed).padEnd(12)} │ ${expires}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showApiKey(id: string): Promise<void> {
  try {
    const res = await get<ApiKeySummary>(`/api/api-keys/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Permissions: ${(data.permissions || []).join(', ') || 'all'}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Last used:   ${data.lastUsedAt ? new Date(data.lastUsedAt).toLocaleString() : 'never'}`);
    console.log(`  Expires:     ${data.expiresAt ? new Date(data.expiresAt).toLocaleString() : 'never'}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createApiKey(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.permissions) body.permissions = flags.permissions.split(',').map((p: string) => p.trim());
  if (flags?.expires) body.expiresAt = flags.expires;

  try {
    const res = await post<ApiKeyCreate>('/api/api-keys', body);
    console.log(chalk.yellow(`\n  ⚠ Store this key securely — it won't be shown again:`));
    console.log(chalk.bold(`  ${res.data.key}`));
    console.log();
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editApiKey(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.permissions) body.permissions = flags.permissions.split(',').map((p: string) => p.trim());
  if (flags?.expires) body.expiresAt = flags.expires;

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --permissions, --expires');
    return;
  }

  try {
    const res = await patch<ApiKeySummary>(`/api/api-keys/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteApiKey(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete API key ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/api-keys/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
