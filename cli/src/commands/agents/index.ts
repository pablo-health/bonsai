import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { listResource, showResource, createResource, editResource, cloneResource, deleteResource, BaseEntity, PaginatedResponse } from '../../utils/crud.js';
import { dim, bold, error as cliError, success, table, truncate } from '../../utils/format.js';

interface Agent extends BaseEntity {
  description?: string;
  prompt: string;
  tags?: string[];
}

export async function listAgents(search?: string): Promise<void> {
  await listResource<Agent>(
    '/api/agents',
    (a: Agent) => [truncate(a.id, 8), a.name, truncate(a.description, 40), (a.tags || []).join(', ')],
    ['ID', 'Name', 'Description', 'Tags']
  );
}

export async function showAgent(id: string): Promise<void> {
  try {
    const res = await get<Agent & { prompt: string; tags?: string[] }>(`/api/agents/${id}`);
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

export async function createAgent(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  try {
    const res = await post<Agent>('/api/agents', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editAgent(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --description, --prompt, --tags');
    return;
  }

  try {
    const res = await patch<Agent>(`/api/agents/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneAgent(id: string, newName?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<Agent>(`/api/agents/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteAgent(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete agent ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/agents/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
