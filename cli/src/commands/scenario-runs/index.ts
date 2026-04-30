import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface ScenarioRun {
  id: string;
  projectId: string;
  scenarioId: string;
  testers: Record<string, number>;
  totalConversations: number;
  status: 'queued' | 'in_progress' | 'passed' | 'failed' | 'cancelled';
  statusDetails: string | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listScenarioRuns(projectId: string, scenarioId?: string): Promise<void> {
  try {
    const query = scenarioId ? { filters: JSON.stringify({ scenarioId: { eq: scenarioId } }) } : {};
    const res = await get<{ items: ScenarioRun[]; total: number }>(`/api/projects/${projectId}/scenario-runs`, { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Scenario'.padEnd(8)} │ ${'Status'.padEnd(14)} │ Conv.`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(8)}─┼─${'─'.repeat(14)}─┼─${'─────'}`);

    for (const run of items) {
      const statusColor = run.status === 'passed' ? chalk.green : run.status === 'failed' ? chalk.red : run.status === 'in_progress' ? chalk.yellow : chalk.dim;
      console.log(`  ${run.id.padEnd(8)} │ ${run.scenarioId.substring(0, 8).padEnd(8)} │ ${statusColor(run.status).padEnd(14)} │ ${run.totalConversations}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showScenarioRun(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<ScenarioRun>(`/api/projects/${projectId}/scenario-runs/${id}`);
    const { data } = res;
    console.log(`  ID:                  ${data.id}`);
    console.log(`  Scenario:            ${data.scenarioId}`);
    console.log(`  Status:              ${data.status}`);
    if (data.statusDetails) console.log(`  Details:             ${data.statusDetails}`);
    console.log(`  Total Conversations: ${data.totalConversations}`);
    console.log(`  Testers:`);
    for (const [testerId, count] of Object.entries(data.testers)) {
      console.log(`    - ${testerId}: ${count} conversation(s)`);
    }
    if (data.metadata) console.log(`  Metadata:            ${JSON.stringify(data.metadata)}`);
    console.log(`  Created:             ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:             ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createScenarioRun(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.scenario) body.scenarioId = flags.scenario;
  if (flags?.testers) {
    try {
      body.testers = JSON.parse(flags.testers);
    } catch {
      cliError('--testers must be valid JSON object, e.g. \'{"tester_id": 5}\'');
      return;
    }
  }

  if (!body.scenarioId || !body.testers) {
    cliError('--scenario and --testers are required (--testers format: \'{"tester_id": count}\')');
    return;
  }

  try {
    const res = await post<ScenarioRun>(`/api/projects/${projectId}/scenario-runs`, body);
    success(`Created run: ${bold(res.data.id)} (status: ${res.data.status}, ${res.data.totalConversations} conversations)`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cancelScenarioRun(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Cancel scenario run ${dim(id)}?`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await patch<ScenarioRun>(`/api/projects/${projectId}/scenario-runs/${id}`, { status: 'cancelled' });
    success(`Cancelled run: ${bold(res.data.id)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteScenarioRun(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete scenario run ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/projects/${projectId}/scenario-runs/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
