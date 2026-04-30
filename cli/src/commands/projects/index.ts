import { get, post, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { table, truncate, dim, bold, error as cliError, success } from '../../utils/format.js';
import { setLastProjectId } from '../../config.js';

interface Project {
  id: string;
  name: string;
  description?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function listProjects(search?: string, archivedOnly?: boolean): Promise<void> {
  const query: Record<string, string | number | undefined> = {};
  if (search) query.search = search;
  if (archivedOnly) query.archived = 'true';

  try {
    const res = await get<{ items: Project[]; total: number; offset: number; limit: number }>(
      '/api/projects',
      { query }
    );

    const { data } = res;

    if (data.items.length === 0) {
      console.log('No projects found.');
      return;
    }

    table(
      data.items.map((p: Project) => [
        truncate(p.id, 8),
        p.name,
        truncate(p.description, 40),
        p.archived ? 'archived' : 'active',
      ]),
      ['ID', 'Name', 'Description', 'Status']
    );

    console.log(`\n${dim(`${data.total} total`)}`);
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}

export async function showProject(projectId: string): Promise<void> {
  try {
    const res = await get<Project>(`/api/projects/${projectId}`);
    const { data } = res;

    setLastProjectId(data.id);

    console.log(`  ID:          ${data.id}`);
    console.log(`  Name:        ${data.name}`);
    console.log(`  Description: ${dim(data.description ?? '')}`);
    console.log(`  Status:      ${data.archived ? 'archived' : 'active'}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}

export async function createProject(name: string, description?: string): Promise<void> {
  try {
    const res = await post<Project>('/api/projects', { name, description });
    const { data } = res;

    setLastProjectId(data.id);

    success(`Project created: ${bold(data.name)} (${data.id})`);
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}

export async function archiveProject(projectId: string): Promise<void> {
  try {
    await post(`/api/projects/${projectId}/archive`);
    success('Project archived.');
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete project ${dim(projectId)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await get(`/api/projects/${projectId}`); // verify exists
    await del(`/api/projects/${projectId}`);
    success('Project deleted.');
  } catch (err) {
    if (err instanceof Error) {
      cliError(err.message);
    }
    process.exit(1);
  }
}
