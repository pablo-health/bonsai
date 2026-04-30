import { get, post, patch, del } from '../../api/client.js';
import * as c from '@clack/prompts';
import { dim, bold, error as cliError, success, truncate } from '../../utils/format.js';

interface SampleCopy {
  id: string;
  projectId: string;
  name: string;
  stages: string[] | null;
  agents: string[] | null;
  promptTrigger: string;
  classifierOverrideId: string | null;
  content: string[];
  amount: number;
  samplingMethod: 'random' | 'round_robin';
  mode: 'regular' | 'forced';
  decoratorId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listSampleCopies(projectId: string): Promise<void> {
  try {
    const res = await get<{ items: SampleCopy[]; total: number }>(`/api/projects/${projectId}/sample-copies`);
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Name'.padEnd(25)} │ ${'Trigger'.padEnd(20)} │ ${'Mode'.padEnd(10)} │ Content`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(25)}─┼─${'─'.repeat(20)}─┼─${'─'.repeat(10)}─┼─${'───────'}`);

    for (const sc of items) {
      const content = `${sc.content.length} variant(s)`;
      console.log(`  ${truncate(sc.id, 8)} │ ${truncate(sc.name, 25)} │ ${truncate(sc.promptTrigger, 20)} │ ${sc.mode.padEnd(10)} │ ${content}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showSampleCopy(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<SampleCopy>(`/api/projects/${projectId}/sample-copies/${id}`);
    const { data } = res;
    console.log(`  ID:                    ${data.id}`);
    console.log(`  Name:                  ${data.name}`);
    console.log(`  Trigger:               ${data.promptTrigger}`);
    console.log(`  Mode:                  ${data.mode}`);
    console.log(`  Sampling Method:       ${data.samplingMethod}`);
    console.log(`  Amount:                ${data.amount}`);
    console.log(`  Classifier Override:   ${data.classifierOverrideId || '(default)'}`);
    console.log(`  Decorator:             ${data.decoratorId || '(none)'}`);
    console.log(`  Stages:                ${(data.stages || []).join(', ') || '(all stages)'}`);
    console.log(`  Agents:                ${(data.agents || []).join(', ') || '(all agents)'}`);
    console.log(`  Content (${data.content.length} variants):`);
    for (const c of data.content) {
      console.log(`    - ${truncate(c, 120)}`);
    }
    console.log(`  Version:               ${data.version}`);
    console.log(`  Created:               ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:               ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function createSampleCopy(projectId: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;
  if (flags?.prompt_trigger || flags?.promptTrigger) body.promptTrigger = flags.prompt_trigger || flags.promptTrigger;
  if (flags?.content) body.content = [flags.content];
  if (flags?.amount) body.amount = parseInt(flags.amount, 10);
  if (flags?.sampling_method || flags?.samplingMethod) body.samplingMethod = flags.sampling_method || flags.samplingMethod;
  if (flags?.mode) body.mode = flags.mode;
  if (flags?.classifier_override_id || flags?.classifierOverrideId) body.classifierOverrideId = flags.classifier_override_id || flags.classifierOverrideId;
  if (flags?.decorator_id || flags?.decoratorId) body.decoratorId = flags.decorator_id || flags.decoratorId;
  if (flags?.stages) body.stages = flags.stages.split(',').map((s: string) => s.trim());
  if (flags?.agents) body.agents = flags.agents.split(',').map((a: string) => a.trim());

  if (!body.name || !body.promptTrigger || !body.content) {
    cliError('--name, --prompt-trigger, and --content are required');
    return;
  }

  try {
    const res = await post<SampleCopy>(`/api/projects/${projectId}/sample-copies`, body);
    success(`Created: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function editSampleCopy(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};

  if (flags?.name) body.name = flags.name;
  if (flags?.prompt_trigger || flags?.promptTrigger) body.promptTrigger = flags.prompt_trigger || flags.promptTrigger;
  if (flags?.content) body.content = [flags.content];
  if (flags?.amount) body.amount = parseInt(flags.amount, 10);
  if (flags?.sampling_method || flags?.samplingMethod) body.samplingMethod = flags.sampling_method || flags.samplingMethod;
  if (flags?.mode) body.mode = flags.mode;
  if (flags?.classifier_override_id || flags?.classifierOverrideId) body.classifierOverrideId = flags.classifier_override_id || flags.classifierOverrideId;
  if (flags?.decorator_id || flags?.decoratorId) body.decoratorId = flags.decorator_id || flags.decoratorId;
  if (flags?.stages) body.stages = flags.stages.split(',').map((s: string) => s.trim());
  if (flags?.agents) body.agents = flags.agents.split(',').map((a: string) => a.trim());

  const version = flags?.version ? parseInt(flags.version, 10) : undefined;
  if (!version) {
    try {
      const res = await get<SampleCopy>(`/api/projects/${projectId}/sample-copies/${id}`);
      body.version = res.data.version;
    } catch {
      cliError('Could not retrieve sample copy. Provide --version flag.');
      return;
    }
  } else {
    body.version = version;
  }

  if (Object.keys(body).length <= 1) {
    cliError('No fields to update. Provide at least one: --name, --prompt-trigger, --content, --amount, --sampling-method, --mode');
    return;
  }

  try {
    const res = await patch<SampleCopy>(`/api/projects/${projectId}/sample-copies/${id}`, body);
    success(`Updated: ${bold(res.data.name)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function cloneSampleCopy(projectId: string, id: string, flags?: Record<string, string>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (flags?.name) body.name = flags.name;

  try {
    const res = await post<SampleCopy>(`/api/projects/${projectId}/sample-copies/${id}/clone`, body);
    success(`Cloned: ${bold(res.data.name)} (${res.data.id})`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function deleteSampleCopy(projectId: string, id: string): Promise<void> {
  const confirmed = await c.confirm({ message: `Delete sample copy ${dim(id)}?` });
  if (c.isCancel(confirmed) || !confirmed) return;

  try {
    const res = await get<SampleCopy>(`/api/projects/${projectId}/sample-copies/${id}`);
    const version = res.data.version;
    await del(`/api/projects/${projectId}/sample-copies/${id}`, { version });
    success('Deleted.');
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
