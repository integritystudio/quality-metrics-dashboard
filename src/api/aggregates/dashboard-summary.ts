/**
 * Full dashboard summary (`GET /api/dashboard`), built once for both the API
 * route (`routes/dashboard.ts`) and the KV sync (`scripts/sync-to-kv.ts`).
 *
 * The sync once wrote `computeDashboardSummary(...)` directly to `dashboard:period`
 * without `cqi` or `sparklines`; the route computed both live. Every production
 * load was missing those two fields (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the evaluations and provide the period dates; this module projects
 * them into the shape both the route and the Worker serve.
 */

import { rollup, mean } from 'd3-array';
import { computeDashboardSummary } from '../parent/quality-metrics.js';
import { computeRoleView } from '../parent/quality-views.js';
import { computeCQI } from '../parent/qfe-cqi.js';
import { NANOS_TO_MS } from '../api-constants.js';
import { ROLES, type Role } from '../../lib/constants.js';
import type { EvaluationResult, CompositeQualityIndex } from '../../types.js';

/** Sparklines bucket count: 24 ≈ one data point per hour over a 24 h view. */
export const SPARKLINE_BUCKET_COUNT = 24;

export type DashboardSparklines = Record<string, (number | null)[]>;

export type DashboardFullResult = ReturnType<typeof computeDashboardSummary> & {
  cqi: CompositeQualityIndex | undefined;
  sparklines: DashboardSparklines;
};

function computeSparklines(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  startMs: number,
  endMs: number,
  buckets: number,
): Record<string, (number | null)[]> {
  const range = endMs - startMs;
  const sparklines: Record<string, (number | null)[]> = {};
  for (const [metricName, evals] of evaluationsByMetric) {
    if (range <= 0 || evals.length === 0) {
      sparklines[metricName] = [];
      continue;
    }
    const bucketWidth = range / buckets;
    const valid = evals.filter(ev => Number.isFinite(ev.scoreValue));
    const bucketMap = rollup(
      valid,
      es => mean(es, e => e.scoreValue as number) ?? null,
      e => Math.min(Math.floor((Number(e.timestamp) / NANOS_TO_MS - startMs) / bucketWidth), buckets - 1),
    );
    sparklines[metricName] = Array.from({ length: buckets }, (_, i) => bucketMap.get(i) ?? null);
  }
  return sparklines;
}

/**
 * Full `dashboard:period` payload: summary + CQI + sparklines.
 * One fixture through both the route (no `role` param) and the sync yields
 * the same value.
 */
export function computeDashboardFull(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  dates: { start: string; end: string },
): DashboardFullResult {
  const dashboard = computeDashboardSummary(evaluationsByMetric, { period: dates });
  const cqi = computeCQI(dashboard.metrics);
  const startMs = new Date(dates.start).getTime();
  const endMs = new Date(dates.end).getTime();
  const sparklines = computeSparklines(evaluationsByMetric, startMs, endMs, SPARKLINE_BUCKET_COUNT);
  return { ...dashboard, cqi, sparklines };
}

/**
 * `dashboard:period:role` payload: role view + sparklines (+ cqi for executive).
 * Matches what the route returns for a `?role=` request.
 */
export function computeDashboardRoleView(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  dates: { start: string; end: string },
  role: Role,
): ReturnType<typeof computeRoleView> & { sparklines: DashboardSparklines; cqi?: CompositeQualityIndex } {
  const dashboard = computeDashboardSummary(evaluationsByMetric, { period: dates });
  const cqi = computeCQI(dashboard.metrics);
  const startMs = new Date(dates.start).getTime();
  const endMs = new Date(dates.end).getTime();
  const sparklines = computeSparklines(evaluationsByMetric, startMs, endMs, SPARKLINE_BUCKET_COUNT);
  const view = computeRoleView(dashboard, role);
  return role === 'executive' ? { ...view, cqi, sparklines } : { ...view, sparklines };
}

/**
 * Returns all per-period dashboard entries: the full summary and each role view.
 * Used by the sync to write `dashboard:period` and `dashboard:period:role`.
 */
export function computeAllDashboardEntries(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  dates: { start: string; end: string },
): {
  full: DashboardFullResult;
  roleViews: Record<string, ReturnType<typeof computeDashboardRoleView>>;
} {
  const dashboard = computeDashboardSummary(evaluationsByMetric, { period: dates });
  const cqi = computeCQI(dashboard.metrics);
  const startMs = new Date(dates.start).getTime();
  const endMs = new Date(dates.end).getTime();
  const sparklines = computeSparklines(evaluationsByMetric, startMs, endMs, SPARKLINE_BUCKET_COUNT);
  const full: DashboardFullResult = { ...dashboard, cqi, sparklines };
  const roleViews: Record<string, ReturnType<typeof computeDashboardRoleView>> = {};
  for (const role of ROLES) {
    const view = computeRoleView(dashboard, role);
    roleViews[role] = role === 'executive' ? { ...view, cqi, sparklines } : { ...view, sparklines };
  }
  return { full, roleViews };
}
