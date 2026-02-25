#!/usr/bin/env tsx
/**
 * Sync pre-computed dashboard data to Cloudflare Workers KV.
 *
 * Reads local JSONL evaluations, runs quality-metrics computations,
 * and uploads results via `wrangler kv bulk put` (works with both
 * local OAuth session and CLOUDFLARE_API_TOKEN in CI).
 *
 * Usage: tsx scripts/sync-to-kv.ts [--days=30] [--dry-run]
 */

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
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

const PERIODS = ['24h', '7d', '30d'] as const;
const ROLES: RoleViewType[] = ['executive', 'operator', 'auditor'];
const PERIOD_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

type KVEntry = { key: string; value: string };

const KV_BATCH_SIZE = 9_500; // wrangler limit is 10,000 per bulk put

function kvBulkPut(entries: KVEntry[]): void {
  if (entries.length === 0) return;
  // Batch into chunks to stay under wrangler's 10,000 entry limit
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
        continue;
      }
      try {
        execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', tmpFile, '--namespace-id', NAMESPACE_ID, '--remote'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Wrangler KV bulk put failed for ${batch.length} entries${batchLabel}. Ensure wrangler is installed and authenticated. Error: ${msg}`);
      }
      console.log(`PUT ${batch.length} entries${batchLabel}`);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
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

  entries.push({ key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) });

  console.log(`Computed ${entries.length + traceEntries.length} total KV entries`);
  // Bulk put in batches (wrangler limit: 10,000 per call)
  kvBulkPut(entries);
  if (traceEntries.length > 0) {
    kvBulkPut(traceEntries);
  }
  console.log(`Sync complete: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
