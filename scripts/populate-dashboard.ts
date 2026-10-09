#!/usr/bin/env tsx
/**
 * Single-command pipeline to populate all 7 dashboard metrics.
 *
 * Steps:
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion)
 *                            over the cloud's last 7 days of spans, the last 2 days
 *                            POSTed to ingest (`--days=7 --post-days=2`)
 *   2. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *                            over turns the cloud lists for the last 7 days
 *                            (`--days=7`), POSTed to ingest and
 *                            appended to evaluations-<date>.jsonl
 *   3. upload-evaluations  → ship the hooks' and survival-fitness records in evaluations JSONL
 *   4. sync-to-kv          → aggregate + upload to Cloudflare KV
 *
 * Step 4 reads only the *cloud* (`CloudBackend.queryEvaluations`, source
 * `'table'`), so every record has to get there: steps 1-2 post their own, and
 * step 3 carries what is still only on disk. Without that the pipeline looks
 * healthy at every stage and still computes an empty dashboard
 * (docs/data-pipeline.md § Historical incidents). It needs `INJECT_HMAC_SECRET`.
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs LLM_JUDGE_ANTHROPIC_KEY or ANTHROPIC_API_KEY; exits 1 without one)
 *   npm run populate -- --seed                # offline: synthetic judge scores
 *   npm run populate -- --dry-run --seed      # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based + upload + sync only
 *   npm run populate -- --skip-derive --skip-judge --sync-budget 700
 *                                             # refresh only: upload + sync, capped KV writes (the hourly launchd job)
 *   npm run populate -- --skip-upload         # derive + judge + sync (derive still posts its own records)
 *   npm run populate -- --skip-sync           # derive + judge + upload only
 *   npm run populate -- --limit 5 --seed      # judge at most 5 turns
 *   npm run populate -- --batch               # judge through the Message Batches API (half price, unattended)
 *   npm run populate -- --per-criterion       # one call per criterion (~10x cost, opt-out of consolidated)
 *   npm run populate -- --judge-days=30       # judge turns from the last 30 days instead of 7
 *   npm run populate -- --derive-days=14      # derive over the last 14 days instead of 7
 *
 * Exit codes (read by the launchd wrapper, which logs FAILED for anything non-zero):
 *   0     every stage succeeded
 *   3-12  a stage's soft failure, forwarded after the remaining stages still
 *         ran; each code is documented on its constant in pipeline-stages.ts
 *   1     any other stage failure, and the pipeline stops there. Also: no judge
 *         key and neither --seed nor --skip-judge given, so nothing runs
 *
 * derive-evaluations, upload-evaluations and sync-to-kv are retried on transient
 * network failures with the bounded schedule in pipeline-stages.ts.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  DRY_RUN_FLAG,
  SYNC_BUDGET_FLAG,
  JUDGE_BATCH_FLAG,
  JUDGE_LIMIT_FLAG,
  JUDGE_PER_CRITERION_FLAG,
  JUDGE_SEED_FLAG,
  SYNC_RETRY_DELAYS_MS,
  deriveScopeArgs,
  isTransientNetworkFailure,
  judgeScopeArgs,
  nextStepAfter,
  runWithRetry,
} from './pipeline-stages.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV, resolveJudgeApiKey } from './judge-credentials.js';
import { exitOnCliArgError, parseCli, positiveIntArg, type CliSpec } from './cli-args.js';

const SCRIPTS_DIR = import.meta.dirname;
const DIST_DIR = join(SCRIPTS_DIR, '..', '..', 'dist');
/** Captured stderr ceiling per stage; a stack trace plus warnings is kilobytes, not megabytes. */
const STDERR_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const MS_PER_SECOND = 1000;

const SKIP_DERIVE_FLAG = '--skip-derive';
const SKIP_JUDGE_FLAG = '--skip-judge';
const SKIP_UPLOAD_FLAG = '--skip-upload';
const SKIP_SYNC_FLAG = '--skip-sync';
/** Forwarded to sync-to-kv as `--budget=<n>`; unset leaves sync's own default. */
const SYNC_BUDGET_ARG = '--sync-budget';
const POPULATE_CLI: CliSpec = {
  values: [JUDGE_LIMIT_FLAG, SYNC_BUDGET_ARG],
  switches: [
    SKIP_DERIVE_FLAG, SKIP_JUDGE_FLAG, SKIP_UPLOAD_FLAG, SKIP_SYNC_FLAG, DRY_RUN_FLAG,
    JUDGE_SEED_FLAG, JUDGE_BATCH_FLAG, JUDGE_PER_CRITERION_FLAG,
  ],
};

/**
 * The run's switches and each stage's scope. Both stages read the cloud over
 * the last week unless --derive-days= / --judge-days= say otherwise. Read before any stage runs, so a bad flag stops
 * the run before derive.
 */
function readArgs(argv: readonly string[]) {
  const cli = parseCli(argv, POPULATE_CLI);
  const limit = positiveIntArg(JUDGE_LIMIT_FLAG, cli.value(JUDGE_LIMIT_FLAG));
  return {
    skipDerive: cli.has(SKIP_DERIVE_FLAG),
    skipJudge: cli.has(SKIP_JUDGE_FLAG),
    skipUpload: cli.has(SKIP_UPLOAD_FLAG),
    skipSync: cli.has(SKIP_SYNC_FLAG),
    dryRun: cli.has(DRY_RUN_FLAG),
    seed: cli.has(JUDGE_SEED_FLAG),
    batch: cli.has(JUDGE_BATCH_FLAG),
    perCriterion: cli.has(JUDGE_PER_CRITERION_FLAG),
    limit: limit === undefined ? undefined : String(limit),
    syncBudget: positiveIntArg(SYNC_BUDGET_ARG, cli.value(SYNC_BUDGET_ARG)),
    deriveScope: deriveScopeArgs(argv),
    judgeScope: judgeScopeArgs(argv),
  };
}

const { skipDerive, skipJudge, skipUpload, skipSync, dryRun, seed, batch, perCriterion, limit, syncBudget, deriveScope, judgeScope } =
  exitOnCliArgError('[populate] Error:', () => readArgs(process.argv.slice(2)));

// Fail closed when the judge would run with no key: never fall back to
// synthetic scores, which fill the dashboard with plausible numbers while every
// stage reports success. Seeded scores only on request (--seed), or --skip-judge
// to leave judge metrics out. resolveJudgeApiKey counts both credential names.
// Dry runs are exempt: the judge's own --dry-run spends nothing.
if (!seed && !skipJudge && !dryRun && !resolveJudgeApiKey()) {
  console.error(
    `[populate] Error: neither ${JUDGE_API_KEY_ENV} nor ${DEFAULT_API_KEY_ENV} is set, so the ` +
    'judge cannot run. Refusing to fall back to synthetic scores: a seeded dashboard looks ' +
    'populated and is fabricated. Set the key (e.g. run under `doppler run --project ' +
    'integrity-studio --config prd`), pass --seed to ask for synthetic scores explicitly, ' +
    'or pass --skip-judge to leave judge metrics out.',
  );
  process.exit(1);
}

// Preflight: dist/ must exist for sync-to-kv (imports compiled quality-metrics)
if (!skipSync && !existsSync(DIST_DIR)) {
  console.error(`[populate] Error: ${DIST_DIR} not found. Run \`npm run build\` in the parent observability-toolkit first.`);
  process.exit(1);
}

interface StepResult { name: string; ms: number }
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
function runWithNetworkRetry(name: string, script: string, extraArgs: string[] = []): Promise<StepOutcome> {
  return runWithRetry<StepOutcome>({
    attempt: () => runStep(name, script, extraArgs, true),
    shouldRetry: outcome => !outcome.ok && isTransientNetworkFailure(outcome.stderr),
    delaysMs: SYNC_RETRY_DELAYS_MS,
    onRetry: (waitMs, failedAttempt, totalAttempts) => {
      console.error(`[populate] ${name} attempt ${failedAttempt}/${totalAttempts} failed on a transient network error; retrying in ${Math.round(waitMs / MS_PER_SECOND)} s`);
    },
  });
}

function abort(name: string, outcome: Extract<StepOutcome, { ok: false }>): never {
  console.error(`[populate] ${name} failed with exit ${outcome.status ?? 'signal'} after ${outcome.ms} ms; stopping here`);
  process.exit(1);
}

let pipelineExitCode = 0;

async function main(): Promise<void> {
  if (!dryRun && !skipDerive) {
    // Derive reads /v1/traces and posts to ingest, so it is the first stage
    // that needs the network. A failed read or post loses
    // nothing — the next run covers the same window — so once the retries are
    // spent the run carries on (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
    const derive = await runWithNetworkRetry('derive-evaluations', 'derive-evaluations.ts', deriveScope);
    if (!derive.ok) {
      if (derive.status !== null && nextStepAfter('derive', derive.status)) {
        console.error(`[populate] derive-evaluations exited ${derive.status}; continuing to judge, upload + sync, then exiting ${derive.status}`);
        pipelineExitCode = derive.status;
      } else {
        abort('derive-evaluations', derive);
      }
    }
  }

  if (!skipJudge) {
    const judgeArgs: string[] = [...judgeScope];
    if (dryRun) judgeArgs.push(DRY_RUN_FLAG);
    if (seed) judgeArgs.push(JUDGE_SEED_FLAG);
    if (limit) judgeArgs.push(JUDGE_LIMIT_FLAG, limit);
    if (batch) judgeArgs.push(JUDGE_BATCH_FLAG);
    if (perCriterion) judgeArgs.push(JUDGE_PER_CRITERION_FLAG);
    const judge = runStep('judge-evaluations', 'judge-evaluations.ts', judgeArgs);
    if (!judge.ok) {
      if (judge.status !== null && nextStepAfter('judge', judge.status)) {
        // The judge has already said on its own stderr why it produced nothing.
        // The rule-based evaluations from derive still deserve to reach the
        // cloud, so keep going — and carry the code to the exit, so the launchd
        // wrapper logs FAILED.
        console.error(`[populate] judge-evaluations exited ${judge.status}; continuing to upload + sync, then exiting ${judge.status}`);
        pipelineExitCode = judge.status;
      } else {
        abort('judge-evaluations', judge);
      }
    }
  }

  if (!skipUpload) {
    if (!process.env.INJECT_HMAC_SECRET && !dryRun) {
      // Fail loudly. A silent skip here is what the dead-dashboard failure mode
      // looked like: every step green, nothing reaching the cloud.
      console.error('[populate] Error: INJECT_HMAC_SECRET is not set, so derived evaluations cannot reach the cloud and sync-to-kv would compute an empty dashboard. Run under `doppler run --project integrity-studio --config prd`, or pass --skip-upload to accept that.');
      process.exit(1);
    }
    const uploadArgs: string[] = [];
    if (dryRun) uploadArgs.push(DRY_RUN_FLAG);
    // Wait out a transient failure like derive and sync do, and carry on to
    // sync if a send still fails (UPLOAD-FAILURE-ABORTS-PIPELINE).
    const upload = await runWithNetworkRetry('upload-evaluations', 'upload-evaluations.ts', uploadArgs);
    if (!upload.ok) {
      if (upload.status !== null && nextStepAfter('upload', upload.status)) {
        console.error(`[populate] upload-evaluations exited ${upload.status}; continuing to sync, then exiting ${upload.status}`);
        pipelineExitCode = upload.status;
      } else {
        abort('upload-evaluations', upload);
      }
    }
  }

  if (!skipSync) {
    const syncArgs: string[] = [];
    if (dryRun) syncArgs.push(DRY_RUN_FLAG);
    if (syncBudget !== undefined) syncArgs.push(`${SYNC_BUDGET_FLAG}=${syncBudget}`);
    const sync = await runWithNetworkRetry('sync-to-kv', 'sync-to-kv.ts', syncArgs);
    if (!sync.ok) abort('sync-to-kv', sync);
  }

  const total = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`[populate] steps: ${results.map(r => `${r.name}=${r.ms}ms`).join(' ')} total=${total}ms exit=${pipelineExitCode}`);
  if (pipelineExitCode !== 0) process.exit(pipelineExitCode);
}

main().catch((err: unknown) => {
  console.error('[populate] fatal:', err);
  process.exit(1);
});
