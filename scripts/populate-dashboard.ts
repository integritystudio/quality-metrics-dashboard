#!/usr/bin/env tsx
/**
 * Single-command pipeline to populate all 7 dashboard metrics.
 *
 * Steps:
 *   0. hook-gap-check      → flags background sessions whose turns ran without hooks
 *                            (local transcripts, read-only; runs with the judge,
 *                            `--skip-hook-gap-check` skips it)
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion)
 *                            over the cloud's last 7 days of spans, the last 2 days
 *                            POSTed to ingest (`--days=7 --post-days=2`)
 *   2. ship-turn-content   → redacted turn text from this machine's transcripts,
 *                            POSTed to ingest per account over the judge's scope
 *                            (runs with the judge; `--skip-ship-turns` skips it)
 *   3. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *                            over turns the cloud lists for the last 7 days
 *                            (`--days=7`), POSTed to ingest
 *   4. sync-to-kv          → aggregate + upload to Cloudflare KV
 *
 * Step 4 reads only the *cloud* (`CloudBackend.queryEvaluations`, source
 * `'table'`). Steps 1-2 post their own records, and the hooks' records reach it
 * as log events through the span shipper.
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs LLM_JUDGE_ANTHROPIC_KEY or ANTHROPIC_API_KEY; exits 1 without one)
 *   npm run populate -- --dry-run             # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based + sync only
 *   npm run populate -- --skip-derive --skip-judge --sync-budget 700
 *                                             # refresh only: sync, capped KV writes (the hourly launchd job)
 *   npm run populate -- --skip-sync           # derive + judge only
 *   npm run populate -- --limit 5             # judge at most 5 turns
 *   npm run populate -- --batch               # judge through the Message Batches API (half price, unattended)
 *   npm run populate -- --per-criterion       # one call per criterion (~10x cost, opt-out of consolidated)
 *   npm run populate -- --judge-days=30       # judge turns from the last 30 days instead of 7
 *   npm run populate -- --derive-days=14      # derive over the last 14 days instead of 7
 *
 * Exit codes (read by the launchd wrapper, which logs FAILED for anything non-zero):
 *   0     every stage succeeded
 *   3-15  a stage's soft failure, forwarded after the remaining stages still
 *         ran; each code is documented on its constant in pipeline-stages.ts
 *   1     any other stage failure, and the pipeline stops there. Also: no judge
 *         key and no --skip-judge given, so nothing runs
 *
 * derive-evaluations and sync-to-kv are retried on transient
 * network failures with the bounded schedule in pipeline-stages.ts.
 */

import { sum } from 'd3-array';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DRY_RUN_FLAG,
  SYNC_BUDGET_FLAG,
  JUDGE_BATCH_FLAG,
  JUDGE_LIMIT_FLAG,
  JUDGE_PER_CRITERION_FLAG,
  rejectRemovedFlags,
  SYNC_RETRY_DELAYS_MS,
  deriveScopeArgs,
  isTransientNetworkFailure,
  judgeScopeArgs,
  nextStepAfter,
  runWithRetry,
  type PipelineStage,
} from './pipeline-stages.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV, resolveJudgeApiKey } from './judge-credentials.js';
import { exitOnCliArgError, parseCli, positiveIntArg, type CliSpec } from './cli-args.js';
import { BYTES, TIME_MS } from '../../src/lib/core/units.js';

const SCRIPTS_DIR = import.meta.dirname;
const DIST_DIR = join(SCRIPTS_DIR, '..', '..', 'dist');
/** Captured stderr ceiling per stage; a stack trace plus warnings is kilobytes, not megabytes. */
// eslint-disable-next-line local/no-magic-numbers-ignore-bitwise -- the multiplier is the named constant's value
const STDERR_CAPTURE_MAX_BYTES = 16 * BYTES.MB;

const SKIP_DERIVE_FLAG = '--skip-derive';
const SKIP_JUDGE_FLAG = '--skip-judge';
const SKIP_SYNC_FLAG = '--skip-sync';
const SKIP_SHIP_TURNS_FLAG = '--skip-ship-turns';
const SKIP_HOOK_GAP_CHECK_FLAG = '--skip-hook-gap-check';
/** Forwarded to sync-to-kv as `--budget=<n>`; unset leaves sync's own default. */
const SYNC_BUDGET_ARG = '--sync-budget';
const POPULATE_CLI: CliSpec = {
  values: [JUDGE_LIMIT_FLAG, SYNC_BUDGET_ARG],
  switches: [
    SKIP_DERIVE_FLAG, SKIP_JUDGE_FLAG, SKIP_SYNC_FLAG, SKIP_SHIP_TURNS_FLAG, SKIP_HOOK_GAP_CHECK_FLAG, DRY_RUN_FLAG,
    JUDGE_BATCH_FLAG, JUDGE_PER_CRITERION_FLAG,
  ],
};

/**
 * The run's switches and each stage's scope. Both stages read the cloud over
 * the last week unless --derive-days= / --judge-days= say otherwise. Read before any stage runs, so a bad flag stops
 * the run before derive.
 */
type PopulateArgs = {
  skipDerive: boolean;
  skipJudge: boolean;
  skipShipTurns: boolean;
  skipHookGapCheck: boolean;
  skipSync: boolean;
  dryRun: boolean;
  batch: boolean;
  perCriterion: boolean;
  limit: string | undefined;
  syncBudget: number | undefined;
  deriveScope: string[];
  judgeScope: string[];
};

function readArgs(argv: readonly string[]): PopulateArgs {
  rejectRemovedFlags(argv);
  const cli = parseCli(argv, POPULATE_CLI);
  const limit = positiveIntArg(JUDGE_LIMIT_FLAG, cli.value(JUDGE_LIMIT_FLAG));
  return {
    skipDerive: cli.has(SKIP_DERIVE_FLAG),
    skipJudge: cli.has(SKIP_JUDGE_FLAG),
    skipShipTurns: cli.has(SKIP_SHIP_TURNS_FLAG),
    skipHookGapCheck: cli.has(SKIP_HOOK_GAP_CHECK_FLAG),
    skipSync: cli.has(SKIP_SYNC_FLAG),
    dryRun: cli.has(DRY_RUN_FLAG),
    batch: cli.has(JUDGE_BATCH_FLAG),
    perCriterion: cli.has(JUDGE_PER_CRITERION_FLAG),
    limit: limit === undefined ? undefined : String(limit),
    syncBudget: positiveIntArg(SYNC_BUDGET_ARG, cli.value(SYNC_BUDGET_ARG)),
    deriveScope: deriveScopeArgs(argv),
    judgeScope: judgeScopeArgs(argv),
  };
}

const { skipDerive, skipJudge, skipShipTurns, skipHookGapCheck, skipSync, dryRun, batch, perCriterion, limit, syncBudget, deriveScope, judgeScope } =
  exitOnCliArgError('[populate] Error:', () => readArgs(process.argv.slice(2)));

// Fail closed when the judge would run with no key: never fall back to
// synthetic scores, which fill the dashboard with plausible numbers while every
// stage reports success. --skip-judge leaves judge metrics out.
// resolveJudgeApiKey counts both credential names.
// Dry runs are exempt: the judge's own --dry-run spends nothing.
if (!skipJudge && !dryRun && !resolveJudgeApiKey()) {
  console.error(
    `[populate] Error: neither ${JUDGE_API_KEY_ENV} nor ${DEFAULT_API_KEY_ENV} is set, so the ` +
    'judge cannot run. Refusing to fall back to synthetic scores: a seeded dashboard looks ' +
    'populated and is fabricated. Set the key (e.g. run under `doppler run --project ' +
    'integrity-studio --config prd`), or pass --skip-judge to leave judge metrics out.',
  );
  process.exit(1);
}

// Preflight: dist/ must exist for sync-to-kv (imports compiled quality-metrics)
if (!skipSync && !existsSync(DIST_DIR)) {
  console.error(`[populate] Error: ${DIST_DIR} not found. Run \`npm run build\` in the parent observability-toolkit first.`);
  process.exit(1);
}

type StepResult = { name: string; ms: number }
const results: StepResult[] = [];

type StepOutcome =
  | { ok: true; ms: number }
  | { ok: false; ms: number; status: number | null; stderr: string };

/**
 * Run one stage as a child process. With `captureStderr` the child's stderr is
 * buffered and replayed after it exits — the log keeps every line, and the
 * caller can classify the failure. The judge runs for an hour, so only the
 * short stages opt in.
 */
function runStep(name: string, script: string, extraArgs: string[] = [], captureStderr = false): StepOutcome {
  const start = performance.now();
  const child = spawnSync('npx', ['tsx', join(SCRIPTS_DIR, script), ...extraArgs], {
    stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'],
    cwd: join(SCRIPTS_DIR, '..'),
    encoding: 'utf8',
    maxBuffer: STDERR_CAPTURE_MAX_BYTES,
  });
  const ms = Math.round(performance.now() - start);
  // Typed as string for encoding 'utf8', but null when stderr was inherited.
  const stderr = typeof child.stderr === 'string' ? child.stderr : '';
  if (stderr) process.stderr.write(stderr);
  if (child.error) {
    return { ok: false, ms, status: child.status, stderr: `${stderr}\n${child.error.message}` };
  }
  if (child.status !== 0) {
    return { ok: false, ms, status: child.status, stderr };
  }
  results.push({ name, ms });
  return { ok: true, ms };
}

/**
 * Run a stage that needs the network, waiting out transient failures (DNS,
 * reset connections) on the schedule sized for the evening outages.
 */
async function runWithNetworkRetry(name: string, script: string, extraArgs: string[] = []): Promise<StepOutcome> {
  return runWithRetry<StepOutcome>({
    attempt: () => runStep(name, script, extraArgs, true),
    shouldRetry: outcome => !outcome.ok && isTransientNetworkFailure(outcome.stderr),
    delaysMs: SYNC_RETRY_DELAYS_MS,
    onRetry: (waitMs, failedAttempt, totalAttempts) => {
      console.error(`[populate] ${name} attempt ${failedAttempt}/${totalAttempts} failed on a transient network error; retrying in ${Math.round(waitMs / TIME_MS.SECOND)} s`);
    },
  });
}

function abort(name: string, outcome: Extract<StepOutcome, { ok: false }>): never {
  console.error(`[populate] ${name} failed with exit ${outcome.status ?? 'signal'} after ${outcome.ms} ms; stopping here`);
  process.exit(1);
}

let pipelineExitCode = 0;

/**
 * Carry a stage's soft-failure exit code to the pipeline's and go on to the next
 * stage; anything else stops the run here.
 */
function continueOrAbort(
  stage: PipelineStage,
  name: string,
  outcome: Extract<StepOutcome, { ok: false }>,
  message: (status: number) => string,
): void {
  if (outcome.status !== null && nextStepAfter(stage, outcome.status)) {
    console.error(message(outcome.status));
    pipelineExitCode = outcome.status;
    return;
  }
  abort(name, outcome);
}

/**
 * Derive reads /v1/traces and posts to ingest, so it is the first stage that
 * needs the network. A failed read or post loses nothing — the next run covers
 * the same window — so once the retries are spent the run carries on
 * (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
 */
async function runDerive(): Promise<void> {
  const derive = await runWithNetworkRetry('derive-evaluations', 'derive-evaluations.ts', deriveScope);
  if (derive.ok) return;
  continueOrAbort('derive', 'derive-evaluations', derive,
    status => `[populate] derive-evaluations exited ${status}; continuing to judge + sync, then exiting ${status}`);
}

/**
 * Read-only, local and quick, so it runs first; a gap it finds is reported
 * through the pipeline's exit code and the rest of the run carries on.
 */
const HOOK_GAP_STAGE = 'hook-gap-check';
function runHookGapCheck(): void {
  const check = runStep(HOOK_GAP_STAGE, `${HOOK_GAP_STAGE}.ts`, [...judgeScope]);
  if (check.ok) return;
  continueOrAbort(HOOK_GAP_STAGE, HOOK_GAP_STAGE, check,
    status => `[populate] ${HOOK_GAP_STAGE} exited ${status}; continuing, then exiting ${status}`);
}

/**
 * Ship redacted turns before the judge, over the judge's scope, so the cloud
 * holds the text the judge is about to read. Losing it costs nothing the next
 * run cannot redo, so a soft failure carries on to the judge.
 */
async function runShipTurns(): Promise<void> {
  const shipArgs: string[] = [...judgeScope];
  if (dryRun) shipArgs.push(DRY_RUN_FLAG);
  const ship = await runWithNetworkRetry('ship-turn-content', 'ship-turn-content.ts', shipArgs);
  if (ship.ok) return;
  continueOrAbort('ship-turns', 'ship-turn-content', ship,
    status => `[populate] ship-turn-content exited ${status}; continuing to judge + sync, then exiting ${status}`);
}

/**
 * The judge says on its own stderr why it produced nothing. The rule-based
 * evaluations from derive still deserve to reach the cloud, so a soft failure
 * keeps going — and carries the code to the exit, so the launchd wrapper logs FAILED.
 */
function runJudge(): void {
  const judgeArgs: string[] = [...judgeScope];
  if (dryRun) judgeArgs.push(DRY_RUN_FLAG);
  if (limit) judgeArgs.push(JUDGE_LIMIT_FLAG, limit);
  if (batch) judgeArgs.push(JUDGE_BATCH_FLAG);
  if (perCriterion) judgeArgs.push(JUDGE_PER_CRITERION_FLAG);
  const judge = runStep('judge-evaluations', 'judge-evaluations.ts', judgeArgs);
  if (judge.ok) return;
  continueOrAbort('judge', 'judge-evaluations', judge,
    status => `[populate] judge-evaluations exited ${status}; continuing to sync, then exiting ${status}`);
}

async function runSync(): Promise<void> {
  const syncArgs: string[] = [];
  if (dryRun) syncArgs.push(DRY_RUN_FLAG);
  if (syncBudget !== undefined) syncArgs.push(`${SYNC_BUDGET_FLAG}=${syncBudget}`);
  const sync = await runWithNetworkRetry('sync-to-kv', 'sync-to-kv.ts', syncArgs);
  if (!sync.ok) abort('sync-to-kv', sync);
}

async function main(): Promise<void> {
  if (!skipJudge && !skipHookGapCheck) runHookGapCheck();
  if (!dryRun && !skipDerive) await runDerive();
  if (!skipJudge && !skipShipTurns) await runShipTurns();
  if (!skipJudge) runJudge();
  if (!skipSync) await runSync();

  const total = sum(results, r => r.ms);
  console.log(`[populate] steps: ${results.map(r => `${r.name}=${r.ms}ms`).join(' ')} total=${total}ms exit=${pipelineExitCode}`);
  if (pipelineExitCode !== 0) process.exit(pipelineExitCode);
}

main().catch((err: unknown) => {
  console.error('[populate] fatal:', err);
  process.exit(1);
});
