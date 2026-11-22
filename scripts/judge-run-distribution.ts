#!/usr/bin/env tsx
/**
 * Per-run, per-criterion score distribution of judge rows across every org, read
 * from D1 with wrangler (one read-only SELECT). For comparing scheduled judge runs,
 * such as judge-model-tiers Phase 0's acceptance check.
 *
 * A row belongs to the scheduled run whose start is the latest at or before its
 * ingest receipt time (the `z<ms>` in `r2_key`), in this machine's local time.
 * A single OBTOOL_API_KEY sees only its own org, hence D1 rather than obtool-api.
 *
 * Needs wrangler's own login, not `doppler run`: the Doppler `prd` Cloudflare
 * token cannot read D1.
 *
 * Usage:
 *   npx tsx scripts/judge-run-distribution.ts --since 2026-11-21 [--evaluator dashboard:judge-consolidated] [--json]
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { max } from 'd3-array';
import { BYTES, TIME_MS } from '../../src/lib/core/units.js';
import { CliArgError, exitOnCliArgError, parseCli } from './cli-args.js';
import { runIfMain } from './cli-main.js';
import { EVALUATION_ATTRS } from './eval-record.js';
import { CONSOLIDATED_PRODUCER } from './judge-consolidated.js';

export const SINCE_FLAG = '--since';
export const EVALUATOR_FLAG = '--evaluator';
export const JSON_FLAG = '--json';
const LOG_PREFIX = '[judge-run-distribution]';

const MORNING_RUN_HOUR = 6;
const EVENING_RUN_HOUR = 18;
/** The launchd schedule's start hours, ascending (`scripts/launchd/` in the parent). */
export const SCHEDULED_RUN_HOURS = [MORNING_RUN_HOUR, EVENING_RUN_HOUR] as const;
const HOUR_MS = TIME_MS.HOUR;
const D1_DATABASE = 'obtool-telemetry-db';
const INGEST_SERVICE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'services', 'obtool-ingest');
const WRANGLER_MAX_BUFFER_MB = 64;
const WRANGLER_MAX_BUFFER_BYTES = WRANGLER_MAX_BUFFER_MB * BYTES.MB;
/** Evaluator names are interpolated into the SQL (wrangler takes no bound parameters). */
const EVALUATOR_PATTERN = /^[a-z][\w:-]*$/i;
const RECEIPT_MS_SQL = "CAST(substr(r2_key, instr(r2_key, '/z') + 2, 13) AS INTEGER)";
const JUDGE_ATTR_PREFIX = EVALUATION_ATTRS.JUDGE_PROVIDER.slice(0, EVALUATION_ATTRS.JUDGE_PROVIDER.lastIndexOf('.') + 1);
const MEAN_DIGITS = 3;
/** Fixed-width score keys, so a distribution keeps its ascending order (integer-like keys would sort first). */
const SCORE_KEY_DIGITS = 2;
const PAD_LABEL = 16;
const NO_MODEL = '(none)';

/** One D1 group: rows received in one hour sharing a criterion, score and model. */
export type ReceiptGroup = {
  hour_ms: number;
  evaluation_name: string;
  score_value: number | null;
  judge_model: string | null;
  has_judge_attrs: number;
  n: number;
};

export type CriterionSummary = { n: number; mean: number | null; dist: Record<string, number> };

export type RunSummary = {
  rows: number;
  judgeModels: Record<string, number>;
  withJudgeAttrs: number;
  criteria: Record<string, CriterionSummary>;
};

/** `YYYY-MM-DD HH:00` (local) of the latest scheduled run start at or before `receiptMs`. */
export function scheduledRunLabel(receiptMs: number, runHours: readonly number[] = SCHEDULED_RUN_HOURS): string {
  const received = new Date(receiptMs);
  const startHour = [...runHours].reverse().find(hour => hour <= received.getHours());
  const start = new Date(received);
  if (startHour === undefined) {
    start.setDate(start.getDate() - 1);
    start.setHours(max(runHours) ?? 0, 0, 0, 0);
  } else {
    start.setHours(startHour, 0, 0, 0);
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:00`;
}

function summarizeCriterion(dist: Map<number | null, number>): CriterionSummary {
  let n = 0;
  let scored = 0;
  let total = 0;
  for (const [score, count] of dist) {
    n += count;
    if (score === null) continue;
    scored += count;
    total += score * count;
  }
  const ordered = [...dist].toSorted(([a], [b]) => (a ?? Infinity) - (b ?? Infinity));
  return {
    n,
    mean: scored === 0 ? null : Number((total / scored).toFixed(MEAN_DIGITS)),
    dist: Object.fromEntries(ordered.map(([score, count]) => [score === null ? String(score) : score.toFixed(SCORE_KEY_DIGITS), count])),
  };
}

/** Folds receipt-hour groups into scheduled runs, keyed and ordered by run label. */
export function summarizeRuns(groups: readonly ReceiptGroup[], runHours: readonly number[] = SCHEDULED_RUN_HOURS): Record<string, RunSummary> {
  type RunAccumulator = { rows: number; models: Map<string, number>; withJudgeAttrs: number; criteria: Map<string, Map<number | null, number>> };
  const runs = new Map<string, RunAccumulator>();
  for (const group of groups) {
    const label = scheduledRunLabel(group.hour_ms, runHours);
    let run = runs.get(label);
    if (!run) {
      run = { rows: 0, models: new Map(), withJudgeAttrs: 0, criteria: new Map() };
      runs.set(label, run);
    }
    run.rows += group.n;
    const model = group.judge_model ?? NO_MODEL;
    run.models.set(model, (run.models.get(model) ?? 0) + group.n);
    if (group.has_judge_attrs) run.withJudgeAttrs += group.n;
    let dist = run.criteria.get(group.evaluation_name);
    if (!dist) {
      dist = new Map();
      run.criteria.set(group.evaluation_name, dist);
    }
    dist.set(group.score_value, (dist.get(group.score_value) ?? 0) + group.n);
  }
  return Object.fromEntries([...runs].toSorted(([a], [b]) => a.localeCompare(b)).map(([label, run]) => [label, {
    rows: run.rows,
    judgeModels: Object.fromEntries(run.models),
    withJudgeAttrs: run.withJudgeAttrs,
    criteria: Object.fromEntries([...run.criteria].toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, dist]) => [name, summarizeCriterion(dist)])),
  }]));
}

/** The grouped SELECT; `evaluator` must already match EVALUATOR_PATTERN. */
export function receiptGroupsSql(evaluator: string, sinceMs: number): string {
  return `SELECT (${RECEIPT_MS_SQL} / ${HOUR_MS}) * ${HOUR_MS} AS hour_ms, evaluation_name, score_value, judge_model, `
    + `attributes LIKE '%${JUDGE_ATTR_PREFIX}%' AS has_judge_attrs, COUNT(*) AS n `
    + `FROM evaluations WHERE evaluator = '${evaluator}' AND instr(r2_key, '/z') > 0 AND ${RECEIPT_MS_SQL} >= ${sinceMs} `
    + 'GROUP BY 1, 2, 3, 4, 5';
}

export type RunDistributionArgs = { sinceMs: number; evaluator: string; json: boolean };

/** Throws `CliArgError` on a missing or unparseable `--since`, a malformed evaluator, or anything undeclared. */
export function parseRunDistributionArgs(argv: readonly string[]): RunDistributionArgs {
  const cli = parseCli(argv, { values: [SINCE_FLAG, EVALUATOR_FLAG], switches: [JSON_FLAG] }, { allowUnknown: false });
  const since = cli.value(SINCE_FLAG);
  if (since === undefined) throw new CliArgError(`${SINCE_FLAG} <date or ISO time> is required`);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) throw new CliArgError(`${SINCE_FLAG} "${since}" is not a date`);
  const evaluator = cli.value(EVALUATOR_FLAG) ?? CONSOLIDATED_PRODUCER;
  if (!EVALUATOR_PATTERN.test(evaluator)) throw new CliArgError(`${EVALUATOR_FLAG} "${evaluator}" is not an evaluator name`);
  return { sinceMs, evaluator, json: cli.has(JSON_FLAG) };
}

async function queryD1(sql: string): Promise<ReceiptGroup[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'npx',
      ['wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json', '--command', sql],
      { cwd: INGEST_SERVICE_DIR, maxBuffer: WRANGLER_MAX_BUFFER_BYTES, encoding: 'utf8' },
      (err, out) => {
        if (err) reject(new Error(`wrangler d1 execute ${D1_DATABASE} failed`, { cause: err }));
        else resolve(out);
      },
    );
  });
  const [result] = JSON.parse(stdout) as [{ results: ReceiptGroup[] }];
  return result.results;
}

function printRuns(runs: Record<string, RunSummary>): void {
  for (const [label, run] of Object.entries(runs)) {
    const models = Object.entries(run.judgeModels).map(([model, n]) => `${model}=${n}`).join(' ');
    console.log(`${label}  rows=${run.rows}  judge.*=${run.withJudgeAttrs}/${run.rows}  ${models}`);
    for (const [name, c] of Object.entries(run.criteria)) {
      const dist = Object.entries(c.dist).map(([score, n]) => `${score}:${n}`).join(' ');
      console.log(`  ${name.padEnd(PAD_LABEL)} n=${c.n}  mean=${c.mean ?? 'n/a'}  ${dist}`);
    }
  }
}

async function main(): Promise<void> {
  const { sinceMs, evaluator, json } = exitOnCliArgError(LOG_PREFIX, () => parseRunDistributionArgs(process.argv.slice(2)));
  const runs = summarizeRuns(await queryD1(receiptGroupsSql(evaluator, sinceMs)));
  if (json) console.log(JSON.stringify(runs, null, 1));
  else printRuns(runs);
}

runIfMain(import.meta.url, main, LOG_PREFIX);
