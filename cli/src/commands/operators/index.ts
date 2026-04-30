import { get, post, put, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Operator {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listOperators(): Promise<void> {
  try {
    const res = await get<{ items: Operator[]; total: number }>('/api/operators');
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Email'.padEnd(30)} │ Name`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(30)}─┼─${'────'}`);

    for (const op of items) {
      const name = op.name || '-';
      console.log(`  ${op.id.padEnd(8)} │ ${op.email.padEnd(30)} │ ${name}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showOperator(id: string): Promise<void> {
  try {
    const res = await get<Operator>(`/api/operators/${id}`);
    const { data } = res;
    console.log(`  ID:        ${data.id}`);
    console.log(`  Email:     ${data.email}`);
    console.log(`  Name:      ${data.name || '-'}`);
    console.log(`  Roles:     ${(data.roles || []).join(', ') || '-'}`);
    console.log(`  Version:   ${data.version}`);
    console.log(`  Created:   ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:   ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createOperator(flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.email) body.email = flags.email;
  if (flags?.password) body.password = flags.password;
  if (flags?.name) body.name = flags.name;
  if (flags?.roles) body.roles = flags.roles.split(',').map((r: string) => r.trim());

  if (!body.email || !body.password) {
    cliError('--email and --password are required');
    return;
  }

  try {
    const res = await post<Operator>('/api/operators', body);
    success(`Created operator: ${bold(res.data.email)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editOperator(id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.email) body.email = flags.email;
  if (flags?.password) body.password = flags.password;
  if (flags?.name) body.name = flags.name;
  if (flags?.roles) body.roles = flags.roles.split(',').map((r: string) => r.trim());

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<Operator>(`/api/operators/${id}`);
      body.version = res.data.version;
    } catch (err) {
      cliError('Could not retrieve operator. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --email, --password, --name, --roles');
    return;
  }

  try {
    const res = await put<Operator>(`/api/operators/${id}`, body);
    success(`Updated operator: ${bold(res.data.email)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteOperator(id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete operator ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/operators/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
