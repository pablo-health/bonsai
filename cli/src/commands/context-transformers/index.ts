import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success, truncate } from '../../utils/format.js';

interface ContextTransformer {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  prompt: string;
  contextFields: string[] | null;
  llmProviderId: string | null;
  llmSettings: Record<string, unknown>;
  tags: string[];
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listContextTransformers(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: ContextTransformer[]; total: number }>(`/api/projects/${projectId}/context-transformers`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'Provider'.padEnd(15)} │ Tags`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(15)}─┼─${'───────'}`);

    for (const ct of items) {
      const provider = ct.llmProviderId || '-';
      const tags = (ct.tags || []).join(', ') || '-';
      console.log(`  ${truncate(ct.id, 8)} │ ${truncate(ct.name, 25)} │ ${truncate(provider, 15)} │ ${tags}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showContextTransformer(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<ContextTransformer>(`/api/projects/${projectId}/context-transformers/${id}`);
    const { data } = res;
    console.log(`  ID:               ${data.id}`);
    console.log(`  Name:             ${data.name}`);
    console.log(`  Description:      ${dim(data.description ?? '')}`);
    console.log(`  LLM Provider:     ${data.llmProviderId || '-'}`);
    console.log(`  Context Fields:   ${(data.contextFields || []).join(', ') || '(all fields)'}`);
    console.log(`  Tags:             ${(data.tags || []).join(', ') || '-'}`);
    console.log(`  Prompt:`);
    console.log(`    ${truncate(data.prompt, 120)}`);
    console.log(`  Version:          ${data.version}`);
    console.log(`  Created:          ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:          ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createContextTransformer(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.llm_provider_id || flags?.llmProviderId) body.llmProviderId = flags.llm_provider_id || flags.llmProviderId;
  if (flags?.context_fields || flags?.contextFields) body.contextFields = flags.context_fields || flags.contextFields;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  if (!body.name || !body.prompt || !body.llmProviderId) {
    cliError('--name, --prompt, and --llm-provider-id are required');
    return;
  }

  try {
    const res = await post<ContextTransformer>(`/api/projects/${projectId}/context-transformers`, body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editContextTransformer(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};

  if (flags?.name) body.name = flags.name;
  if (flags?.description) body.description = flags.description;
  if (flags?.prompt) body.prompt = flags.prompt;
  if (flags?.llm_provider_id || flags?.llmProviderId) body.llmProviderId = flags.llm_provider_id || flags.llmProviderId;
  if (flags?.context_fields || flags?.contextFields) body.contextFields = flags.context_fields || flags.contextFields;
  if (flags?.tags) body.tags = flags.tags.split(',').map((t: string) => t.trim());

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<ContextTransformer>(`/api/projects/${projectId}/context-transformers/${id}`);
      body.version = res.data.version;
    } catch {
      cliError('Could not retrieve context transformer. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --description, --prompt, --llm-provider-id');
    return;
  }

  try {
    const res = await patch<ContextTransformer>(`/api/projects/${projectId}/context-transformers/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneContextTransformer(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;

  try {
    const res = await post<ContextTransformer>(`/api/projects/${projectId}/context-transformers/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteContextTransformer(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete context transformer ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await get<ContextTransformer>(`/api/projects/${projectId}/context-transformers/${id}`);
    const version = res.data.version;
    await del(`/api/projects/${projectId}/context-transformers/${id}`, { version });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
