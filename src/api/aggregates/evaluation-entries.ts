/**
 * The evaluation-family KV entries, one builder per partition: a period's
 * cross-metric entries from every row's facets, and a metric's entries from
 * that metric's rows. `org-kv-entries.ts` (the CLI sync) loops these over a
 * whole org held in memory; the Workflow (`services/kv-sync-workflow`) calls
 * the same builders one partition per step, so the two write byte-identical
 * values for the parity gate in `docs/roadmap/kv-sync-in-worker.md`.
 */

import type { EvaluationResult, PipelineResult } from '../../types.js';
import { BYTES } from '../parent/units.js';
import { PERCENT_MULTIPLIER, DEFAULT_TOP_N, DEFAULT_BUCKET_COUNT, DEFAULT_TREND_BUCKETS, type Period } from '../../lib/constants.js';
import { computeCorrelations } from './correlations.js';
import { computeCoverage, type CoverageRow } from './coverage.js';
import type { DashboardEntries } from './dashboard-summary.js';
import { projectEvaluationRow } from './evaluation-rows.js';
import { dashboardEntry, toKVValue, type KVEntry } from './kv-entry.js';
import { computeMetricDetailFromBaseline, metricDetailKey, type QualityMetricConfig } from './metric-detail.js';
import { computeTrend, trendKey, type ScoredBucket } from './trend.js';

const LOG_PREFIX = '[evaluation-entries]';

/** Input axes the coverage matrix is built for — one KV key per (period, axis). */
export const COVERAGE_INPUT_KEYS = ['traceId', 'sessionId'] as const;
/**
 * Hard cap on the number of input columns stored per coverage key.
 * The dashboard grid renders at most `COVERAGE_GRID_MAX_INPUTS = 30`, so a few
 * hundred is ample headroom for all views. Without a cap the column count grows
 * with each new trace or session in the window (COVERAGE-INPUT-SET-UNBOUNDED).
 */
export const MAX_COVERAGE_COLUMNS = 500;
/** Cloudflare KV's per-value limit. A value past it fails its whole bulk-put batch (`kvBulkPut` throws). */
// eslint-disable-next-line local/no-magic-numbers-ignore-bitwise -- the multiplier is the named constant's value
const KV_VALUE_LIMIT_BYTES = 25 * BYTES.MB;
/** Fraction of the limit at which the sync warns, so the column cap is lowered before a write fails. */
const KV_VALUE_WARN_RATIO = 0.8;
const KV_VALUE_WARN_BYTES = Math.round(KV_VALUE_LIMIT_BYTES * KV_VALUE_WARN_RATIO);

/** The newest rows `metric:evaluations:<name>:<period>` keeps. */
export const MAX_EVAL_ROWS = 200;

/** One metric over one period: the unit each per-metric entry is built for. */
export type MetricPartition = { name: string; period: Period };

/** `dashboard:<period>` and `dashboard:<period>:<role>` from the assembled views. */
export function dashboardEntries(period: Period, { full, roleViews }: DashboardEntries): KVEntry[] {
  const entries = [dashboardEntry(`dashboard:${period}`, full)];
  for (const [role, view] of Object.entries(roleViews)) {
    entries.push(dashboardEntry(`dashboard:${period}:${role}`, view));
  }
  return entries;
}

/** `correlations:<period>` over every row's score, keyed in the map's order. */
export function correlationsEntry(period: Period, grouped: Map<string, Array<Pick<EvaluationResult, 'scoreValue'>>>): KVEntry {
  return { key: `correlations:${period}`, value: toKVValue(computeCorrelations(grouped)) };
}

/** `coverage:<period>:<inputKey>` per axis, warning when a value nears KV's limit. */
export function coverageEntries(period: Period, grouped: Map<string, CoverageRow[]>): KVEntry[] {
  const entries: KVEntry[] = [];
  for (const inputKey of COVERAGE_INPUT_KEYS) {
    const matrix = computeCoverage(grouped, { inputKey, maxInputs: MAX_COVERAGE_COLUMNS });
    const coverageKey = `coverage:${period}:${inputKey}`;
    const coverageValue = toKVValue({ period, ...matrix });
    const coverageSizeBytes = new TextEncoder().encode(coverageValue).length;
    if (coverageSizeBytes > KV_VALUE_WARN_BYTES) {
      console.warn(
        `${LOG_PREFIX} ${coverageKey} is ${Math.round(coverageSizeBytes / BYTES.KB)} KB,` +
        ` over ${KV_VALUE_WARN_RATIO * PERCENT_MULTIPLIER}% of KV's ${KV_VALUE_LIMIT_BYTES / BYTES.MB} MiB value limit` +
        ' — reduce MAX_COVERAGE_COLUMNS',
      );
    }
    entries.push({ key: coverageKey, value: coverageValue });
  }
  return entries;
}

/** `pipeline:<period>` from a computed funnel. */
export function pipelineEntry(period: Period, pipeline: PipelineResult): KVEntry {
  return { key: `pipeline:${period}`, value: toKVValue({ period, ...pipeline }) };
}

/**
 * `metric:<name>:<period>` against the previous window's finite scores, plus
 * the trace ids its worst evaluations link to (the trace write budget favours them).
 */
export function metricDetailEntry(
  { name, period }: MetricPartition,
  evaluations: EvaluationResult[],
  previousScores: number[],
  config: QualityMetricConfig,
): { entry: KVEntry; referencedTraceIds: string[] } {
  const view = computeMetricDetailFromBaseline(evaluations, previousScores, config, {
    period,
    topN: DEFAULT_TOP_N,
    bucketCount: DEFAULT_BUCKET_COUNT,
  });
  const referencedTraceIds = view.worstEvaluations.flatMap(w => (w.traceId ? [w.traceId] : []));
  return { entry: { key: metricDetailKey(name, period), value: toKVValue(view) }, referencedTraceIds };
}

/** `metric:evaluations:<name>:<period>`: the newest MAX_EVAL_ROWS rows, projected. */
export function evaluationRowsEntry({ name, period }: MetricPartition, evaluations: EvaluationResult[]): KVEntry {
  const sorted = evaluations.toSorted((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
  const rows = sorted.slice(0, MAX_EVAL_ROWS).map(e => projectEvaluationRow(e));
  return { key: `metric:evaluations:${name}:${period}`, value: toKVValue({ rows }) };
}

/** `trend:<name>:<period>`, plus the scored buckets the degradation signals read. */
export function trendEntry(
  { name, period }: MetricPartition,
  evaluations: EvaluationResult[],
  config: QualityMetricConfig,
  now: Date,
): { entry: KVEntry; buckets: ScoredBucket[] } {
  const { view, buckets } = computeTrend(name, evaluations, config, { period, bucketCount: DEFAULT_TREND_BUCKETS, now });
  return { entry: { key: trendKey(name, period), value: toKVValue(view) }, buckets };
}
