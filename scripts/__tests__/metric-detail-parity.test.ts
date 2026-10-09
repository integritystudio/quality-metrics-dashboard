/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/metrics/:name` is the dev route in
 * development and the `metric:<name>:<period>` KV key in production. The sync
 * once wrote one `metric:<name>` for the last week, without `dynamics`, and the
 * Worker served it for every period. One fixture through both paths must now
 * give the same value per period.
 *
 * The route's loader is faked as the server reads: both bounds rounded to whole
 * UTC days, which is what the sync's in-memory `between` reproduces.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { queriedDateWindow } from '../../../src/backends/cloud.js';
import { computeOrgEntries, type OrgComputation, type OrgReadBackend } from '../sync-to-kv.js';
import { metricDetailKey } from '../../src/api/aggregates/metric-detail.js';
import { DEFAULT_BUCKET_COUNT, DEFAULT_TOP_N } from '../../src/lib/constants.js';
import { evaluation, FIXTURE_METRIC, isoToNs } from './support/evaluations.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  evaluation('today', '2026-10-09T09:00:00.000Z', { scoreValue: 0.9, traceId: 'trace-a' }),
  evaluation('this week', '2026-10-06T10:00:00.000Z', { scoreValue: 0.7, traceId: 'trace-b' }),
  // The week before: the 7d baseline, inside the 30d window.
  evaluation('last week', '2026-09-28T10:00:00.000Z', { scoreValue: 0.5, traceId: 'trace-c' }),
  // The month before: the 30d baseline.
  evaluation('last month', '2026-08-25T10:00:00.000Z', { scoreValue: 0.3, traceId: 'trace-d' }),
];

function serverRead(name: string, start: string, end: string): EvaluationResult[] {
  const { startNs = 0n, endNs } = queriedDateWindow({ startDate: isoToNs(start), endDate: isoToNs(end) });
  return evaluations.filter(e =>
    e.evaluationName === name && e.timestamp >= startNs && (endNs === undefined || e.timestamp < endNs));
}

vi.mock('../../src/api/data-loader.js', () => ({
  loadEvaluationsForMetric: (name: string, start: string, end: string) => Promise.resolve(serverRead(name, start, end)),
  checkHealth: () => Promise.resolve({ hasData: true }),
}));

const { metricsRoutes } = await import('../../src/api/routes/metrics.js');

const backend: OrgReadBackend = {
  queryEvaluations: ({ limit }) => Promise.resolve(evaluations.slice(0, limit)),
  queryTraces: () => Promise.resolve([]),
};

type DetailValue = { sampleCount: number; trend?: { previousValue: number }; dynamics?: { velocity: number } };

function kvValue<T = unknown>(result: OrgComputation, key: string): T | undefined {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as T : undefined;
}

describe('metric detail parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(backend, NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced, metricDetailKey(FIXTURE_METRIC, period));

    const res = await metricsRoutes.request(
      `/metrics/${FIXTURE_METRIC}?period=${period}&topN=${DEFAULT_TOP_N}&bucketCount=${DEFAULT_BUCKET_COUNT}`,
    );
    expect(res.status).toBe(200);
    const fromRoute: unknown = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });

  it('baselines each period against the one before it, with dynamics', () => {
    const week = kvValue<DetailValue>(synced, metricDetailKey(FIXTURE_METRIC, '7d'));
    const month = kvValue<DetailValue>(synced, metricDetailKey(FIXTURE_METRIC, '30d'));

    expect(week?.sampleCount).toBe(2);
    expect(week?.trend?.previousValue).toBe(0.5);
    expect(typeof week?.dynamics?.velocity).toBe('number');
    expect(month?.sampleCount).toBe(3);
    expect(month?.trend?.previousValue).toBe(0.3);
  });

  it('no longer writes the bare metric:<name> key the Worker served for every period', () => {
    expect(synced.allEntries.map(e => e.key)).not.toContain(`metric:${FIXTURE_METRIC}`);
  });
});
