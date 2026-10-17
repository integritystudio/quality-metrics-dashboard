/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/agents` is the dev route in development
 * and the `meta:agents:<period>` KV key in production. The sync once wrote a
 * summary list of its own there, which the page rejected. One fixture through
 * both paths must now give the same value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { GENAI_AGENT_ATTRIBUTES } from '../../../src/lib/otel/genai-attributes.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';
import { computeOrgEntries, type OrgComputation } from '../sync-to-kv.js';
import { agentStatsKey, HOOK_NAME_ATTRIBUTE, type AgentStatsResponse } from '../../src/api/aggregates/agent-stats.js';
import { HOOK_NAME } from '../../src/api/api-constants.js';
import { agentRoutes } from '../../src/api/routes/agents.js';
import { spanToWire, type TraceWireRow } from '../../src/__tests__/support/fixture-server.js';
import { evaluation, isoToNs } from './support/evaluations.js';
import { serveParityFixture } from './support/parity-fixture.js';

const NOW = new Date('2026-10-08T01:08:00.000Z');

type AgentSpanFixture = {
  agentName: string;
  iso: string;
  traceId: string;
  sessionId: string;
  attrs?: Record<string, unknown>;
};

function agentSpan({ agentName, iso, traceId, sessionId, attrs = {} }: AgentSpanFixture): TraceWireRow {
  return spanToWire({
    traceId,
    spanId: `${traceId}-${iso}`,
    name: `hook:${HOOK_NAME.AGENT_FINALIZE}`,
    kind: 'INTERNAL',
    startTimeUnixNano: isoToNs(iso),
    attributes: {
      [HOOK_NAME_ATTRIBUTE]: HOOK_NAME.AGENT_FINALIZE,
      [GENAI_AGENT_ATTRIBUTES.AGENT_NAME]: agentName,
      [SESSION_ATTRIBUTES.ID]: sessionId,
      'integritystudio.agent.source_type': 'active',
      'integritystudio.agent.output_size': 500,
      ...attrs,
    },
  });
}

const spans: TraceWireRow[] = [
  agentSpan({ agentName: 'general-purpose', iso: '2026-10-07T12:00:00.000Z', traceId: 'trace-a', sessionId: 'sess-1', attrs: { 'integritystudio.agent.has_error': true } }),
  agentSpan({ agentName: 'Explore', iso: '2026-10-07T12:30:00.000Z', traceId: 'trace-a', sessionId: 'sess-1' }),
  agentSpan({ agentName: 'general-purpose', iso: '2026-10-06T09:00:00.000Z', traceId: 'trace-b', sessionId: 'sess-2' }),
  // Older than 7d, inside 30d.
  agentSpan({ agentName: 'general-purpose', iso: '2026-09-20T10:00:00.000Z', traceId: 'trace-c', sessionId: 'sess-3' }),
  // Not an agent-finalize span: never counted.
  spanToWire({ traceId: 'trace-z', spanId: 'z', name: 'session-span', kind: 'INTERNAL', startTimeUnixNano: isoToNs('2026-10-07T11:00:00.000Z'), attributes: { [SESSION_ATTRIBUTES.ID]: 'sess-9' } }),
];

const evaluations: EvaluationResult[] = [
  evaluation('on trace-a', '2026-10-07T13:00:00.000Z', { traceId: 'trace-a', scoreValue: 0.8 }),
  evaluation('on trace-c', '2026-09-20T11:00:00.000Z', { traceId: 'trace-c', scoreValue: 0.6 }),
  evaluation('no agent', '2026-10-07T11:30:00.000Z', { traceId: 'trace-z', scoreValue: 0.1 }),
];

const fixture = serveParityFixture({ evaluations, spans });

function kvValue(result: OrgComputation, key: string): AgentStatsResponse | undefined {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as AgentStatsResponse : undefined;
}

async function routeValue(period: string): Promise<AgentStatsResponse> {
  const res = await agentRoutes.request(`/agents?period=${period}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AgentStatsResponse;
}

describe('agents page parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(fixture.syncBackend(), NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced, agentStatsKey(period));

    expect(fromKv).toEqual(await routeValue(period));
  });

  it('counts the week and the month differently, with the evaluations of an agent\'s traces', async () => {
    const week = await routeValue('7d');
    const month = await routeValue('30d');

    expect(week.agents.map(a => [a.agentName, a.invocations])).toEqual([['general-purpose', 2], ['Explore', 1]]);
    expect(month.agents.map(a => [a.agentName, a.invocations])).toEqual([['general-purpose', 3], ['Explore', 1]]);
    expect(week.agents[0]?.evalSummary).toEqual({ relevance: { avg: 0.8, min: 0.8, max: 0.8, count: 1 } });
    expect(month.agents[0]?.evalSummary).toEqual({ relevance: { avg: 0.7, min: 0.6, max: 0.8, count: 2 } });
    expect(week.agents[0]?.errorRate).toBe(0.5);
  });

  it('no longer writes the bare meta:agents list the page could not read', () => {
    expect(synced.allEntries.map(e => e.key)).not.toContain('meta:agents');
  });
});
