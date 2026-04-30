import { get } from '../../api/client.js';
import { dim, bold, error as cliError, success, truncate } from '../../utils/format.js';

interface ScenarioConversation {
  id: string;
  projectId: string;
  scenarioRunId: string;
  scenarioId: string;
  testerId: string;
  conversationId: string | null;
  status: 'queued' | 'in_progress' | 'passed' | 'failed' | 'cancelled';
  dataExtractionResults: Record<string, unknown> | null;
  dataTransformationResults: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export async function listScenarioConversations(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.run_id || flags?.scenarioRunId) query.scenarioRunId = flags.run_id || flags.scenarioRunId;

  try {
    const res = await get<{ items: ScenarioConversation[]; total: number }>(`/api/projects/${projectId}/scenario-conversations`, { query });
    const { items, total } = res.data;

    if (items.length === 0) { console.log('No results found.'); return; }

    console.log(`  ${'ID'.padEnd(8)} │ ${'Status'.padEnd(12)} │ Run ID`);
    console.log(`  ${'─'.repeat(8)}─┼─${'─'.repeat(12)}─┼─${'───────────────'}`);

    for (const sc of items) {
      const runId = truncate(sc.scenarioRunId, 13);
      console.log(`  ${truncate(sc.id, 8)} │ ${sc.status.padEnd(12)} │ ${runId}`);
    }

    console.log(`\n${dim(`${total} total`)}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function showScenarioConversation(projectId: string, id: string): Promise<void> {
  try {
    const res = await get<ScenarioConversation>(`/api/projects/${projectId}/scenario-conversations/${id}`);
    const { data } = res;
    console.log(`  ID:                    ${data.id}`);
    console.log(`  Status:                ${data.status}`);
    console.log(`  Scenario Run:          ${data.scenarioRunId}`);
    console.log(`  Scenario:              ${data.scenarioId}`);
    console.log(`  Tester:                ${data.testerId}`);
    if (data.dataExtractionResults) {
      console.log(`  Data Extraction:`);
      for (const [key, value] of Object.entries(data.dataExtractionResults)) {
        console.log(`    ${key}: ${truncate(JSON.stringify(value), 100)}`);
      }
    }
    if (data.dataTransformationResults) {
      console.log(`  Data Transformation:`);
      for (const [key, value] of Object.entries(data.dataTransformationResults)) {
        console.log(`    ${key}: ${truncate(JSON.stringify(value), 100)}`);
      }
    }
    console.log(`  Version:               ${data.version}`);
    console.log(`  Created:               ${new Date(data.createdAt).toLocaleString()}`);
    console.log(`  Updated:               ${new Date(data.updatedAt).toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
