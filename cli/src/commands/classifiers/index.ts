import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Classifier {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export async function listClassifiers(search?: string): Promise<void> {
  try {
    const query: Record<string, string | undefined> = {};
    if (search) query.search = search;
    const res = await get<{ items: Classifier[]; total: number }>('/api/classifiers', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(20)} │ ${'Description'.padEnd(40)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(20)}─┼─${'─'.repeat(40)}─┼─${'─'.repeat(20)}`);

    for (const c of items) {
      console.log(`  ${c.id.padEnd(8)} │ ${c.name.padEnd(20)} │ ${(c.description || '').padEnd(40)} │ ${(c.tags || []).join(', ')}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showClassifier(id: string): Promise<void> {
  try {
    const res = await get<Classifier>(`/api/classifiers/${id}`);
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

export async function createClassifier(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  try {
    const res = await post<Classifier>('/api/classifiers', body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editClassifier(id: string, flags?: Record<string, string>): Promise<void> {
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
    const res = await patch<Classifier>(`/api/classifiers/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneClassifier(id: string, newName?: string): Promise<void> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<Classifier>(`/api/classifiers/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteClassifier(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete classifier ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/classifiers/${id}`);
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
