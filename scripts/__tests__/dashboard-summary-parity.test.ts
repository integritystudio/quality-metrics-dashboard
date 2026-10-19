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
import { describe, it, expect } from 'vitest';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { dashboardRoutes } from '../../src/api/routes/dashboard.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { evaluation } from './support/evaluations.js';
import { kvValue, serveParityFixture, syncEachTest } from './support/parity-fixture.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const evaluations: EvaluationResult[] = [
  evaluation('r1', '2026-10-08T10:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.8 }),
  evaluation('r2', '2026-10-07T11:00:00.000Z', { evaluationName: 'relevance', scoreValue: 0.6 }),
  evaluation('c1', '2026-10-08T12:00:00.000Z', { evaluationName: 'coherence', scoreValue: 0.9 }),
];

const fixture = serveParityFixture({ evaluations });

describe('dashboard summary parity (DASHBOARD-AGGREGATE-DUAL-IMPL)', () => {
  const synced = syncEachTest(fixture, NOW);

  it.each(['7d', '30d'] as const)('writes for %s the value the dev route answers (no role)', async (period) => {
    const fromKv = kvValue(synced(), `dashboard:${period}`);

    const res = await dashboardRoutes.request(`/dashboard?period=${period}`);
    expect(res.status).toBe(HttpStatus.Ok);
    const fromRoute = await res.json();

    expect(fromKv).toEqual(fromRoute);
  });

  it('includes cqi and sparklines in the full payload', () => {
    const fromKv = kvValue<Record<string, unknown>>(synced(), 'dashboard:7d');
    expect(fromKv).toHaveProperty('cqi');
    expect(fromKv).toHaveProperty('sparklines');
  });

  it.each(['executive', 'operator', 'auditor'] as const)(
    'writes for 7d/%s the value the dev route answers (role view)',
    async (role) => {
      const fromKv = kvValue(synced(), `dashboard:7d:${role}`);

      const res = await dashboardRoutes.request(`/dashboard?period=7d&role=${role}`);
      expect(res.status).toBe(HttpStatus.Ok);
      const fromRoute = await res.json();

      expect(fromKv).toEqual(fromRoute);
    }
  );

  it('executive role view includes cqi and sparklines', () => {
    const fromKv = kvValue<Record<string, unknown>>(synced(), 'dashboard:7d:executive');
    expect(fromKv).toHaveProperty('cqi');
    expect(fromKv).toHaveProperty('sparklines');
  });
});
