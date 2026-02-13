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
  getQualityMetric,
  QUALITY_METRICS,
} from '../../dist/lib/quality-metrics.js';
import type { RoleViewType, QualityMetricConfig } from '../../dist/lib/quality-metrics.js';

const NAMESPACE_ID = '902fc8a43e7147b486b6376c485c4506';

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

function kvBulkPut(entries: KVEntry[]): void {
  if (entries.length === 0) return;
  const tmpFile = join(tmpdir(), `kv-sync-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(entries));
    if (dryRun) {
      for (const e of entries) {
        console.log(`[dry-run] PUT ${e.key} (${e.value.length} bytes)`);
      }
      return;
    }
    execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', tmpFile, '--namespace-id', NAMESPACE_ID, '--remote'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    for (const e of entries) {
      console.log(`PUT ${e.key} (${e.value.length} bytes)`);
    }
  } finally {
    try { unlinkSync(tmpFile); } catch {}
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
    const evals = await backend.queryEvaluations({
      startDate: dates.start,
      endDate: dates.end,
      limit: 10000,
    });

    const grouped = new Map<string, typeof evals>();
    for (const ev of evals) {
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
    const evals = await backend.queryEvaluations({
      startDate: weekAgo.toISOString(),
      endDate: now.toISOString(),
      evaluationName: name,
      limit: 10000,
    });
    if (evals.length === 0) continue;
    const detail = computeMetricDetail(evals, config as QualityMetricConfig, {
      topN: 5,
      bucketCount: 10,
    });
    entries.push({ key: `metric:${name}`, value: JSON.stringify(detail) });
  }

  entries.push({ key: 'meta:lastSync', value: JSON.stringify(now.toISOString()) });

  console.log(`Computed ${entries.length} KV entries`);
  kvBulkPut(entries);
  console.log(`Sync complete: ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
