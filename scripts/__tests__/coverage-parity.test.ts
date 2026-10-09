/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/coverage` is the dev route in development
 * and the `coverage:<period>:<inputKey>` KV key in production. The route once used
 * `filterJudgeEvaluations` inline; the sync used `filterRuleEvals`. One fixture
 * through both paths must now give the same value (CVG-RULE-FILTER).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { computeOrgEntries, type OrgComputation, type OrgReadBackend } from '../sync-to-kv.js';
import { evaluation, isoToNs } from './support/evaluations.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  // LLM judge evaluations — included
  evaluation('r1', '2026-10-08T10:00:00.000Z', {
    evaluationName: 'relevance', scoreValue: 0.8, traceId: 'trace-a',
    evaluatorType: 'llm',
  }),
  evaluation('r2', '2026-10-07T10:00:00.000Z', {
    evaluationName: 'relevance', scoreValue: 0.6, traceId: 'trace-b',
    evaluatorType: 'llm',
  }),
  // Rule-based evaluation — excluded from coverage
  evaluation('rule1', '2026-10-08T11:00:00.000Z', {
    evaluationName: 'tool_correctness', scoreValue: 1.0, traceId: 'trace-c',
    evaluatorType: 'rule',
  }),
];

vi.mock('../../src/api/data-loader.js', () => ({
  loadEvaluationsByMetric: (_start: string, _end: string) => Promise.resolve(
    new Map([
      ['relevance', evaluations.filter(e => e.evaluationName === 'relevance')],
      ['tool_correctness', evaluations.filter(e => e.evaluationName === 'tool_correctness')],
    ])
  ),
  checkHealth: () => Promise.resolve({ hasData: true }),
}));

const { coverageRoutes } = await import('../../src/api/routes/coverage.js');

const backend: OrgReadBackend = {
  queryEvaluations: ({ limit }) => Promise.resolve(evaluations.slice(0, limit)),
  queryTraces: () => Promise.resolve([]),
};

function kvValue(result: OrgComputation, key: string): unknown {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as unknown : undefined;
}

describe('coverage parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(backend, NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['7d', 'traceId'],
    ['7d', 'sessionId'],
    ['30d', 'traceId'],
  ] as const)('writes for %s/%s the value the dev route answers', async (period, inputKey) => {
    const fromKv = kvValue(synced, `coverage:${period}:${inputKey}`);

    const res = await coverageRoutes.request(`/coverage?period=${period}&inputKey=${inputKey}`);
    expect(res.status).toBe(200);
    const fromRoute = await res.json() as unknown;

    expect(fromKv).toEqual(fromRoute);
  });

  it('excludes rule-based evaluations from the matrix', async () => {
    const res = await coverageRoutes.request('/coverage?period=7d&inputKey=traceId');
    const body = await res.json() as { metrics?: string[] };
    // rule evals are excluded; tool_correctness (rule-only) should not appear
    expect(body.metrics).not.toContain('tool_correctness');
    expect(body.metrics).toContain('relevance');
  });
});
