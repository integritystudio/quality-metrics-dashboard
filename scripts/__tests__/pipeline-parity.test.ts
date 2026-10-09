/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `/api/pipeline` is the dev route in development
 * and the `pipeline:<period>` KV key in production. The sync once called
 * `computePipelineView` inline in `computePeriodEntries`; the route did the same.
 * One fixture through both paths must now give the same value.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { computeOrgEntries, type OrgComputation, type OrgReadBackend } from '../sync-to-kv.js';
import { evaluation } from './support/evaluations.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

// All timestamps on 2026-10-08 so they fall inside the 24h day-aligned window
// (dayStart(NOW - 24h) = dayStart(2026-10-08T12:00) = 2026-10-08T00:00Z).
// This ensures both the route mock and the KV's between() return the same set.
const evaluations: EvaluationResult[] = [
  evaluation('r1', '2026-10-08T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.8 }),
  evaluation('r2', '2026-10-08T14:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.4 }),
  evaluation('c1', '2026-10-08T11:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.9 }),
];

vi.mock('../../src/api/data-loader.js', () => ({
  loadEvaluationsByMetric: (_start: string, _end: string) => Promise.resolve(
    new Map([
      ['relevance', evaluations.filter(e => e.evaluationName === 'relevance')],
      ['coherence', evaluations.filter(e => e.evaluationName === 'coherence')],
    ])
  ),
  checkHealth: () => Promise.resolve({ hasData: true }),
}));

const { pipelineRoutes } = await import('../../src/api/routes/pipeline.js');

const backend: OrgReadBackend = {
  queryEvaluations: ({ limit }) => Promise.resolve(evaluations.slice(0, limit)),
  queryTraces: () => Promise.resolve([]),
};

function kvValue(result: OrgComputation, key: string): unknown {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as unknown : undefined;
}

describe('pipeline parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(backend, NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['24h', '7d', '30d'] as const)('writes for %s the value the dev route answers', async (period) => {
    const fromKv = kvValue(synced, `pipeline:${period}`);

    const res = await pipelineRoutes.request(`/pipeline?period=${period}`);
    expect(res.status).toBe(200);
    const fromRoute = await res.json() as unknown;

    expect(fromKv).toEqual(fromRoute);
  });
});
