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

export type DashboardSparklines = Record<string, Array<number | null>>;

export type DashboardFullResult = ReturnType<typeof computeDashboardSummary> & {
  cqi: CompositeQualityIndex | undefined;
  sparklines: DashboardSparklines;
};

function computeSparklines(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  startMs: number,
  endMs: number,
  buckets: number,
): Record<string, Array<number | null>> {
  const range = endMs - startMs;
  const sparklines: Record<string, Array<number | null>> = {};
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

type DashboardParts = {
  dashboard: ReturnType<typeof computeDashboardSummary>;
  cqi: CompositeQualityIndex | undefined;
  sparklines: DashboardSparklines;
};

type DashboardRoleView = ReturnType<typeof computeRoleView> & {
  sparklines: DashboardSparklines;
  cqi?: CompositeQualityIndex | undefined;
};

function computeDashboardParts(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  dates: { start: string; end: string },
): DashboardParts {
  const dashboard = computeDashboardSummary(evaluationsByMetric, { period: dates });
  const startMs = new Date(dates.start).getTime();
  const endMs = new Date(dates.end).getTime();
  return {
    dashboard,
    cqi: computeCQI(dashboard.metrics),
    sparklines: computeSparklines(evaluationsByMetric, startMs, endMs, SPARKLINE_BUCKET_COUNT),
  };
}

function projectRoleView({ dashboard, cqi, sparklines }: DashboardParts, role: Role): DashboardRoleView {
  const view = computeRoleView(dashboard, role);
  return role === 'executive' ? { ...view, cqi, sparklines } : { ...view, sparklines };
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
  const { dashboard, cqi, sparklines } = computeDashboardParts(evaluationsByMetric, dates);
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
): DashboardRoleView {
  return projectRoleView(computeDashboardParts(evaluationsByMetric, dates), role);
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
  roleViews: Record<string, DashboardRoleView>;
} {
  const parts = computeDashboardParts(evaluationsByMetric, dates);
  const { dashboard, cqi, sparklines } = parts;
  const full: DashboardFullResult = { ...dashboard, cqi, sparklines };
  const roleViews: Record<string, DashboardRoleView> = {};
  for (const role of ROLES) {
    roleViews[role] = projectRoleView(parts, role);
  }
  return { full, roleViews };
}
