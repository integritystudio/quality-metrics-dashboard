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
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { metricsRoutes } from '../../src/api/routes/metrics.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { evaluation } from './support/evaluations.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

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

const unscoredEval: EvaluationResult = evaluation('e-faithfulness', '2026-10-08T09:00:00.000Z', {
  evaluationName: 'faithfulness',
  scoreValue: undefined,
  scoreLabel: 'pass',
  traceId: 'trace-c',
});

const fixture = serveParityFixture({ evaluations: [relevanceEval, coherenceEval, unscoredEval] });

describe('evaluation rows parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each([
    ['relevance', '7d'],
    ['coherence', '7d'],
    ['relevance', '30d'],
    ['faithfulness', '7d'],
  ] as const)('writes for %s/%s the same row the dev route returns', async (metric, period) => {
    const fromKv = kvValue<{ rows: unknown[] }>(synced(), `metric:evaluations:${metric}:${period}`);

    // Route default sort is timestamp-desc; with one row per metric the order is deterministic.
    const res = await metricsRoutes.request(`/metrics/${metric}/evaluations?period=${period}&limit=200`);
    expect(res.status).toBe(HttpStatus.Ok);
    const fromRoute = await res.json() as { rows: unknown[]; total: number };

    expect(fromKv?.rows).toEqual(fromRoute.rows);
  });

  it('includes evaluatorKind and cohort in the KV row', () => {
    const fromKv = kvValue<{ rows: Array<Record<string, unknown>> }>(synced(), 'metric:evaluations:relevance:7d');
    expect(fromKv?.rows[0]).toMatchObject({ evaluatorKind: 'llm', cohort: 'normal' });
  });

  it('flags a row whose evaluation has no score, and only that row', () => {
    const unscored = kvValue<{ rows: Array<Record<string, unknown>> }>(synced(), 'metric:evaluations:faithfulness:7d');
    const scored = kvValue<{ rows: Array<Record<string, unknown>> }>(synced(), 'metric:evaluations:relevance:7d');
    expect(unscored?.rows[0]).toMatchObject({ score: 0, unscored: true });
    expect(scored?.rows[0]).not.toHaveProperty('unscored');
  });

  it('includes evaluatorKind and cohort in the route row', async () => {
    const res = await metricsRoutes.request('/metrics/relevance/evaluations?period=7d&limit=200');
    const { rows } = await res.json() as { rows: Array<Record<string, unknown>> };
    expect(rows[0]).toMatchObject({ evaluatorKind: 'llm', cohort: 'normal' });
  });
});
