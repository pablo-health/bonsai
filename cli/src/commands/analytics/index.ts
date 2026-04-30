import { get } from '../../api/client.js';
import chalk from 'chalk';
import { dim, bold, error as cliError, success } from '../../utils/format.js';

interface LatencyMetric {
  count: number;
  avg: number | null;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}

export async function latencyStats(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.from) query.from = flags.from;
  if (flags?.to) query.to = flags.to;
  if (flags?.stage) query.stageId = flags.stage;
  if (flags?.source) query.source = flags.source;

  try {
    const res = await get<{ totalTurns: number; [key: string]: unknown }>(`/api/projects/${projectId}/analytics/latency`, { query });
    const { data } = res;

    console.log(`  Total Turns:     ${data.totalTurns}`);
    console.log('');

    const metrics: Record<string, LatencyMetric> = {
      'Total Turn': (data.totalTurnDurationMs as LatencyMetric) || {},
      'Time to First Token': (data.timeToFirstTokenMs as LatencyMetric) || {},
      'LLM Duration': (data.llmDurationMs as LatencyMetric) || {},
    };

    for (const [name, m] of Object.entries(metrics)) {
      if (!m.avg && !m.median) continue;
      console.log(`  ${chalk.bold(name)}:`);
      if (m.avg !== null) console.log(`    Avg:     ${m.avg}ms`);
      if (m.median !== null) console.log(`    Median:  ${m.median}ms`);
      if (m.p95 !== null) console.log(`    P95:     ${m.p95}ms`);
      if (m.min !== null && m.max !== null) console.log(`    Range:   ${m.min}ms - ${m.max}ms`);
      console.log('');
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function latencyPercentiles(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.from) query.from = flags.from;
  if (flags?.to) query.to = flags.to;
  if (flags?.stage) query.stageId = flags.stage;
  if (flags?.source) query.source = flags.source;

  try {
    const res = await get<{ totalTurns: number; [key: string]: unknown }>(`/api/projects/${projectId}/analytics/latency/percentiles`, { query });
    const { data } = res;

    console.log(`  Total Turns:     ${data.totalTurns}`);
    console.log('');

    for (const [name, metric] of Object.entries(data) as [string, unknown][]) {
      if (typeof metric === 'object' && metric !== null && !Array.isArray(metric)) {
        const m = metric as { p50: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null };
        if (m.p50 !== null) {
          console.log(`  ${chalk.bold(name)}:`);
          console.log(`    P50: ${m.p50}ms  P75: ${m.p75}ms  P90: ${m.p90}ms  P95: ${m.p95}ms  P99: ${m.p99}ms`);
          console.log('');
        }
      }
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function latencyTrend(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = { interval: flags?.interval || 'day' };
  if (flags?.from) query.from = flags.from;
  if (flags?.to) query.to = flags.to;
  if (flags?.stage) query.stageId = flags.stage;
  if (flags?.source) query.source = flags.source;

  try {
    const res = await get<{ interval: string; points: { bucket: string; avgTotalTurnDurationMs: number | null }[] }>(`/api/projects/${projectId}/analytics/latency/trend`, { query });
    const { data } = res;

    console.log(`  Interval:        ${data.interval}`);
    console.log('');
    console.log(`  ${'Bucket'.padEnd(20)} │ ${'Avg Turn Duration'}`);
    console.log(`  ${'─'.repeat(20)}─┼─${'─'.repeat(20)}`);

    for (const p of data.points.slice(-10)) {
      const val = p.avgTotalTurnDurationMs !== null ? `${p.avgTotalTurnDurationMs}ms` : '-';
      console.log(`  ${p.bucket.padEnd(20)} │ ${val}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function conversationTimeline(projectId: string, conversationId: string): Promise<void> {
  try {
    const res = await get<{ turns: { turnIndex: number; timestamp: string; totalTurnDurationMs: number | null }[] }>(`/api/projects/${projectId}/analytics/conversations/${conversationId}/timeline`);
    const { data } = res;

    console.log(`  Conversation: ${conversationId}`);
    console.log(`  Turns:        ${data.turns.length}`);
    console.log('');
    console.log(`  ${'Turn'.padEnd(4)} │ ${'Duration'.padEnd(12)} │ Time`);
    console.log(`  ${'─'.repeat(4)}─┼─${'─'.repeat(12)}─┼─${'────────────'}`);

    for (const t of data.turns) {
      const dur = t.totalTurnDurationMs !== null ? `${t.totalTurnDurationMs}ms` : '-';
      console.log(`  ${String(t.turnIndex).padEnd(4)} │ ${dur.padEnd(12)} │ ${new Date(t.timestamp).toLocaleTimeString()}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function tokenUsage(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (flags?.from) query.from = flags.from;
  if (flags?.to) query.to = flags.to;
  if (flags?.stage) query.stageId = flags.stage;
  if (flags?.source) query.source = flags.source;

  try {
    const res = await get<{ totalEvents: number; totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number }>(`/api/projects/${projectId}/analytics/usage`, { query });
    const { data } = res;

    console.log(`  Total Events:         ${data.totalEvents}`);
    console.log(`  Prompt Tokens:        ${data.totalPromptTokens.toLocaleString()}`);
    console.log(`  Completion Tokens:    ${data.totalCompletionTokens.toLocaleString()}`);
    console.log(`  Total Tokens:         ${data.totalTokens.toLocaleString()}`);
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}

export async function tokenUsageTrend(projectId: string, flags?: Record<string, string>): Promise<void> {
  const query: Record<string, string | undefined> = { interval: flags?.interval || 'day' };
  if (flags?.from) query.from = flags.from;
  if (flags?.to) query.to = flags.to;
  if (flags?.stage) query.stageId = flags.stage;
  if (flags?.source) query.source = flags.source;

  try {
    const res = await get<{ interval: string; points: { bucket: string; totalTokens: number }[] }>(`/api/projects/${projectId}/analytics/usage/trend`, { query });
    const { data } = res;

    console.log(`  Interval:            ${data.interval}`);
    console.log('');
    console.log(`  ${'Bucket'.padEnd(20)} │ ${'Total Tokens'}`);
    console.log(`  ${'─'.repeat(20)}─┼─${'──────────────'}`);

    for (const p of data.points.slice(-10)) {
      console.log(`  ${p.bucket.padEnd(20)} │ ${p.totalTokens.toLocaleString()}`);
    }
  } catch (err) {
    if (err instanceof Error) cliError(err.message);
    process.exit(1);
  }
}
