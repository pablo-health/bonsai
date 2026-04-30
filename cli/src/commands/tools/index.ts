import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Tool {
  id: string;
  name: string;
  description?: string;
  type: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listTools(search?: string): Promise<void> {
  try {
    const query: Record<string, string | undefined> = {};
    if (search) query.search = search;
    const res = await get<{ items: Tool[]; total: number }>('/api/tools', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(20)} │ ${'Type'.padEnd(15)} │ ${'Description'.padEnd(40)}`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(20)}─┼─${'─'.repeat(15)}─┼─${'─'.repeat(40)}`);

    for (const t of items) {
      console.log(`  ${t.id.padEnd(8)} │ ${t.name.padEnd(20)} │ ${t.type.padEnd(15)} │ ${(t.description || '').padEnd(40)}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showTool(id: string): Promise<void> {
  try {
    const res = await get<Tool>(`/api/tools/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Type:        ${data.type}`);
    console.log(`  Description: ${dim(data.description ?? '')}`);
    console.log(`  Tags:        ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createTool(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.type) body.type = flags.type;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  try {
    const res = await post<Tool>('/api/tools', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editTool(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.type) body.type = flags.type;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --description, --type');
    return;
  }

  try {
    const res = await patch<Tool>(`/api/tools/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneTool(id: string, newName?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<Tool>(`/api/tools/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteTool(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete tool ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/tools/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
