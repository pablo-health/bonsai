import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Provider {
  id: string;
  name: string;
  type: 'ASR' | 'TTS' | 'LLM' | 'Embeddings' | 'Storage' | 'Moderation';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listProviders(type?: string): Promise<void> {
  try {
    const query: Record<string, string | undefined> = {};
    if (type) query.type = type;
    const res = await get<{ items: Provider[]; total: number }>('/api/providers', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'Type'.padEnd(12)} │ Active`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(12)}─┼─${'──────'}`);

    for (const p of items) {
      const active = p.isActive ? chalk.green('yes') : chalk.dim('no');
      console.log(`  ${p.id.padEnd(8)} │ ${p.name.padEnd(25)} │ ${p.type.padEnd(12)} │ ${active}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showProvider(id: string): Promise<void> {
  try {
    const res = await get<Provider & { models?: unknown[] }>(`/api/providers/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Type:        ${data.type}`);
    console.log(`  Active:      ${data.isActive ? 'yes' : 'no'}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function listProviderModels(id: string): Promise<void> {
  try {
    const res = await get<{ models: { id: string; name?: string }[] }>(`/api/providers/${id}/models`);
    const { data } = res;

    if (data.models.length === 0) { console.log('No models available.'); return; }

    console.log(`  Models for ${bold(data.models[0]?.name || id)}:`);
    for (const m of data.models) {
      console.log(`    - ${m.id}${m.name ? ` (${dim(m.name)})` : ''}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createProvider(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.type) body.type = flags.type.toUpperCase();
  if (flags?.active !== undefined) body.isActive = flags.active === 'true';

  if (!body.name || !body.type) {
    cliError('--name and --type are required. Types: ASR, TTS, LLM, Embeddings, Storage, Moderation');
    return;
  }

  try {
    const res = await post<Provider>('/api/providers', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editProvider(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.type) body.type = flags.type.toUpperCase();
  if (flags?.active !== undefined) body.isActive = flags.active === 'true';

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --type, --active');
    return;
  }

  try {
    const res = await patch<Provider>(`/api/providers/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteProvider(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete provider ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/providers/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
