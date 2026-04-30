import { get } from '../../api/client.js';
import chalk from 'chalk';
import { dim, bold, error as cliError } from '../../utils/format.js';

interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  entityId: string;
  entityType: string;
  projectId: string | null;
  oldEntity: Record<string, unknown> | null;
  newEntity: Record<string, unknown> | null;
  createdAt: string;
}

export async function listAuditLogs(flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.entityType) query.entityType = flags.entityType;
  if (flags?.action) query.action = flags.action;
  if (flags?.userId) query.userId = flags.userId;

  try {
    const res = await get<{ items: AuditLog[]; total: number }>(`/api/audit-logs`, { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Action'.padEnd(10)} │ ${'Entity Type'.padEnd(20)} │ Entity`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(10)}─┼─${'─'.repeat(20)}─┼─${'────────────'}`);

    for (const log of items) {
      const actionColor = log.action === 'CREATE' ? chalk.green : log.action === 'DELETE' ? chalk.red : chalk.yellow;
      console.log(`  ${log.id.padEnd(8)} │ ${actionColor(log.action).padEnd(10)} │ ${(log.entityType || '-').padEnd(20)} │ ${log.entityId.substring(0, 8)}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showAuditLog(id: string): Promise<void> {
  try {
    const res = await get<{ items: AuditLog[]; total: number }>(`/api/audit-logs`, { query: { filters: JSON.stringify({ entityId: { eq: id } }) } });
    const { items } = res.data;

    if (items.length === 0) { console.log('No audit log found.'); return; }

    const log = items[0];
    console.log(`  ID:            ${log.id}`);
    console.log(`  Action:        ${log.action}`);
    console.log(`  Entity Type:   ${log.entityType}`);
    console.log(`  Entity ID:     ${log.entityId}`);
    console.log(`  Project:       ${log.projectId || '-'}`);
    console.log(`  User:          ${log.userId || '-'}`);
    console.log(`  Timestamp:     ${new Date(log.createdAt).toLocaleString()}`);

    if (log.oldEntity) {
      console.log(`\n  Old Value:`);
      console.log(`    ${JSON.stringify(log.oldEntity, null, 2).split('\n').join('\n    ')}`);
    }
    if (log.newEntity) {
      console.log(`\n  New Value:`);
      console.log(`    ${JSON.stringify(log.newEntity, null, 2).split('\n').join('\n    ')}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
