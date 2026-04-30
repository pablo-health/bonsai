import { get, post, put, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Issue {
  id: number;
  projectId: string;
  environment: string;
  buildVersion: string;
  stage: string | null;
  conversationId: string | null;
  eventIndex: number | null;
  userId: string | null;
  severity: string;
  category: string;
  bugDescription: string;
  expectedBehaviour: string;
  comments: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function listIssues(projectId?: string): Promise<void> {
  try {
    const query = projectId ? { filters: JSON.stringify({ projectId: { eq: projectId } }) } : {};
    const res = await get<{ items: Issue[]; total: number }>('/api/issues', { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(4)} │ ${'Severity'.padEnd(10)} │ ${'Category'.padEnd(15)} │ Status`);
    console.log(`  ${'─'.repeat(4)}─┼─${'─'.repeat(10)}─┼─${'─'.repeat(15)}─┼─${'────────────'}`);

    for (const issue of items) {
      const sevColor = issue.severity === 'critical' ? chalk.red : issue.severity === 'high' ? chalk.yellow : chalk.dim;
      console.log(`  ${String(issue.id).padEnd(4)} │ ${sevColor(issue.severity).padEnd(10)} │ ${issue.category.padEnd(15)} │ ${issue.status}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showIssue(id: string): Promise<void> {
  try {
    const res = await get<Issue>(`/api/issues/${id}`);
    const { data } = res;
    console.log(`  ID:              ${data.id}`);
    console.log(`  Project:         ${data.projectId}`);
    console.log(`  Severity:        ${data.severity}`);
    console.log(`  Category:        ${data.category}`);
    console.log(`  Status:          ${data.status}`);
    console.log(`  Environment:     ${data.environment}`);
    console.log(`  Build Version:   ${data.buildVersion}`);
    if (data.stage) console.log(`  Stage:           ${data.stage}`);
    if (data.conversationId) console.log(`  Conversation:    ${data.conversationId}`);
    console.log(`  Description:`);
    console.log(`    ${data.bugDescription.split('\n').join('\n    ')}`);
    console.log(`  Expected:`);
    console.log(`    ${data.expectedBehaviour.split('\n').join('\n    ')}`);
    if (data.comments) {
      console.log(`  Comments:`);
      console.log(`    ${data.comments.split('\n').join('\n    ')}`);
    }
    console.log(`  Created:         ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:         ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createIssue(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  body.projectId = projectId;

  for (const flag of ['--environment', '--build-version', '--severity', '--category', '--status']) {
    const val = getFlag(flags, flag);
    if (val) body[flag.replace('--', '').replace('-', '')] = val;
  }
  if (flags?.['--bug-description']) body.bugDescription = flags['--bug-description'];
  if (flags?.['--expected-behaviour']) body.expectedBehaviour = flags['--expected-behaviour'];
  if (flags?.['--comments']) body.comments = flags['--comments'];

  try {
    const res = await post<Issue>(`/api/projects/${projectId}/issues`, body);
    success(`Created issue #${res.data.id}: ${bold(res.data.category)} (${res.data.severity})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editIssue(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};

  for (const flag of ['--environment', '--build-version', '--severity', '--category', '--status']) {
    const val = getFlag(flags, flag);
    if (val) body[flag.replace('--', '').replace('-', '')] = val;
  }
  if (flags?.['--bug-description']) body.bugDescription = flags['--bug-description'];
  if (flags?.['--expected-behaviour']) body.expectedBehaviour = flags['--expected-behaviour'];
  if (flags?.['--comments']) body.comments = flags['--comments'];
  if (flags?.stage) body.stage = flags.stage;
  if (flags?.conversationId) body.conversationId = flags.conversationId;

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --severity, --status, --category, --bug-description, etc.');
    return;
  }

  try {
    const res = await put<Issue>(`/api/issues/${id}`, body);
    success(`Updated issue #${res.data.id}: ${bold(res.data.status)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

function getFlag(flags: Record<string, string> | undefined, flag: string): string | undefined {
  return flags?.[flag];
}
