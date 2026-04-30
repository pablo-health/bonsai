import { get, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface Secret {
  id: string;
  ref: string;
  createdAt: string;
  updatedAt: string;
}

export async function listSecrets(): Promise<void> {
  try {
    const res = await get<{ items: Secret[]; orphans: string[] }>('/api/secrets');
    const { data } = res;

    if (data.items.length === 0) { console.log('No secrets found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Ref'.padEnd(30)} │ Created`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(30)}─┼─${'────────────'}`);

    for (const s of data.items) {
      console.log(`  ${s.id.padEnd(8)} │ ${s.ref.padEnd(30)} │ ${new Date(s.createdAt).toLocaleDateString()}`);
    }

    if (data.orphans.length > 0) {
      console.log(`\n  ${chalk.yellow(`${data.orphans.length} orphaned secret(s)`)}`);
      for (const o of data.orphans.slice(0, 10)) {
        console.log(`    ⚠ ${o}`);
      }
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showSecretValue(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Reveal secret value for ${dim(id)}? This is restricted to super_admin.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await get<{ id: string; value: string }>(`/api/secrets/${id}/value`);
    console.log(chalk.yellow(`\n  ⚠ Secret value:`));
    console.log(chalk.bold(`  ${res.data.value}`));
    console.log();
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteSecret(id: string): Promise<void> {
  const confirmed = await c.confirm({
    message: `Delete secret ${dim(id)}? This cannot be undone.`,
  });

  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/secrets/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
