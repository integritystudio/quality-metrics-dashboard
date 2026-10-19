/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/metrics/:name` is the dev route in
 * development and the `metric:<name>:<period>` KV key in production. The sync
 * once wrote one `metric:<name>` for the last week, without `dynamics`, and the
 * Worker served it for every period. One fixture through both paths must now
 * give the same value per period.
 *
 * The fixture server reads as obtool-api does, both bounds rounded to whole UTC
 * days, which is what the sync's in-memory `between` reproduces.
 */
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { metricDetailKey } from '../../src/api/aggregates/metric-detail.js';
import { metricsRoutes } from '../../src/api/routes/metrics.js';
import { DEFAULT_BUCKET_COUNT, DEFAULT_TOP_N } from '../../src/lib/constants.js';
import { evaluation, FIXTURE_METRIC } from './support/evaluations.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  evaluation('today', '2026-10-09T09:00:00.000Z', { scoreValue: 0.9, traceId: 'trace-a' }),
  evaluation('this week', '2026-10-06T10:00:00.000Z', { scoreValue: 0.7, traceId: 'trace-b' }),
  // The week before: the 7d baseline, inside the 30d window.
  evaluation('last week', '2026-09-28T10:00:00.000Z', { scoreValue: 0.5, traceId: 'trace-c' }),
  // The month before: the 30d baseline.
  evaluation('last month', '2026-08-25T10:00:00.000Z', { scoreValue: 0.3, traceId: 'trace-d' }),
];

const fixture = serveParityFixture({ evaluations });

type DetailValue = { sampleCount: number; trend?: { previousValue: number }; dynamics?: { velocity: number } };

describe('metric detail parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced(), metricDetailKey(FIXTURE_METRIC, period));

    const res = await metricsRoutes.request(
      `/metrics/${FIXTURE_METRIC}?period=${period}&topN=${DEFAULT_TOP_N}&bucketCount=${DEFAULT_BUCKET_COUNT}`,
    );
    expect(res.status).toBe(200);
    const fromRoute: unknown = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });

  it('baselines each period against the one before it, with dynamics', () => {
    const week = kvValue<DetailValue>(synced(), metricDetailKey(FIXTURE_METRIC, '7d'));
    const month = kvValue<DetailValue>(synced(), metricDetailKey(FIXTURE_METRIC, '30d'));

    expect(week?.sampleCount).toBe(2);
    expect(week?.trend?.previousValue).toBe(0.5);
    expect(typeof week?.dynamics?.velocity).toBe('number');
    expect(month?.sampleCount).toBe(3);
    expect(month?.trend?.previousValue).toBe(0.3);
  });

  it('no longer writes the bare metric:<name> key the Worker served for every period', () => {
    expect(synced().allEntries.map(e => e.key)).not.toContain(`metric:${FIXTURE_METRIC}`);
  });
});
