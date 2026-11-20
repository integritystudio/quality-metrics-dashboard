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

/** What a sparkline reads from a row: when it happened and what it scored. */
export type SparklineInput = Pick<EvaluationResult, 'scoreValue' | 'timestamp'>;

/** One metric's sparkline: the mean score per even bucket over `[startMs, endMs)`, `null` where a bucket is empty. */
export function computeMetricSparkline(
  evals: SparklineInput[],
  startMs: number,
  endMs: number,
  buckets: number,
): Array<number | null> {
  const range = endMs - startMs;
  if (range <= 0 || evals.length === 0) return [];
  const bucketWidth = range / buckets;
  const valid = evals.filter(ev => Number.isFinite(ev.scoreValue));
  const bucketMap = rollup(
    valid,
    es => mean(es, e => e.scoreValue as number) ?? null,
    e => Math.min(Math.floor((Number(e.timestamp) / NANOS_TO_MS - startMs) / bucketWidth), buckets - 1),
  );
  return Array.from({ length: buckets }, (_, i) => bucketMap.get(i) ?? null);
}

function computeSparklines(
  evaluationsByMetric: Map<string, EvaluationResult[]>,
  startMs: number,
  endMs: number,
  buckets: number,
): DashboardSparklines {
  const sparklines: DashboardSparklines = {};
  for (const [metricName, evals] of evaluationsByMetric) {
    sparklines[metricName] = computeMetricSparkline(evals, startMs, endMs, buckets);
  }
  return sparklines;
}

type DashboardParts = {
  dashboard: ReturnType<typeof computeDashboardSummary>;
  cqi: CompositeQualityIndex | undefined;
  sparklines: DashboardSparklines;
};

function partsOf(dashboard: ReturnType<typeof computeDashboardSummary>, sparklines: DashboardSparklines): DashboardParts {
  return { dashboard, cqi: computeCQI(dashboard.metrics), sparklines };
}

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
  return partsOf(dashboard, computeSparklines(evaluationsByMetric, startMs, endMs, SPARKLINE_BUCKET_COUNT));
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
): DashboardEntries {
  return entriesOf(computeDashboardParts(evaluationsByMetric, dates));
}

export type DashboardEntries = {
  full: DashboardFullResult;
  roleViews: Record<string, DashboardRoleView>;
};

/**
 * {@link computeAllDashboardEntries} from a summary and sparklines already
 * computed, for a host that builds each metric's result and sparkline in its
 * own partition and assembles the summary with `assembleDashboardSummary`.
 */
export function assembleDashboardEntries(
  dashboard: ReturnType<typeof computeDashboardSummary>,
  sparklines: DashboardSparklines,
): DashboardEntries {
  return entriesOf(partsOf(dashboard, sparklines));
}

function entriesOf(parts: DashboardParts): DashboardEntries {
  const { dashboard, cqi, sparklines } = parts;
  const full: DashboardFullResult = { ...dashboard, cqi, sparklines };
  const roleViews: Record<string, DashboardRoleView> = {};
  for (const role of ROLES) {
    roleViews[role] = projectRoleView(parts, role);
  }
  return { full, roleViews };
}
