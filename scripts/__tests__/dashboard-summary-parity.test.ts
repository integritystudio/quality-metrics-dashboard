/**
 * DASHBOARD-AGGREGATE-DUAL-IMPL: `GET /api/dashboard` is the dev route;
 * `dashboard:<period>` and `dashboard:<period>:<role>` are the production KV
 * keys. The sync once wrote only `computeDashboardSummary(...)` — no `cqi`,
 * no `sparklines`. The route computed both live. Every production load was
 * therefore missing those two fields (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Both now call `computeAllDashboardEntries` / `computeDashboardFull` /
 * `computeDashboardRoleView` from `../src/api/aggregates/dashboard-summary`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { computeOrgEntries, type OrgComputation, type OrgReadBackend } from '../sync-to-kv.js';
import { evaluation } from './support/evaluations.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  evaluation('r1', '2026-10-08T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.8 }),
  evaluation('r2', '2026-10-07T11:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.6 }),
  evaluation('c1', '2026-10-08T12:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.9 }),
];

const byMetric = new Map([
  ['relevance', evaluations.filter(e => e.evaluationName === 'relevance')],
  ['coherence', evaluations.filter(e => e.evaluationName === 'coherence')],
]);

vi.mock('../../src/api/data-loader.js', () => ({
  loadEvaluationsByMetric: (_start: string, _end: string) => Promise.resolve(byMetric),
  checkHealth: () => Promise.resolve({ hasData: true }),
}));

const { dashboardRoutes } = await import('../../src/api/routes/dashboard.js');

const backend: OrgReadBackend = {
  queryEvaluations: ({ limit }) => Promise.resolve(evaluations.slice(0, limit)),
  queryTraces: () => Promise.resolve([]),
};

function kvValue(result: OrgComputation, key: string): unknown {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as unknown : undefined;
}

describe('dashboard summary parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  let synced: OrgComputation;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    synced = await computeOrgEntries(backend, NOW, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['7d', '30d'] as const)('writes for %s the value the dev route answers (no role)', async (period) => {
    const fromKv = kvValue(synced, `dashboard:${period}`);

    const res = await dashboardRoutes.request(`/dashboard?period=${period}`);
    expect(res.status).toBe(200);
    const fromRoute = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });

  it('includes cqi and sparklines in the full payload', () => {
    const fromKv = kvValue(synced, 'dashboard:7d') as Record<string, unknown> | undefined;
    expect(fromKv).toHaveProperty('cqi');
    expect(fromKv).toHaveProperty('sparklines');
  });

  it.each(['executive', 'operator', 'auditor'] as const)(
    'writes for 7d/%s the value the dev route answers (role view)',
    async (role) => {
      const fromKv = kvValue(synced, `dashboard:7d:${role}`);

      const res = await dashboardRoutes.request(`/dashboard?period=7d&role=${role}`);
      expect(res.status).toBe(200);
      const fromRoute = await res.json();

      expect(fromKv).toEqual(fromRoute);
    }
  );

  it('executive role view includes cqi and sparklines', () => {
    const fromKv = kvValue(synced, 'dashboard:7d:executive') as Record<string, unknown> | undefined;
    expect(fromKv).toHaveProperty('cqi');
    expect(fromKv).toHaveProperty('sparklines');
  });
});
