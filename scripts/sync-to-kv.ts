#!/usr/bin/env tsx
/**
 * Sync pre-computed dashboard data to Cloudflare Workers KV.
 *
 * Reads local JSONL evaluations, runs quality-metrics computations,
 * and uploads results via `wrangler kv bulk put` (works with both
 * local OAuth session and CLOUDFLARE_API_TOKEN in CI).
 *
 * Rate-limited to stay under Cloudflare free-tier KV write limits
 * (1,000 writes/day). Uses content-hash delta sync to skip unchanged
 * entries and a per-run budget (default 450) with priority ordering:
 *   meta/dashboard > metrics > trends > traces
 *
 * Usage: tsx scripts/sync-to-kv.ts [--days=30] [--dry-run] [--budget=450]
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MultiDirectoryBackend } from '../../dist/backends/local-jsonl.js';
import {
  computeDashboardSummary,
  computeRoleView,
  computeMetricDetail,
  computeAggregations,
  getQualityMetric,
  QUALITY_METRICS,
} from '../../dist/lib/quality-metrics.js';
import type { RoleViewType, QualityMetricConfig, MetricTrend } from '../../dist/lib/quality-metrics.js';
import type { EvaluationResult } from '../../dist/backends/index.js';
import {
  computePercentileDistribution,
  computeMetricDynamics,
} from '../../dist/lib/quality-feature-engineering.js';

const NAMESPACE_ID = process.env.KV_NAMESPACE_ID || '902fc8a43e7147b486b6376c485c4506';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysFlag = args.find(a => a.startsWith('--days='));
const maxDays = daysFlag ? parseInt(daysFlag.split('=')[1], 10) : 30;
const budgetFlag = args.find(a => a.startsWith('--budget='));
const WRITE_BUDGET = budgetFlag ? parseInt(budgetFlag.split('=')[1], 10) : 450;

const PERIODS = ['24h', '7d', '30d'] as const;
const ROLES: RoleViewType[] = ['executive', 'operator', 'auditor'];
const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

type KVEntry = { key: string; value: string };

const KV_BATCH_SIZE = 9_500; // wrangler limit is 10,000 per bulk put
const STATE_FILE = join(import.meta.dirname ?? '.', '.kv-sync-state.json');

// ---- Delta sync state ----

type SyncState = Record<string, string>; // key → sha256(value)

function loadSyncState(): SyncState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSyncState(state: SyncState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Filter to only entries whose content changed since last sync. */
function filterChanged(entries: KVEntry[], state: SyncState): KVEntry[] {
  return entries.filter(e => {
    const hash = hashValue(e.value);
    return state[e.key] !== hash;
  });
}

// ---- KV bulk write ----

/** Returns the number of entries successfully written. */
function kvBulkPut(entries: KVEntry[]): number {
  if (entries.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < entries.length; i += KV_BATCH_SIZE) {
    const batch = entries.slice(i, i + KV_BATCH_SIZE);
    const batchLabel = entries.length > KV_BATCH_SIZE
      ? ` (batch ${Math.floor(i / KV_BATCH_SIZE) + 1}/${Math.ceil(entries.length / KV_BATCH_SIZE)})`
      : '';
    const tmpFile = join(tmpdir(), `kv-sync-${Date.now()}-${i}.json`);
    try {
      writeFileSync(tmpFile, JSON.stringify(batch));
      if (dryRun) {
        for (const e of batch) {
          console.log(`[dry-run] PUT ${e.key} (${e.value.length} bytes)`);
        }
        written += batch.length;
        continue;
      }
      try {
        execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', tmpFile, '--namespace-id', NAMESPACE_ID, '--remote'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
        if (stderr.includes('free usage limit') || stderr.includes('code: 10048')) {
          console.warn(`[sync-to-kv] KV daily write limit reached — ${batch.length} entries deferred to next run`);
          return written;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Wrangler KV bulk put failed for ${batch.length} entries${batchLabel}. Ensure wrangler is installed and authenticated. Error: ${msg}`);
      }
      written += batch.length;
      console.log(`PUT ${batch.length} entries${batchLabel}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  return written;
}

async function main(): Promise<void> {
  const backend = new MultiDirectoryBackend(undefined, true);
  const now = new Date();
  const entries: KVEntry[] = [];

  // Dashboard summaries and role views per period
  for (const period of PERIODS) {
    const ms = PERIOD_MS[period];
    if (ms > maxDays * 24 * 60 * 60 * 1000) continue;

    const start = new Date(now.getTime() - ms);
    const dates = { start: start.toISOString(), end: now.toISOString() };
    const QUERY_LIMIT = 10_000;
    const evals = await backend.queryEvaluations({
      startDate: dates.start,
      endDate: dates.end,
      limit: QUERY_LIMIT,
    });
    if (evals.length === QUERY_LIMIT) {
      console.warn(`[sync-to-kv] Query returned ${QUERY_LIMIT} results for period ${period} — data may be truncated`);
    }

    // Filter out canary evaluations (intentionally degraded scores for testing)
    const filtered = evals.filter(ev =>
      !('evaluatorType' in ev && (ev as Record<string, unknown>).evaluatorType === 'canary'),
    );

    const grouped = new Map<string, typeof filtered>();
    for (const ev of filtered) {
      const name = ev.evaluationName;
      if (!grouped.has(name)) grouped.set(name, []);
      grouped.get(name)!.push(ev);
    }

    const dashboard = computeDashboardSummary(grouped, undefined, dates);
    entries.push({ key: `dashboard:${period}`, value: JSON.stringify(dashboard) });

    for (const role of ROLES) {
      const view = computeRoleView(dashboard, role);
      entries.push({ key: `dashboard:${period}:${role}`, value: JSON.stringify(view) });
    }
  }

  // Metric details (7d window)
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const metricNames = Object.keys(QUALITY_METRICS);

  for (const name of metricNames) {
    const config = getQualityMetric(name);
    if (!config) continue;
    const rawEvals = await backend.queryEvaluations({
      startDate: weekAgo.toISOString(),
      endDate: now.toISOString(),
      evaluationName: name,
      limit: 10000,
    });
    const evals = rawEvals.filter(ev =>
      !('evaluatorType' in ev && (ev as Record<string, unknown>).evaluatorType === 'canary'),
    );
    if (evals.length === 0) continue;
    const detail = computeMetricDetail(evals, config as QualityMetricConfig, {
      topN: 5,
      bucketCount: 10,
    });
    entries.push({ key: `metric:${name}`, value: JSON.stringify(detail) });
  }

  // Trend data per metric × period (10 buckets)
  const TREND_BUCKETS = 10;
  for (const period of PERIODS) {
    const ms = PERIOD_MS[period];
    if (ms > maxDays * 24 * 60 * 60 * 1000) continue;
    const start = new Date(now.getTime() - ms);
    const bucketMs = ms / TREND_BUCKETS;

    for (const name of metricNames) {
      const config = getQualityMetric(name);
      if (!config) continue;
      const rawEvals = await backend.queryEvaluations({
        startDate: start.toISOString(),
        endDate: now.toISOString(),
        evaluationName: name,
        limit: 10000,
      });
      const evaluations = rawEvals.filter(ev =>
        !('evaluatorType' in ev && (ev as Record<string, unknown>).evaluatorType === 'canary'),
      );

      const timeBuckets: Array<{ startTime: string; endTime: string; scores: number[]; evals: EvaluationResult[] }> = [];
      for (let i = 0; i < TREND_BUCKETS; i++) {
        const bStart = new Date(start.getTime() + i * bucketMs);
        const bEnd = new Date(start.getTime() + (i + 1) * bucketMs);
        timeBuckets.push({ startTime: bStart.toISOString(), endTime: bEnd.toISOString(), scores: [], evals: [] });
      }
      for (const ev of evaluations) {
        const ts = new Date(ev.timestamp).getTime();
        const idx = Math.min(Math.floor((ts - start.getTime()) / bucketMs), TREND_BUCKETS - 1);
        if (idx >= 0 && ev.scoreValue != null && Number.isFinite(ev.scoreValue)) {
          timeBuckets[idx].scores.push(ev.scoreValue);
          timeBuckets[idx].evals.push(ev);
        }
      }

      const periodHours = ms / (TREND_BUCKETS * 3600000);
      let previousTrend: MetricTrend | undefined;
      const trendData = timeBuckets.map((bucket, idx) => {
        const { scores } = bucket;
        const percentiles = computePercentileDistribution(scores);
        const avg = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : null;
        const previousValues = (idx > 0 && timeBuckets[idx - 1].scores.length > 0)
          ? computeAggregations(timeBuckets[idx - 1].scores, config.aggregations)
          : undefined;
        const detail = scores.length > 0
          ? computeMetricDetail(bucket.evals, config as QualityMetricConfig, { topN: 0, bucketCount: 0, previousValues })
          : undefined;
        let dynamics = undefined;
        if (detail?.trend) {
          dynamics = computeMetricDynamics(detail.trend, previousTrend, periodHours);
          previousTrend = detail.trend;
        }
        return {
          startTime: bucket.startTime,
          endTime: bucket.endTime,
          count: scores.length,
          avg: avg != null ? Math.round(avg * 10000) / 10000 : null,
          percentiles,
          trend: detail?.trend ?? null,
          dynamics: dynamics ?? null,
        };
      });

      const allScores = evaluations
        .map(e => e.scoreValue)
        .filter((v): v is number => v != null && Number.isFinite(v));

      entries.push({
        key: `trend:${name}:${period}`,
        value: JSON.stringify({
          metric: name,
          period,
          bucketCount: TREND_BUCKETS,
          totalEvaluations: allScores.length,
          overallPercentiles: computePercentileDistribution(allScores),
          trendData,
        }),
      });
    }
  }

  // Per-trace evaluations and spans
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const allEvals = await backend.queryEvaluations({
    startDate: thirtyDaysAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 10000,
  });
  const evalsByTrace = new Map<string, EvaluationResult[]>();
  for (const ev of allEvals) {
    if (!ev.traceId) continue;
    if (!evalsByTrace.has(ev.traceId)) evalsByTrace.set(ev.traceId, []);
    evalsByTrace.get(ev.traceId)!.push(ev);
  }
  const traceIds = [...evalsByTrace.keys()];
  console.log(`Found ${traceIds.length} unique traces with evaluations`);

  // Query all spans once for the period and group by traceId
  const allSpans = await backend.queryTraces({
    startDate: thirtyDaysAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 50000,
  });
  const spansByTrace = new Map<string, typeof allSpans>();
  for (const span of allSpans) {
    if (!span.traceId) continue;
    if (!spansByTrace.has(span.traceId)) spansByTrace.set(span.traceId, []);
    spansByTrace.get(span.traceId)!.push(span);
  }

  const traceEntries: KVEntry[] = [];
  for (const traceId of traceIds) {
    const traceEvals = evalsByTrace.get(traceId) ?? [];
    const spans = spansByTrace.get(traceId) ?? [];
    traceEntries.push({
      key: `evaluations:trace:${traceId}`,
      value: JSON.stringify({ evaluations: traceEvals }),
    });
    traceEntries.push({
      key: `trace:${traceId}`,
      value: JSON.stringify({ traceId, spans, evaluations: traceEvals }),
    });
  }
  console.log(`Computed ${traceEntries.length} trace KV entries`);

  const allEntries = [...entries, ...traceEntries];
  const totalComputed = allEntries.length;

  // ---- Delta sync: skip unchanged entries ----
  const prevState = loadSyncState();
  const changed = filterChanged(allEntries, prevState);
  console.log(`Computed ${totalComputed} total KV entries, ${changed.length} changed since last sync`);

  if (changed.length === 0) {
    // Still update lastSync timestamp
    const metaEntry: KVEntry = { key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) };
    if (prevState['meta:lastSync'] !== hashValue(metaEntry.value)) {
      kvBulkPut([metaEntry]);
      prevState['meta:lastSync'] = hashValue(metaEntry.value);
      saveSyncState(prevState);
    }
    console.log('No changes to sync');
    return;
  }

  // ---- Priority bucketing ----
  // Order: meta/dashboard/role → metrics → trends → traces
  const prioritize = (e: KVEntry): number => {
    if (e.key.startsWith('meta:') || e.key.startsWith('dashboard:')) return 0;
    if (e.key.startsWith('metric:')) return 1;
    if (e.key.startsWith('trend:')) return 2;
    return 3; // traces
  };
  changed.sort((a, b) => prioritize(a) - prioritize(b));

  // ---- Budget enforcement ----
  // +1 for meta:lastSync
  const budget = WRITE_BUDGET - 1;
  const toWrite = changed.slice(0, budget);
  const deferred = changed.length - toWrite.length;

  // Always include lastSync
  toWrite.push({ key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) });

  if (deferred > 0) {
    console.log(`Budget ${WRITE_BUDGET}: writing ${toWrite.length} entries, deferring ${deferred} to next run`);
  }

  const written = kvBulkPut(toWrite);

  // ---- Update state only for entries actually written ----
  const newState = { ...prevState };
  for (const e of toWrite.slice(0, written)) {
    newState[e.key] = hashValue(e.value);
  }
  // Prune keys from state that no longer exist in computed set
  const computedKeys = new Set(allEntries.map(e => e.key));
  computedKeys.add('meta:lastSync');
  for (const key of Object.keys(newState)) {
    if (!computedKeys.has(key)) delete newState[key];
  }
  saveSyncState(newState);

  console.log(`Sync complete: wrote ${written}/${totalComputed} entries (${totalComputed - written} deferred)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
