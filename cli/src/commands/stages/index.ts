import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Stage {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listStages(search?: string): Promise<void> {
  try {
    const query: Record<string, string | undefined> = {};
    if (search) query.search = search;
    const res = await get<{ items: Stage[]; total: number }>('/api/stages', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(20)} │ ${'Description'.padEnd(40)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(20)}─┼─${'─'.repeat(40)}─┼─${'─'.repeat(20)}`);

    for (const s of items) {
      console.log(`  ${s.id.padEnd(8)} │ ${s.name.padEnd(20)} │ ${(s.description || '').padEnd(40)} │ ${(s.tags || []).join(', ')}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showStage(id: string): Promise<void> {
  try {
    const res = await get<Stage>(`/api/stages/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Description: ${dim(data.description ?? '')}`);
    console.log(`  Tags:        ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Prompt:      ${truncate(data.prompt, 100)}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createStage(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  try {
    const res = await post<Stage>('/api/stages', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editStage(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --description, --prompt');
    return;
  }

  try {
    const res = await patch<Stage>(`/api/stages/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneStage(id: string, newName?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<Stage>(`/api/stages/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteStage(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete stage ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/stages/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

function truncate(str: string | undefined, maxLen = 100): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '…';
}
