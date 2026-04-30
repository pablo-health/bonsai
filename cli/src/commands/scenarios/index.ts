import { get, post, put, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Scenario {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  language: string;
  startingStageId: string;
  maxTurns: number;
  endingStageIds: string[];
  personaCanHangUp: boolean;
  conversationOpener: string | null;
  dataExtraction: unknown[] | null;
  contextTransformerId: string | null;
  dataPostProcessingExpected: Record<string, unknown> | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listScenarios(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: Scenario[]; total: number }>(`/api/projects/${projectId}/scenarios`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'Language'.padEnd(10)} │ Turns`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(10)}─┼─${'─────'}`);

    for (const s of items) {
      console.log(`  ${s.id.padEnd(8)} │ ${s.name.padEnd(25)} │ ${s.language.padEnd(10)} │ ${s.maxTurns}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showScenario(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<Scenario>(`/api/projects/${projectId}/scenarios/${id}`);
    const { data } = res;
    console.log(`  ID:                      ${data.id}`);
    console.log(`  Name:                    ${data.name}`);
    console.log(`  Description:             ${dim(data.description ?? '')}`);
    console.log(`  Language:                ${data.language}`);
    console.log(`  Starting Stage:          ${data.startingStageId}`);
    console.log(`  Max Turns:               ${data.maxTurns}`);
    console.log(`  Ending Stages:           ${(data.endingStageIds || []).join(', ') || '-'}`);
    console.log(`  Hang Up Allowed:         ${data.personaCanHangUp ? 'yes' : 'no'}`);
    console.log(`  Tags:                    ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Version:                 ${data.version}`);
    console.log(`  Created:                 ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:                 ${new Date(data.updatedAt).toLocaleString()}`);

    if (data.conversationOpener) {
      console.log(`\n  Conversation Opener:`);
      console.log(`    ${data.conversationOpener}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createScenario(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.language) body.language = flags.language;
  if (flags?.startingStage) body.startingStageId = flags.startingStage;
  if (flags?.maxTurns) body.maxTurns = parseInt(flags.maxTurns, 10);
  if (flags?.endingStages) body.endingStageIds = flags.endingStages.split(',').map((s: string) => s.trim());
  if (flags?.hangUp !== undefined) body.personaCanHangUp = flags.hangUp === 'true';
  if (flags?.opener) body.conversationOpener = flags.opener;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (!body.name || !body.language || !body.startingStageId || !body.maxTurns) {
    cliError('--name, --language, --starting-stage, and --max-turns are required');
    return;
  }

  try {
    const res = await post<Scenario>(`/api/projects/${projectId}/scenarios`, body);
    success(`Created scenario: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editScenario(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.language) body.language = flags.language;
  if (flags?.startingStage) body.startingStageId = flags.startingStage;
  if (flags?.maxTurns) body.maxTurns = parseInt(flags.maxTurns, 10);
  if (flags?.endingStages) body.endingStageIds = flags.endingStages.split(',').map((s: string) => s.trim());
  if (flags?.hangUp !== undefined) body.personaCanHangUp = flags.hangUp === 'true';
  if (flags?.opener) body.conversationOpener = flags.opener;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<Scenario>(`/api/projects/${projectId}/scenarios/${id}`);
      body.version = res.data.version;
    } catch (err) {
      cliError('Could not retrieve scenario. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --language, --starting-stage, etc.');
    return;
  }

  try {
    const res = await put<Scenario>(`/api/projects/${projectId}/scenarios/${id}`, body);
    success(`Updated scenario: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteScenario(projectId: string, id: string): Promise<void> {
  const version = await c.text({
    message: `Enter the current version number for ${dim(id)} (found in 'scenarios show <id>')`,
    validate: (val) => {
      if (!val || isNaN(parseInt(val, 10))) return 'Version must be a number';
    },
  });

  if (c.isCancel(version)) return;

  try {
    await del(`/api/projects/${projectId}/scenarios/${id}`, { body: { version: parseInt(version, 10) } });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
