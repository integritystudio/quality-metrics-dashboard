/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/metrics/:name/evaluations` is the dev
 * route; `metric:evaluations:<name>:<period>` is the production KV key. The
 * route once inlined its row projection; the sync did the same — and they
 * diverged on `evaluatorKind` and `cohort`. Both now call `projectEvaluationRow`
 * from `../src/api/aggregates/evaluation-rows`.
 *
 * The sync writes up to MAX_EVAL_ROWS (200) rows sorted newest-first.
 * The route supports pagination. One evaluation per metric through both paths
 * must produce identical row objects (including `evaluatorKind` and `cohort`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { computeOrgEntries, type OrgComputation, type OrgReadBackend } from '../sync-to-kv.js';
import { evaluation } from './support/evaluations.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

// One evaluation per metric so sort order is deterministic and
// there is no ambiguity about which element appears first.
const relevanceEval: EvaluationResult = evaluation('e-relevance', '2026-10-08T10:00:00.000Z', {
  evaluationName: 'relevance',
  scoreValue: 0.8,
  evaluatorKind: 'llm',
  cohort: 'normal',   // 'canary' is filtered by the sync; use a non-excluded cohort
  traceId: 'trace-a',
  sessionId: 'sess-1',
});

const coherenceEval: EvaluationResult = evaluation('e-coherence', '2026-10-07T08:00:00.000Z', {
  evaluationName: 'coherence',
  scoreValue: 0.9,
  evaluatorKind: 'rule',
  traceId: 'trace-b',
});

const allEvals = [relevanceEval, coherenceEval];

vi.mock('../../src/api/data-loader.js', () => ({
  loadEvaluationsForMetric: (name: string, _start: string, _end: string) =>
    Promise.resolve(allEvals.filter(e => e.evaluationName === name)),
  loadEvaluationsByMetric: (_start: string, _end: string) => Promise.resolve(
    new Map([
      ['relevance', [relevanceEval]],
      ['coherence', [coherenceEval]],
    ])
  ),
  checkHealth: () => Promise.resolve({ hasData: true }),
}));

const { metricsRoutes } = await import('../../src/api/routes/metrics.js');

const backend: OrgReadBackend = {
  queryEvaluations: ({ limit }) => Promise.resolve(allEvals.slice(0, limit)),
  queryTraces: () => Promise.resolve([]),
};

function kvValue(result: OrgComputation, key: string): unknown {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as unknown : undefined;
}

describe('evaluation rows parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(backend, NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['relevance', '7d'],
    ['coherence', '7d'],
    ['relevance', '30d'],
  ] as const)('writes for %s/%s the same row the dev route returns', async (metric, period) => {
    const fromKv = kvValue(synced, `metric:evaluations:${metric}:${period}`) as
      { rows: unknown[] } | undefined;

    // Route default sort is timestamp-desc; with one row per metric the order is deterministic.
    const res = await metricsRoutes.request(`/metrics/${metric}/evaluations?period=${period}&limit=200`);
    expect(res.status).toBe(200);
    const fromRoute = await res.json() as { rows: unknown[]; total: number };

    expect(fromKv?.rows).toEqual(fromRoute.rows);
  });

  it('includes evaluatorKind and cohort in the KV row', async () => {
    const fromKv = kvValue(synced, 'metric:evaluations:relevance:7d') as
      { rows: Record<string, unknown>[] } | undefined;
    expect(fromKv?.rows[0]).toMatchObject({ evaluatorKind: 'llm', cohort: 'normal' });
  });

  it('includes evaluatorKind and cohort in the route row', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=200');
    const { rows } = await res.json() as { rows: Record<string, unknown>[] };
    expect(rows[0]).toMatchObject({ evaluatorKind: 'llm', cohort: 'normal' });
  });
});
