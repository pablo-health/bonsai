import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface User {
  id: string;
  projectId: string;
  profile: Record<string, unknown>;
  banned: boolean;
  banReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listUsers(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: User[]; total: number }>(`/api/projects/${projectId}/users`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Banned'.padEnd(8)} │ ${'Profile Keys'.padEnd(15)} │ Created`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(8)}─┼─${'─'.repeat(15)}─┼─${'────────────'}`);

    for (const u of items) {
      const banned = u.banned ? chalk.red('yes') : chalk.green('no');
      const keys = Object.keys(u.profile || {}).join(', ') || '-';
      console.log(`  ${u.id.padEnd(8)} │ ${banned.padEnd(8)} │ ${keys.padEnd(15)} │ ${new Date(u.createdAt).toLocaleDateString()}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showUser(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<User>(`/api/projects/${projectId}/users/${id}`);
    const { data } = res;
    console.log(`  ID:          ${data.id}`);
    console.log(`  Banned:      ${data.banned ? chalk.red('yes') : chalk.green('no')}`);
    if (data.banReason) console.log(`  Ban reason:  ${data.banReason}`);
    console.log(`  Profile:     ${JSON.stringify(data.profile, null, 2).split('\n').join('\n  ')}`);
    console.log(`  Created:     ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:     ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createUser(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.profile) {
    try {
      body.profile = JSON.parse(flags.profile);
    } catch {
      cliError('--profile must be valid JSON');
      return;
    }
  }

  if (!body.profile) {
    cliError('--profile is required (JSON object, e.g. --profile \'{"email":"user@example.com"}\')');
    return;
  }

  try {
    const res = await post<User>(`/api/projects/${projectId}/users`, body);
    success(`Created user: ${bold(res.data.id)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editUser(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.banned !== undefined) body.banned = flags.banned === 'true';
  if (flags?.banReason !== undefined) body.banReason = flags.banReason === '' ? null : flags.banReason;
  if (flags?.profile) {
    try {
      body.profile = JSON.parse(flags.profile);
    } catch {
      cliError('--profile must be valid JSON');
      return;
    }
  }

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --profile, --banned, --ban-reason');
    return;
  }

  try {
    const res = await patch<User>(`/api/projects/${projectId}/users/${id}`, body);
    success(`Updated user: ${bold(res.data.id)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteUser(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete user ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/projects/${projectId}/users/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
