/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/trends/:name` is the dev route in
 * development and the `trend:<name>:<period>` KV key in production. The route
 * once auto-narrowed the axis to concentrated data and reported `narrowed`;
 * the sync bucketed the whole period. One fixture through both paths must now
 * give the same value per period.
 */
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { trendKey } from '../../src/api/aggregates/trend.js';
import { trendRoutes } from '../../src/api/routes/trends.js';
import { DEFAULT_TREND_BUCKETS } from '../../src/lib/constants.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { evaluation, FIXTURE_METRIC } from './support/evaluations.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

// Three days of data: under a fifth of the month, so the 30d series narrows; not of the week.
const evaluations: EvaluationResult[] = [
  evaluation('today', '2026-10-09T09:00:00.000Z', { scoreValue: 0.9 }),
  evaluation('yesterday', '2026-10-08T10:00:00.000Z', { scoreValue: 0.8 }),
  evaluation('three days ago', '2026-10-06T10:00:00.000Z', { scoreValue: 0.7 }),
  evaluation('unscored', '2026-10-07T10:00:00.000Z', { scoreValue: undefined }),
];
const SCORED_EVALUATIONS = 3;

const fixture = serveParityFixture({ evaluations });

type TrendValue = { bucketCount: number; totalEvaluations: number; narrowed: boolean; trendData: Array<{ count: number }> };

describe('trend parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced(), trendKey(FIXTURE_METRIC, period));

    const res = await trendRoutes.request(`/trends/${FIXTURE_METRIC}?period=${period}&buckets=${DEFAULT_TREND_BUCKETS}`);
    expect(res.status).toBe(HttpStatus.Ok);
    const fromRoute: unknown = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });

  it('narrows the synced month to the data range as the route does, and not the week', () => {
    const month = kvValue<TrendValue>(synced(), trendKey(FIXTURE_METRIC, '30d'));
    const week = kvValue<TrendValue>(synced(), trendKey(FIXTURE_METRIC, '7d'));

    expect(month?.narrowed).toBe(true);
    expect(week?.narrowed).toBe(false);
    expect(month?.bucketCount).toBe(DEFAULT_TREND_BUCKETS);
    expect(month?.totalEvaluations).toBe(SCORED_EVALUATIONS);
    expect(month?.trendData.reduce((sum, b) => sum + b.count, 0)).toBe(SCORED_EVALUATIONS);
  });
});
