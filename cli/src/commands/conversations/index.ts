import { get, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface ConversationEvent {
  id: string;
  conversationId: string;
  turnIndex: number;
  role: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export async function listConversations(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: any[]; total: number }>(`/api/projects/${projectId}/conversations`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Stage'.padEnd(36)} │ Status`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(36)}─┼─${'──────'}`);

    for (const conv of items) {
      const stageId = (conv as any).stageId || '-';
      const status = conv.status || '-';
      console.log(`  ${conv.id.padEnd(8)} │ ${stageId.substring(0, 36).padEnd(36)} │ ${status}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showConversation(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<any>(`/api/projects/${projectId}/conversations/${id}`);
    const { data } = res;
    console.log(`  ID:        ${data.id}`);
    console.log(`  Stage:     ${(data as any).stageId || '-'}`);
    console.log(`  Status:    ${data.status || '-'}`);
    console.log(`  Created:   ${new Date(data.createdAt).toLocaleString()}`);

    const eventsRes = await get<{ items: ConversationEvent[]; total: number }>(`/api/projects/${projectId}/conversations/${id}/events`, { query: { limit: '10', orderBy: 'createdAt', orderDir: 'asc' } });
    const { items: events, total: eventTotal } = eventsRes.data;

    if (events.length > 0) {
      console.log(`\n  Events (${eventTotal} total, showing 10):`);
      for (const evt of events) {
        const contentPreview = typeof evt.content === 'string' ? evt.content.substring(0, 50).replace(/\n/g, ' ') : '';
        console.log(`    [${evt.role}] ${contentPreview}${typeof evt.content === 'string' && evt.content.length > 50 ? '...' : ''}`);
      }
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteConversation(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete conversation ${dim(id)}? This cannot be undone.` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    await del(`/api/projects/${projectId}/conversations/${id}`);
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function listConversationEvents(projectId: string, conversationId: string): Promise<void> {
  try {
    const res = await get<{ items: ConversationEvent[]; total: number }>(`/api/projects/${projectId}/conversations/${conversationId}/events`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No events found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Turn'.padEnd(4)} │ ${'Role'.padEnd(10)} │ Time`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(4)}─┼─${'─'.repeat(10)}─┼─${'────────────'}`);

    for (const evt of items) {
      const contentPreview = typeof evt.content === 'string' ? evt.content.substring(0, 30).replace(/\n/g, ' ') : '';
      console.log(`  ${evt.id.padEnd(8)} │ ${String(evt.turnIndex).padEnd(4)} │ ${evt.role.padEnd(10)} │ ${contentPreview}${typeof evt.content === 'string' && evt.content.length > 30 ? '...' : ''}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showConversationEvent(projectId: string, conversationId: string, eventId: string): Promise<void> {
  try {
    const res = await get<ConversationEvent>(`/api/projects/${projectId}/conversations/${conversationId}/events/${eventId}`);
    const { data } = res;
    console.log(`  ID:        ${data.id}`);
    console.log(`  Turn:      ${data.turnIndex}`);
    console.log(`  Role:      ${data.role}`);
    if (typeof data.content === 'string') {
      console.log(`  Content:`);
      console.log(`    ${data.content.replace(/\n/g, '\n    ')}`);
    }
    console.log(`  Created:   ${new Date(data.createdAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function patchConversation(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.status) body.status = flags.status;
  if (flags?.stage) body.stageId = flags.stage;

  if (Object.keys(body).length === 0) {
    cliError('No fields to update. Provide at least one: --status, --stage');
    return;
  }

  try {
    const { patch } = await import('../../api/client.js');
    const res = await patch<any>(`/api/projects/${projectId}/conversations/${id}`, body);
    success(`Updated conversation: ${res.data.id}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
