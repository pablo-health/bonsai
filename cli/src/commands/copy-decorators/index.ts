import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success, truncate } from '../../utils/format.js';

interface CopyDecorator {
  id: string;
  projectId: string;
  name: string;
  template: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listCopyDecorators(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: CopyDecorator[]; total: number }>(`/api/projects/${projectId}/copy-decorators`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ Template Preview`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'───────────────'}`);

    for (const cd of items) {
      const templatePreview = truncate(cd.template, 40);
      console.log(`  ${truncate(cd.id, 8)} │ ${truncate(cd.name, 25)} │ ${templatePreview}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showCopyDecorator(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<CopyDecorator>(`/api/projects/${projectId}/copy-decorators/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Template:`);
    console.log(`    ${truncate(data.template, 120)}`);
    console.log(`  Version:     ${data.version}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createCopyDecorator(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.template) body.template = flags.template;

  if (!body.name || !body.template) {
    cliError('--name and --template are required');
    return;
  }

  try {
    const res = await post<CopyDecorator>(`/api/projects/${projectId}/copy-decorators`, body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editCopyDecorator(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};

  if (flags?.name) body.name = flags.name;
  if (flags?.template) body.template = flags.template;

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<CopyDecorator>(`/api/projects/${projectId}/copy-decorators/${id}`);
      body.version = res.data.version;
    } catch {
      cliError('Could not retrieve copy decorator. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --template');
    return;
  }

  try {
    const res = await patch<CopyDecorator>(`/api/projects/${projectId}/copy-decorators/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteCopyDecorator(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete copy decorator ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await get<CopyDecorator>(`/api/projects/${projectId}/copy-decorators/${id}`);
    const version = res.data.version;
    await del(`/api/projects/${projectId}/copy-decorators/${id}`, { version });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
