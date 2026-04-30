import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Tester {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  prompt: string;
  hangUpPrompt: string | null;
  llmProviderId: string | null;
  llmSettings: Record<string, unknown>;
  userProfile: Record<string, unknown> | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listTesters(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: Tester[]; total: number }>(`/api/projects/${projectId}/testers`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'LLM Provider'.padEnd(20)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(20)}─┼─${'────────────'}`);

    for (const t of items) {
      const tags = (t.tags || []).join(',') || '-';
      console.log(`  ${t.id.padEnd(8)} │ ${t.name.padEnd(25)} │ ${(t.llmProviderId || '-').padEnd(20)} │ ${tags}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showTester(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<Tester>(`/api/projects/${projectId}/testers/${id}`);
    const { data } = res;
    console.log(`  ID:              ${data.id}`);
    console.log(`  Name:            ${data.name}`);
    console.log(`  Description:     ${dim(data.description ?? '')}`);
    console.log(`  LLM Provider:    ${data.llmProviderId || '-'}`);
    console.log(`  Tags:            ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Version:         ${data.version}`);
    console.log(`  Created:         ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:         ${new Date(data.updatedAt).toLocaleString()}`);

    if (data.prompt) {
      console.log(`\n  Prompt:`);
      console.log(`    ${data.prompt.split('\n').slice(0, 5).join('\n    ')}`);
      if (data.prompt.split('\n').length > 5) console.log(`    ... (${data.prompt.split('\n').length} lines total)`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createTester(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.hangUpPrompt) body.hangUpPrompt = flags.hangUpPrompt;
  if (flags?.llmProviderId) body.llmProviderId = flags.llmProviderId;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());
  if (flags?.userProfile) {
    try { body.userProfile = JSON.parse(flags.userProfile); } catch { cliError('--user-profile must be valid JSON'); return; }
  }

  if (!body.name || !body.prompt) {
    cliError('--name and --prompt are required');
    return;
  }

  try {
    const res = await post<Tester>(`/api/projects/${projectId}/testers`, body);
    success(`Created tester: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editTester(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.hangUpPrompt) body.hangUpPrompt = flags.hangUpPrompt;
  if (flags?.llmProviderId) body.llmProviderId = flags.llmProviderId;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());
  if (flags?.userProfile) {
    try { body.userProfile = JSON.parse(flags.userProfile); } catch { cliError('--user-profile must be valid JSON'); return; }
  }

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<Tester>(`/api/projects/${projectId}/testers/${id}`);
      body.version = res.data.version;
    } catch (err) {
      cliError('Could not retrieve tester. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --prompt, --tags');
    return;
  }

  try {
    const res = await patch<Tester>(`/api/projects/${projectId}/testers/${id}`, body);
    success(`Updated tester: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteTester(projectId: string, id: string): Promise<void> {
  const version = await c.text({
    message: `Enter the current version number for ${dim(id)} (found in 'testers show <id>')`,
    validate: (val) => {
      if (!val || isNaN(parseInt(val, 10))) return 'Version must be a number';
    },
  });

  if (c.isCancel(version)) return;

  try {
    await del(`/api/projects/${projectId}/testers/${id}`, { body: { version: parseInt(version, 10) } });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
