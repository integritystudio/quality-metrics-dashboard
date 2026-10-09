/** Judge failure classification, the run summary and its exit verdict, and run state. */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { PERCENT_MULTIPLIER } from '../../src/lib/core/units.js';
import { JUDGE_EXIT_BILLING, JUDGE_EXIT_NO_SCORES, JUDGE_EXIT_HIGH_FAILURE_RATE, JUDGE_EXIT_BATCH_WALL_CLOCK } from './pipeline-stages.js';
import type { JudgeApiKeySource } from './judge-credentials.js';
import { EVAL_SCORE_PRECISION } from './eval-record.js';
import { TELEMETRY_DIR } from './evaluation-constants.js';
import { judgePricing, tokenUsageCostUsd, type JudgeTokenUsage } from './judge-usage.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';

/** Track evaluation failures for summary reporting */
export const evalFailures: Record<string, number> = {};

export const JUDGE_FAILURE_CLASSES = ['billing', 'network', 'schema-rejection', 'parse', 'invalid-input', 'wall-clock', 'other'] as const;

export type JudgeFailureClass = typeof JUDGE_FAILURE_CLASSES[number];

function zeroFailureClasses(): Record<JudgeFailureClass, number> {
  return Object.fromEntries(JUDGE_FAILURE_CLASSES.map(cls => [cls, 0])) as Record<JudgeFailureClass, number>;
}

/** Failures by cause across all metrics — what decides the exit code. */
export const failureClasses: Record<JudgeFailureClass, number> = zeroFailureClasses();

/**
 * The batch provider's `BatchWallClockExceededError`: the run's wall clock ran
 * out and the batch was cancelled before this call was answered. Nothing is
 * wrong with the call; the next run judges the turn. Matched on the whole
 * phrase, so a model reply quoted in some other error cannot land here.
 */
export const WALL_CLOCK_FAILURE_PATTERN = /still processing at the \d+ms wall clock/;

export const BILLING_FAILURE_PATTERN = /credit balance|billing|payment required|insufficient (?:funds|credit)/i;

export const NETWORK_FAILURE_PATTERN = /Connection error|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|timed out/i;

/**
 * Matches API 400s that rejected the request because of the output_config JSON
 * schema — e.g. unsupported keywords like minimum/maximum on an integer field.
 * Distinct from `parse` failures, which are about decoding the model's output;
 * this class means the request shape was wrong.
 */
export const SCHEMA_REJECTION_PATTERN = /output_config|json_schema.*format|schema.*keyword|unsupported.*schema/i;

export const INVALID_INPUT_FAILURE_PATTERN = /Invalid TestCase|Invalid GEvalConfig/;

export const PARSE_FAILURE_PATTERN = /below minimum|not valid JSON|Unexpected token|Invalid normalized score|Could not (?:extract|parse)/i;

/**
 * Bucket a judge error by what would fix it: money, the network, the request
 * schema, the parser, the input this script built, or another run. The wall
 * clock is checked first because its message is this pipeline's own and
 * carries a batch id, which must not be read as anything else.
 */
export function classifyJudgeFailure(message: string): JudgeFailureClass {
  if (WALL_CLOCK_FAILURE_PATTERN.test(message)) return 'wall-clock';
  if (BILLING_FAILURE_PATTERN.test(message)) return 'billing';
  if (NETWORK_FAILURE_PATTERN.test(message)) return 'network';
  if (SCHEMA_REJECTION_PATTERN.test(message)) return 'schema-rejection';
  if (INVALID_INPUT_FAILURE_PATTERN.test(message)) return 'invalid-input';
  if (PARSE_FAILURE_PATTERN.test(message)) return 'parse';
  return 'other';
}

export function resetFailureTracking(): void {
  for (const key of Object.keys(evalFailures)) delete evalFailures[key];
  for (const cls of JUDGE_FAILURE_CLASSES) failureClasses[cls] = 0;
}

/** Count a failed criterion; with `sessionPreview`, also log the per-criterion warning line. */
export function trackFailure(metric: string, err: unknown, sessionPreview?: string): void {
  const message = describeUnknown(err);
  evalFailures[metric] = (evalFailures[metric] ?? 0) + 1;
  failureClasses[classifyJudgeFailure(message)] += 1;
  if (sessionPreview !== undefined) console.warn(`  [${metric}] Error for ${sessionPreview}: ${message}`);
}

/** Failure rate above which a run is flagged as JUDGE_EXIT_HIGH_FAILURE_RATE. */
export const HIGH_FAILURE_RATE_THRESHOLD = 0.5;

/**
 * Success-rate fall, in absolute points, that flags a run against the previous
 * one. Above the whole pre-fix failure rate (18–22%) and far above its
 * run-to-run swing (81.5% → 78.2% on 2026-09-21), so returning from a clean run
 * to that old baseline stays quiet.
 */
export const SUCCESS_RATE_DROP_THRESHOLD = 0.25;

/** Attempts both runs need before their rates are compared; at 50, one failure moves the rate 2 points. */
export const RATE_COMPARISON_MIN_ATTEMPTS = 50;

/** Path to the sidecar that records each run's succeeded count for the drop check. */
export const JUDGE_RUN_STATE_FILE = join(TELEMETRY_DIR, '.judge-run-state.json');

/** What a run spent, for the summary line. */
export interface JudgeSpend {
  /** Totals folded from every `response.usage` the run saw. */
  usage: JudgeTokenUsage;
  /** What estimateJudgeRun said before the run spent anything. */
  estimatedUsd: number;
  /** Environment variable NAME the key came from — never the value. */
  keySource: JudgeApiKeySource;
}

export interface JudgeRunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  byClass: Record<JudgeFailureClass, number>;
  /** Token totals the API reported, and what they cost at list rates. */
  usage: JudgeTokenUsage;
  estimatedUsd: number;
  actualUsd: number;
  /** Environment variable NAME the key came from — never the value. */
  keySource: JudgeApiKeySource;
  /** 0 when the run produced scores and saw no billing refusal. */
  exitCode: number;
  /** The one line the log gets, verdict included. */
  line: string;
}

/**
 * What the run did and how loudly to say so. A billing refusal wins — nothing
 * else in the run can be trusted and the fix is external. A run that attempted
 * evaluations and produced none is a failure too, never a success. A `--batch`
 * run cut short by its wall clock says so with its own code, whatever share of
 * it was scored: the run did not fail, it ran out of time, and what it scored
 * is kept (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN). The spend block beside the
 * verdict is what the run cost from the usage the API reported, next to the
 * pre-run estimate and the NAME of the key it was billed to.
 */
export function summarizeJudgeRun(
  succeeded: number,
  byMetric: Record<string, number>,
  byClass: Record<JudgeFailureClass, number>,
  spend: JudgeSpend,
  prev?: JudgeRunState,
): JudgeRunSummary {
  const failed = Object.values(byMetric).reduce((sum, n) => sum + n, 0);
  const attempted = succeeded + failed;
  const successRate = attempted > 0 ? succeeded / attempted : 0;
  const prevRate = prev && prev.attempted > 0 ? prev.succeeded / prev.attempted : undefined;
  const classes = JUDGE_FAILURE_CLASSES.filter(c => byClass[c] > 0).map(c => `${c}=${byClass[c]}`).join(' ') || 'none';
  let exitCode = 0;
  let verdict = 'ok';
  if (byClass.billing > 0) {
    exitCode = JUDGE_EXIT_BILLING;
    verdict = 'BILLING REFUSED — no judge output from this run can be trusted; top up credit before re-running';
  } else if (byClass['wall-clock'] > 0) {
    // Ahead of the verdicts below: abandoned evaluations count as failed, so
    // an overrun would otherwise be reported as a failure rate.
    exitCode = JUDGE_EXIT_BATCH_WALL_CLOCK;
    verdict = `BATCH WALL CLOCK EXCEEDED — ${byClass['wall-clock']} evaluations were abandoned with the cancelled batch and wait for the next run; the ${succeeded} scored before it are kept`;
  } else if (attempted > 0 && succeeded === 0) {
    exitCode = JUDGE_EXIT_NO_SCORES;
    verdict = 'NO SCORES PRODUCED — every evaluation failed';
  } else if (attempted > 0 && failed / attempted > HIGH_FAILURE_RATE_THRESHOLD) {
    exitCode = JUDGE_EXIT_HIGH_FAILURE_RATE;
    verdict = `HIGH FAILURE RATE — ${failed} of ${attempted} evaluations failed (${(failed / attempted * PERCENT_MULTIPLIER).toFixed(1)}%); check failure classes above`;
  } else if (
    prev !== undefined &&
    prevRate !== undefined &&
    prev.attempted >= RATE_COMPARISON_MIN_ATTEMPTS &&
    attempted >= RATE_COMPARISON_MIN_ATTEMPTS &&
    prevRate - successRate > SUCCESS_RATE_DROP_THRESHOLD
  ) {
    // Rates, not counts: a run with fewer new turns scores fewer evaluations
    // without anything having failed, and a count comparison called that a drop.
    exitCode = JUDGE_EXIT_HIGH_FAILURE_RATE;
    verdict = `SUCCESS RATE DROP — ${(successRate * PERCENT_MULTIPLIER).toFixed(1)}% of ${attempted} succeeded vs ${(prevRate * PERCENT_MULTIPLIER).toFixed(1)}% of ${prev.attempted} on the previous run; check for a new failure class`;
  }
  const { usage, estimatedUsd, keySource } = spend;
  const actualUsd = tokenUsageCostUsd(usage, judgePricing());
  const spent = `usage: in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadInputTokens} cache_creation=${usage.cacheCreationInputTokens} est=$${estimatedUsd.toFixed(EVAL_SCORE_PRECISION)} actual=$${actualUsd.toFixed(EVAL_SCORE_PRECISION)} key=${keySource}`;
  const line = `[judge] summary: attempted=${attempted} succeeded=${succeeded} failed=${failed} classes: ${classes} ${spent} — ${verdict}`;
  return { attempted, succeeded, failed, byClass: { ...byClass }, usage: { ...usage }, estimatedUsd, actualUsd, keySource, exitCode, line };
}

const judgeRunStateSchema = z.object({
  succeeded: z.number(),
  attempted: z.number(),
  timestamp: z.string().optional(),
});

export type JudgeRunState = z.infer<typeof judgeRunStateSchema>;

/**
 * Read the previous run's state from the sidecar file. Returns undefined when
 * the file is absent (first run), unreadable, or written before `attempted` was
 * recorded — a count alone cannot give a rate. Never throws.
 */
export function readRunState(path: string = JUDGE_RUN_STATE_FILE): JudgeRunState | undefined {
  try {
    const parsed = judgeRunStateSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    if (parsed.success) return parsed.data;
  } catch { /* file missing, unreadable, or corrupt — first run or interrupted */ }
  return undefined;
}

/**
 * Persist this run's counts for the rate comparison on the next run. Best-effort —
 * a write failure must not fail the pipeline.
 */
export function writeRunState(succeeded: number, attempted: number, path: string = JUDGE_RUN_STATE_FILE): void {
  try {
    writeFileSync(path, JSON.stringify({ succeeded, attempted, timestamp: new Date().toISOString() }), 'utf-8');
  } catch { /* best effort; drop check will be skipped next run */ }
}
