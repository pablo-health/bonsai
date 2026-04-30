import { get, post } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface MigrationPreview {
  totalCount: number;
  providers: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  classifiers: { id: string; name: string }[];
  contextTransformers: { id: string; name: string }[];
  tools: { id: string; name: string }[];
  globalActions: { id: string; name: string }[];
  knowledgeCategories: { id: string; name: string }[];
  knowledgeItems: { id: string; name: string }[];
  stages: { id: string; name: string }[];
  apiKeys: { id: string; name: string }[];
  testers: { id: string; name: string }[];
  scenarios: { id: string; name: string }[];
}

interface MigrationJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  environmentId: string;
  dryRun: boolean;
  startedAt: string;
  completedAt: string | null;
  result: { upserted: { entity: string; count: number }[]; schemaHashMatch: boolean; dryRun: boolean; durationMs: number } | null;
  error: string | null;
}

export async function preview(flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.projects) query.projectIds = flags.projects;
  if (flags?.stages) query.stageIds = flags.stages;
  if (flags?.agents) query.agentIds = flags.agents;
  if (flags?.classifiers) query.classifierIds = flags.classifiers;
  if (flags?.tools) query.toolIds = flags.tools;

  try {
    const res = await get<MigrationPreview>('/api/migration/preview', { query });
    const { data } = res;

    console.log(`  Total entities: ${data.totalCount}`);
    console.log('');

    const sections: { name: string; items: { id: string; name: string }[] }[] = [
      { name: 'Providers', items: data.providers },
      { name: 'Projects', items: data.projects },
      { name: 'Agents', items: data.agents },
      { name: 'Classifiers', items: data.classifiers },
      { name: 'Context Transformers', items: data.contextTransformers },
      { name: 'Tools', items: data.tools },
      { name: 'Global Actions', items: data.globalActions },
      { name: 'Knowledge Categories', items: data.knowledgeCategories },
      { name: 'Knowledge Items', items: data.knowledgeItems },
      { name: 'Stages', items: data.stages },
      { name: 'API Keys', items: data.apiKeys },
      { name: 'Testers', items: data.testers },
      { name: 'Scenarios', items: data.scenarios },
    ];

    for (const section of sections) {
      console.log(`  ${chalk.bold(section.name)}: ${section.items.length}`);
      for (const item of section.items.slice(0, 5)) {
        console.log(`    - ${item.id}${item.name ? ` (${dim(item.name)})` : ''}`);
      }
      if (section.items.length > 5) console.log(`    ... and ${section.items.length - 5} more`);
      console.log('');
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function exportBundle(flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.projects) query.projectIds = flags.projects;
  if (flags?.stages) query.stageIds = flags.stages;
  if (flags?.agents) query.agentIds = flags.agents;

  try {
    const res = await get<Record<string, unknown>>('/api/migration/export', { query });
    console.log(chalk.yellow('\n  Export bundle received. This is a large JSON payload intended for server-to-server migration.'));
    console.log(`  Keys: ${Object.keys(res.data).join(', ')}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function pull(environmentId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.dryRun !== undefined) body.dryRun = flags.dryRun === 'true';
  if (flags?.force !== undefined) body.force = flags.force === 'true';

  const confirmed = await c.confirm({
    message: `Pull migration from environment ${dim(environmentId)}?${body.dryRun ? ' (dry run)' : ''}`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await post<MigrationJob>(`/api/environments/${environmentId}/migration/pull`, body);
    console.log(`  Job ID:          ${res.data.id}`);
    console.log(`  Status:          ${res.data.status}`);
    console.log(`  Dry Run:         ${res.data.dryRun ? 'yes' : 'no'}`);

    if (res.data.result) {
      const r = res.data.result;
      console.log(`  Schema Match:    ${r.schemaHashMatch ? chalk.green('yes') : chalk.red('no')}`);
      console.log(`  Duration:        ${r.durationMs}ms`);
      console.log(`  Upserted:`);
      for (const u of r.upserted) {
        console.log(`    - ${u.entity}: ${u.count}`);
      }
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
