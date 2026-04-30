import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success, truncate } from '../../utils/format.js';

interface SavedSliceQuery {
  id: string;
  name: string;
  projectId: string;
  operatorId: string | null;
  query: Record<string, unknown>;
  isShared: boolean;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listSavedSliceQueries(projectId: string): Promise<void> {
  try {
    const res = await get<SavedSliceQuery[]>(`/api/projects/${projectId}/analytics/saved-queries`);
    const items = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ Shared │ Created`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'──────'}─┼─${'────────'}`);

    for (const sq of items) {
      const shared = sq.isShared ? 'yes' : 'no';
      const created = new Date(sq.createdAt).toLocaleDateString();
      console.log(`  ${truncate(sq.id, 8)} │ ${truncate(sq.name, 25)} │ ${shared.padEnd(6)} │ ${created}`);
    }

    console.log(`\n${dim(`${items.length} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showSavedSliceQuery(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<SavedSliceQuery[]>(`/api/projects/${projectId}/analytics/saved-queries`);
    const query = res.data.find((q: SavedSliceQuery) => q.id === id);

    if (!query) {
      cliError('Saved slice query not found.');
      return;
    }

    console.log(`  ID:          ${query.id}`);
    console.log(`  Name:        ${query.name}`);
    console.log(`  Shared:      ${query.isShared ? 'yes' : 'no'}`);
    console.log(`  Query:`);
    console.log(`    ${truncate(JSON.stringify(query.query), 120)}`);
    if (query.metadata) {
      console.log(`  Metadata:`);
      console.log(`    ${truncate(JSON.stringify(query.metadata), 120)}`);
    }
    console.log(`  Version:     ${query.version}`);
    console.log(`  Created:     ${new Date(query.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(query.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createSavedSliceQuery(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.query) body.query = JSON.parse(flags.query);
  if (flags?.shared !== undefined) body.isShared = flags.shared === 'true';
  if (flags?.metadata) body.metadata = JSON.parse(flags.metadata);

  if (!body.name || !body.query) {
    cliError('--name and --query are required (--query must be valid JSON)');
    return;
  }

  try {
    const res = await post<SavedSliceQuery>(`/api/projects/${projectId}/analytics/saved-queries`, body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editSavedSliceQuery(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};

  if (flags?.name) body.name = flags.name;
  if (flags?.query) body.query = JSON.parse(flags.query);
  if (flags?.shared !== undefined) body.isShared = flags.shared === 'true';
  if (flags?.metadata) body.metadata = JSON.parse(flags.metadata);

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<SavedSliceQuery[]>(`/api/projects/${projectId}/analytics/saved-queries`);
      const query = res.data.find((q: SavedSliceQuery) => q.id === id);
      if (!query) {
        cliError('Saved slice query not found.');
        return;
      }
      body.version = query.version;
    } catch (err) {
      cliError('Could not retrieve saved slice query. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --query, --shared');
    return;
  }

  try {
    const res = await patch<SavedSliceQuery>(`/api/projects/${projectId}/analytics/saved-queries/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteSavedSliceQuery(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete saved slice query ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await get<SavedSliceQuery[]>(`/api/projects/${projectId}/analytics/saved-queries`);
    const query = res.data.find((q: SavedSliceQuery) => q.id === id);
    if (!query) {
      cliError('Saved slice query not found.');
      return;
    }
    await del(`/api/projects/${projectId}/analytics/saved-queries/${id}`, { version: query.version });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
