import { get, post, patch, del } from '../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { table, truncate, dim, bold, error as cliError, success } from './format.js';

export interface BaseEntity {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

interface ListFlags {
  search?: string;
  json?: boolean;
}

interface CreateFlags {
  name: string;
  description?: string;
  [key: string]: string | undefined;
}

export async function listResource<T extends BaseEntity>(
  basePath: string,
  fields: (item: T) => string[],
  columnHeaders: string[],
  flags?: ListFlags
): Promise<void> {
  const query: Record<string, string | number | undefined> = {};
  if (flags?.search) query.search = flags.search;

  try {
    const res = await get<PaginatedResponse<T>>(basePath, { query });
    const { data } = res;

    if (flags?.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.items.length === 0) {
      console.log('No results found.');
      return;
    }

    table(data.items.map(item => fields(item)), columnHeaders);
    console.log(`\n${dim(`${data.total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showResource<T extends BaseEntity>(basePath: string, id: string): Promise<void> {
  try {
    const res = await get<T>(`${basePath}/${id}`);
    const data = res.data;
    printEntity(data);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createResource<T extends BaseEntity>(
  basePath: string,
  buildBody: (flags: CreateFlags) => Record<string, unknown>,
  flags?: CreateFlags
): Promise<T | null> {
  if (!flags?.name) {
    cliError('--name is required');
    return null;
  }

  try {
    const res = await post<T>(basePath, buildBody(flags));
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
    return res.data;
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
    return null;
  }
}

export async function editResource<T extends BaseEntity>(
  basePath: string, id: string, buildBody: (flags: CreateFlags) => Record<string, unknown>,
  flags?: Partial<CreateFlags>
): Promise<void> {
  try {
    const body = buildBody((flags ?? {}) as CreateFlags);
    if (Object.keys(body).length === 0) {
      cliError('No fields to update. Provide at least one: --name, --description');
      return;
    }
    const res = await patch<T>(`${basePath}/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneResource<T extends BaseEntity>(
  basePath: string, id: string, newName?: string
): Promise<T | null> {
  try {
    const body: Record<string, unknown> = {};
    if (newName) body.name = newName;
    const res = await post<T>(`${basePath}/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
    return res.data;
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
    return null;
  }
}

export async function deleteResource(basePath: string, id: string): Promise<boolean> {
  const confirmed = await c.confirm({
    message: `Delete ${chalk.dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return false;

  try {
    await del(`${basePath}/${id}`);
    success('Deleted.');
    return true;
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    return false;
  }
}

function printEntity(data: BaseEntity): void {
  console.log(`  ID:          ${data.id}`);
  console.log(`  Name:        ${data.name}`);
  console.log(`  Description: ${dim(data.description ?? '')}`);
  console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
  console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
}
