import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Guardrail {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listGuardrails(search?: string): Promise<void> {
  try {
    const query: Record<string, string | undefined> = {};
    if (search) query.search = search;
    const res = await get<{ items: Guardrail[]; total: number }>('/api/guardrails', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(20)} │ ${'Description'.padEnd(40)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(20)}─┼─${'─'.repeat(40)}─┼─${'─'.repeat(20)}`);

    for (const g of items) {
      console.log(`  ${g.id.padEnd(8)} │ ${g.name.padEnd(20)} │ ${(g.description || '').padEnd(40)} │ ${(g.tags || []).join(', ')}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showGuardrail(id: string): Promise<void> {
  try {
    const res = await get<Guardrail>(`/api/guardrails/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Description: ${dim(data.description ?? '')}`);
    console.log(`  Tags:        ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createGuardrail(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  try {
    const res = await post<Guardrail>('/api/guardrails', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editGuardrail(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --name, --description');
    return;
  }

  try {
    const res = await patch<Guardrail>(`/api/guardrails/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneGuardrail(id: string, newName?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<Guardrail>(`/api/guardrails/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteGuardrail(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete guardrail ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/guardrails/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
