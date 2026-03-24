#!/usr/bin/env tsx
/**
 * Backtest orchestration script for degradation detector parameter sweep.
 *
 * Loads labeled incidents from .degradation-incidents.json, reads local evaluation
 * JSONL files, builds daily time-series snapshots per metric, and runs the full
 * 2500-config sweepDegradationParams sweep. Writes results to JSON and prints an
 * ASCII summary table.
 *
 * Gate: if best-F1 config outperforms production by ≥ F1_GRADUATION_THRESHOLD,
 * prints a recommendation to update CURRENT_PRODUCTION_CONFIG constants.
 *
 * Usage:
 *   tsx scripts/backtest-degradation.ts [--days=90] [--metric=relevance] [--output=backtest-results.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { z } from 'zod';
import { MultiDirectoryBackend } from '../../src/backends/local-jsonl.js';
import {
  computeStdDev,
  sweepDegradationParams,
  CURRENT_PRODUCTION_CONFIG,
  BACKTEST_SWEEP,
} from '../../src/lib/quality/quality-feature-engineering.js';
import type {
  LabeledIncident,
  BacktestSweepResult,
  BacktestConfig,
} from '../../src/lib/quality/quality-feature-engineering.js';
import { QUALITY_METRICS } from '../../src/lib/quality/quality-metrics.js';

const INCIDENTS_FILE = join(import.meta.dirname ?? process.cwd(), '.degradation-incidents.json');

const DAY_MS = 24 * 60 * 60 * 1000;
/** F1 improvement above which best config triggers graduation recommendation */
const F1_GRADUATION_THRESHOLD = 0.05;
/** Minimum incidents for a meaningful backtest (warns if below) */
const MIN_INCIDENTS_WARN = 5;

// ---- CLI args ----

function parseIntArg(argList: string[], flag: string, defaultValue: number): number {
  const match = argList.find(a => a.startsWith(`--${flag}=`));
  const eqIdx = match ? match.indexOf('=') : -1;
  const parsed = eqIdx !== -1 ? parseInt(match!.slice(eqIdx + 1), 10) : defaultValue;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseStringArg(argList: string[], flag: string): string | null {
  const match = argList.find(a => a.startsWith(`--${flag}=`));
  if (!match) return null;
  const eqIdx = match.indexOf('=');
  return eqIdx === -1 ? null : match.slice(eqIdx + 1);
}

const cliArgs = process.argv.slice(2);
const days = parseIntArg(cliArgs, 'days', 90);
const metricFilter = parseStringArg(cliArgs, 'metric');
const outputFile = basename(parseStringArg(cliArgs, 'output') ?? 'backtest-results.json');

if (metricFilter !== null && !(metricFilter in QUALITY_METRICS)) {
  console.error(`Unknown metric: "${metricFilter}". Valid: ${Object.keys(QUALITY_METRICS).join(', ')}`);
  process.exit(1);
}

// ---- Incidents ----

const labeledIncidentSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  severity: z.enum(['minor', 'major', 'critical']),
});

function loadIncidents(): LabeledIncident[] {
  if (!existsSync(INCIDENTS_FILE)) {
    console.error(`Incidents file not found: ${INCIDENTS_FILE}`);
    console.error('Create .degradation-incidents.json first (see FU-FE-R5-INCIDENT backlog item).');
    return [];
  }
  try {
    const raw = readFileSync(INCIDENTS_FILE, 'utf8');
    const data: unknown = JSON.parse(raw);
    const result = z.array(labeledIncidentSchema).safeParse(data);
    if (!result.success) {
      console.error('Invalid .degradation-incidents.json:', result.error.flatten().fieldErrors);
      return [];
    }
    return result.data;
  } catch (err) {
    console.error(`Failed to parse incidents file: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---- Time-series construction ----

interface DailyBucket {
  timestamp: number;
  scores: number[];
}

function buildDailyBuckets(
  evaluations: Array<{ timestamp: string; scoreValue: number }>,
  startMs: number,
  bucketCount: number,
): DailyBucket[] {
  const buckets: DailyBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    timestamp: startMs + i * DAY_MS,
    scores: [],
  }));
  for (const ev of evaluations) {
    const ts = new Date(ev.timestamp).getTime();
    const idx = Math.floor((ts - startMs) / DAY_MS);
    if (idx >= 0 && idx < bucketCount) {
      buckets[idx].scores.push(ev.scoreValue);
    }
  }
  return buckets;
}

type TimeSeriesPoint = {
  timestamp: number;
  currentStdDev: number;
  baselineStdDev: number;
  coverageGapCount: number;
  totalCoverageCells: number;
  latencyP95: number;
  latencyP50: number;
  historicalValues: number[];
};

/**
 * Convert daily buckets into time-series points for sweepDegradationParams.
 *
 * For each point i:
 * - currentStdDev: stddev of scores in bucket i
 * - baselineStdDev: stddev of scores in the first 70% of buckets [0..i]
 * - coverageGapCount: empty buckets in [0..i]
 * - totalCoverageCells: i + 1
 * - historicalValues: all scores seen up to and including bucket i (for EWMA drift)
 * - latencyP95/P50: 0 (not available from evaluation data)
 *
 * Uses running accumulators to avoid O(n²) repeated slicing.
 */
function buildTimeSeries(buckets: DailyBucket[]): TimeSeriesPoint[] {
  const cumulativeScores: number[] = [];
  const baselineScores: number[] = [];
  let baselineEnd = 0;
  let coverageGapCount = 0;

  return buckets.map((bucket, i) => {
    cumulativeScores.push(...bucket.scores);
    if (bucket.scores.length === 0) coverageGapCount++;

    // Extend baseline incrementally: baseline covers first 70% of [0..i]
    const newBaselineEnd = Math.max(1, Math.floor((i + 1) * 0.7));
    while (baselineEnd < newBaselineEnd) {
      baselineScores.push(...buckets[baselineEnd].scores);
      baselineEnd++;
    }

    return {
      timestamp: bucket.timestamp,
      currentStdDev: computeStdDev(bucket.scores) ?? 0,
      baselineStdDev: computeStdDev(baselineScores) ?? 0,
      coverageGapCount,
      totalCoverageCells: i + 1,
      latencyP95: 0,
      latencyP50: 0,
      historicalValues: [...cumulativeScores],
    };
  });
}

// ---- Output formatting ----

function formatConfig(cfg: BacktestConfig): string {
  const parts = [
    `var=${cfg.varianceThreshold}`,
    `drop=${cfg.coverageDropoutThreshold}`,
    `λ=${cfg.ewmaLambda ?? '-'}`,
    `win=${cfg.confirmationWindow}`,
    `stab=${cfg.stabilityThreshold ?? '-'}`,
  ];
  return parts.join(' ');
}

function printSummaryTable(metricName: string, result: BacktestSweepResult, evalCount: number): void {
  const { bestByF1, currentConfigResult, results } = result;
  const f1Gain = bestByF1.tapr.f1 - currentConfigResult.tapr.f1;

  console.log(`\n=== ${metricName} (${evalCount} evals, ${results.length} configs) ===`);
  console.log('Rank | Config                                      | TaPR-F1 | TaPR-P | TaPR-R | Delay');
  console.log('-----|---------------------------------------------|---------|--------|--------|------');

  const top5 = results
    .slice()
    .sort((a, b) => b.tapr.f1 - a.tapr.f1)
    .slice(0, 5);

  for (let rank = 0; rank < top5.length; rank++) {
    const r = top5[rank];
    const tag = r === currentConfigResult ? ' [prod]' : '';
    console.log(
      `${String(rank + 1).padStart(4)} | ${formatConfig(r.config).padEnd(43)} | ` +
      `${r.tapr.f1.toFixed(3)}  | ${r.tapr.precision.toFixed(3)}  | ` +
      `${r.tapr.recall.toFixed(3)}  | ${Math.round(r.tapr.detectionDelay)}ms${tag}`,
    );
  }

  console.log('');
  console.log(`Production: ${formatConfig(currentConfigResult.config)} → F1=${currentConfigResult.tapr.f1.toFixed(3)}`);
  console.log(`Best F1:    ${formatConfig(bestByF1.config)} → F1=${bestByF1.tapr.f1.toFixed(3)} (Δ${f1Gain >= 0 ? '+' : ''}${f1Gain.toFixed(3)})`);

  if (f1Gain >= F1_GRADUATION_THRESHOLD) {
    console.log('');
    console.log(`GRADUATION RECOMMENDED: best config outperforms production by +${f1Gain.toFixed(3)} F1`);
    console.log('  Update CURRENT_PRODUCTION_CONFIG in src/lib/quality/quality-feature-engineering.ts:');
    console.log(`    varianceThreshold:        ${bestByF1.config.varianceThreshold}`);
    console.log(`    coverageDropoutThreshold: ${bestByF1.config.coverageDropoutThreshold}`);
    if (bestByF1.config.ewmaLambda !== undefined) {
      console.log(`    ewmaLambda:               ${bestByF1.config.ewmaLambda}`);
    }
    console.log(`    confirmationWindow:       ${bestByF1.config.confirmationWindow}`);
    if (bestByF1.config.stabilityThreshold !== undefined) {
      console.log(`    stabilityThreshold:       ${bestByF1.config.stabilityThreshold}`);
    }
  }
}

// ---- Main ----

async function main(): Promise<void> {
  const incidents = loadIncidents();

  if (incidents.length < MIN_INCIDENTS_WARN) {
    console.warn(
      `Warning: only ${incidents.length} incident(s) loaded (${MIN_INCIDENTS_WARN} recommended for stable results).`,
    );
    if (incidents.length === 0) {
      console.warn('Running in zero-incident mode — all configs will score 0 F1 by definition.');
    }
  }

  console.log(`Backtest: ${days}-day window, ${incidents.length} incident(s), metric=${metricFilter ?? 'all'}`);

  const backend = new MultiDirectoryBackend(undefined, true);
  const now = Date.now();
  const startMs = now - days * DAY_MS;
  const startDate = new Date(startMs).toISOString();
  const endDate = new Date(now).toISOString();

  const metricNames = metricFilter
    ? [metricFilter]
    : Object.keys(QUALITY_METRICS);

  const allResults: Record<string, {
    sweepResult: BacktestSweepResult;
    evalCount: number;
    graduationRecommended: boolean;
  }> = {};

  for (const name of metricNames) {
    const rawEvals = await backend.queryEvaluations({
      evaluationName: name,
      startDate,
      endDate,
      limit: 100_000,
    });

    const evaluations = rawEvals.filter(
      (e): e is typeof e & { scoreValue: number } => e.scoreValue !== undefined,
    );

    if (evaluations.length === 0) {
      console.log(`  ${name}: no evaluations in window, skipping`);
      continue;
    }

    const dailyBuckets = buildDailyBuckets(evaluations, startMs, days);
    const timeSeries = buildTimeSeries(dailyBuckets);
    const sweepResult = sweepDegradationParams(timeSeries, incidents);
    const f1Gain = sweepResult.bestByF1.tapr.f1 - sweepResult.currentConfigResult.tapr.f1;

    allResults[name] = {
      sweepResult,
      evalCount: evaluations.length,
      graduationRecommended: f1Gain >= F1_GRADUATION_THRESHOLD,
    };

    printSummaryTable(name, sweepResult, evaluations.length);
  }

  if (Object.keys(allResults).length === 0) {
    console.log('\nNo metrics had evaluation data in the requested window.');
    return;
  }

  const outputPath = join(import.meta.dirname ?? process.cwd(), outputFile);
  const totalSweepGrid = Object.values(BACKTEST_SWEEP).reduce((acc, arr) => acc * arr.length, 1);

  writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    days,
    incidentCount: incidents.length,
    sweepGridSize: totalSweepGrid,
    productionConfig: CURRENT_PRODUCTION_CONFIG,
    metrics: Object.fromEntries(
      Object.entries(allResults).map(([metricName, { sweepResult, evalCount, graduationRecommended }]) => [
        metricName,
        {
          evalCount,
          graduationRecommended,
          currentConfigResult: sweepResult.currentConfigResult,
          bestByF1: sweepResult.bestByF1,
          bestByRecall: sweepResult.bestByRecall,
          top10ByF1: sweepResult.results
            .slice()
            .sort((a, b) => b.tapr.f1 - a.tapr.f1)
            .slice(0, 10),
        },
      ])
    ),
  }, null, 2));

  console.log(`\nResults written to ${outputPath}`);

  const graduationCount = Object.values(allResults).filter(r => r.graduationRecommended).length;
  if (graduationCount > 0) {
    console.log(`\n${graduationCount} metric(s) recommend threshold graduation — see above.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
