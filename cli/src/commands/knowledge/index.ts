import { get, post, put, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface KnowledgeCategory {
  id: string;
  projectId: string;
  triggerPhrase: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  items?: KnowledgeItem[];
}

interface KnowledgeItem {
  id: string;
  categoryId: string;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listCategories(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: KnowledgeCategory[]; total: number }>(`/api/projects/${projectId}/knowledge/categories`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Trigger Phrase'.padEnd(25)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'────'}`);

    for (const cat of items) {
      console.log(`  ${cat.id.padEnd(8)} │ ${cat.triggerPhrase.padEnd(25)} │ ${(cat.tags || []).join(', ') || '-'}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showCategory(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<KnowledgeCategory>(`/api/projects/${projectId}/knowledge/categories/${id}`);
    const { data } = res;

    console.log(`  ID:              ${data.id}`);
    console.log(`  Trigger Phrase:  ${data.triggerPhrase}`);
    console.log(`  Tags:            ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Version:         ${data.version}`);
    console.log(`  Created:         ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:         ${new Date(data.updatedAt).toLocaleString()}`);

    if (data.items && data.items.length > 0) {
      console.log(`\n  Items (${data.items.length}):`);
      for (const item of data.items.slice(0, 5)) {
        const preview = item.content.substring(0, 60).replace(/\n/g, ' ');
        console.log(`    ${item.id} - "${preview}..."`);
      }
      if (data.items.length > 5) console.log(`    ... and ${data.items.length - 5} more`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createCategory(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  const trigger = flags?.trigger || flags?.triggerPhrase;
  if (trigger) body.triggerPhrase = trigger;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (!body.triggerPhrase) {
    cliError('--trigger or --trigger-phrase is required');
    return;
  }

  try {
    const res = await post<KnowledgeCategory>(`/api/projects/${projectId}/knowledge/categories`, body);
    success(`Created: ${bold(res.data.triggerPhrase)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editCategory(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  const trigger = flags?.trigger || flags?.triggerPhrase;
  if (trigger) body.triggerPhrase = trigger;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<KnowledgeCategory>(`/api/projects/${projectId}/knowledge/categories/${id}`);
      body.version = res.data.version;
    } catch (err) {
      cliError('Could not retrieve category. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --trigger-phrase, --tags');
    return;
  }

  try {
    const res = await put<KnowledgeCategory>(`/api/projects/${projectId}/knowledge/categories/${id}`, body);
    success(`Updated: ${bold(res.data.triggerPhrase)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteCategory(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete knowledge category ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/projects/${projectId}/knowledge/categories/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function listItems(projectId: string, categoryId?: string): Promise<void> {
  if (!categoryId) { cliError('--category is required'); return; }
  try {
    const res = await get<{ items: KnowledgeItem[]; total: number }>(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Content Preview'}`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─────────────'}`);

    for (const item of items) {
      const preview = item.content.substring(0, 70).replace(/\n/g, ' ');
      console.log(`  ${item.id.padEnd(8)} │ ${preview}${item.content.length > 70 ? '...' : ''}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showItem(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const categoryId = flags?.category;
  if (!categoryId) { cliError('--category is required'); return; }
  try {
    const res = await get<KnowledgeItem>(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items/${id}`);
    const { data } = res;

    console.log(`  ID:              ${data.id}`);
    console.log(`  Category:        ${data.categoryId}`);
    console.log(`  Content:`);
    console.log(`    ${data.content.replace(/\n/g, '\n    ')}`);
    console.log(`\n  Version:         ${data.version}`);
    console.log(`  Created:         ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:         ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createItem(projectId: string, flags?: Record<string, string>): Promise<void> {
  const categoryId = flags?.category;
  if (!categoryId) { cliError('--category is required'); return; }
  const body: Record<string, unknown> = {};
  if (flags?.content) body.content = flags.content;

  if (!body.content) {
    cliError('--content is required');
    return;
  }

  try {
    const res = await post<KnowledgeItem>(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items`, body);
    success(`Created item: ${res.data.id}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editItem(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const categoryId = flags?.category;
  if (!categoryId) { cliError('--category is required'); return; }
  const body: Record<string, unknown> = {};
  if (flags?.content) body.content = flags.content;

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<KnowledgeItem>(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items/${id}`);
      body.version = res.data.version;
    } catch (err) {
      cliError('Could not retrieve item. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --content');
    return;
  }

  try {
    const res = await put<KnowledgeItem>(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items/${id}`, body);
    success(`Updated item: ${res.data.id}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteItem(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const categoryId = flags?.category;
  if (!categoryId) { cliError('--category is required'); return; }
  const confirmed = await c.confirm({ message: `Delete knowledge item ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/projects/${projectId}/knowledge/categories/${categoryId}/items/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
