#!/usr/bin/env tsx
/**
 * Single-command pipeline to populate all 7 dashboard metrics.
 *
 * Steps:
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion)
 *                            over spans the cloud holds for the last 7 days
 *                            (`--source=cloud --days=7 --post-days=2`, DERIVE_DEFAULT_*,
 *                            Phase 1), the last 2 days POSTed straight to ingest
 *                            (Phase 3; no file since Phase 6)
 *   2. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *                            over turns the cloud lists for the last 7 days
 *                            (`--source=cloud --days=7`, JUDGE_DEFAULT_*), POSTed
 *                            straight to ingest (Phase 4) and appended to
 *                            evaluations-<date>.jsonl
 *   3. upload-evaluations  → ship the hooks' and survival-fitness records in evaluations JSONL
 *   4. sync-to-kv          → aggregate + upload to Cloudflare KV
 *
 * Step 4 reads only the *cloud* (`CloudBackend.queryEvaluations`, source
 * `'table'`), so every record has to get there: steps 1-2 post their own, and
 * step 3 carries what is still only on disk. Without that the pipeline looks
 * healthy at every stage and still computes an empty dashboard — which is
 * exactly how it ran, unnoticed, until 2026-09-15. It needs `INJECT_HMAC_SECRET`.
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs LLM_JUDGE_ANTHROPIC_KEY or ANTHROPIC_API_KEY; exits 1 without one)
 *   npm run populate -- --seed                # offline: synthetic judge scores
 *   npm run populate -- --dry-run --seed      # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based + upload + sync only
 *   npm run populate -- --skip-upload         # derive + judge + sync (derive still posts its own records)
 *   npm run populate -- --skip-sync           # derive + judge + upload only
 *   npm run populate -- --limit 5 --seed      # judge at most 5 turns
 *   npm run populate -- --batch               # judge through the Message Batches API (half price, unattended)
 *   npm run populate -- --per-criterion       # one call per criterion (~10x cost, opt-out of consolidated)
 *   npm run populate -- --judge-days=30       # judge turns from the last 30 days instead of 7
 *   npm run populate -- --judge-source=local  # judge discovery from local telemetry (rollback)
 *   npm run populate -- --derive-days=14      # derive over the last 14 days instead of 7
 *   npm run populate -- --derive-source=local # derive from local trace files (rollback)
 *
 * Exit codes (read by the launchd wrapper, which logs FAILED for anything non-zero):
 *   0  every stage succeeded
 *   3  JUDGE_EXIT_NO_SCORES — the judge attempted evaluations and produced none;
 *      upload + sync still ran, so rule-based evaluations reached the dashboard
 *   4  JUDGE_EXIT_BILLING   — the judge was refused for billing; upload + sync still ran
 *   5  JUDGE_EXIT_HIGH_FAILURE_RATE — most judge calls failed, or far fewer succeeded than last run
 *   6  JUDGE_EXIT_POST_FAILED — ingest refused the judge's post; its records are in its file
 *   7  JUDGE_EXIT_DISCOVERY_FAILED — the judge could not list turns (usually the network); nothing spent
 *   8  DERIVE_EXIT_POST_FAILED — derive's post failed after the network retries; the next run re-posts it
 *   9  DERIVE_EXIT_READ_FAILED — derive could not read /v1/traces after the network retries; nothing posted
 *   10 DERIVE_EXIT_INPUT_DRIFT — derive delivered, but a day's spans no longer match what it reads (a hooks rename?)
 *   11 UPLOAD_EXIT_SEND_FAILED — upload's send failed after the network retries; the next run re-sends the rest
 *   For 3-11 the remaining stages still ran.
 *   1  any other stage failure; the pipeline stops at that stage. Also: no judge
 *      key and neither --seed nor --skip-judge given — nothing runs (fail closed)
 *
 * derive-evaluations, upload-evaluations and sync-to-kv are retried on transient
 * network failures (DNS, reset connections) with the bounded schedule in
 * pipeline-stages.ts: the 18:00 firings on 2026-09-17, 18 and 19 all died at
 * sync while the laptop had no network, the 2026-09-28 06:00 firing died at
 * derive's post, and the 18:00 firing that day died at upload. Anything that is
 * not a network failure is not retried.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  DERIVE_SOFT_FAILURE_EXITS,
  JUDGE_BATCH_FLAG,
  JUDGE_PER_CRITERION_FLAG,
  JUDGE_SOFT_FAILURE_EXITS,
  SYNC_RETRY_DELAYS_MS,
  UPLOAD_SOFT_FAILURE_EXITS,
  deriveScopeArgs,
  isTransientNetworkFailure,
  judgeScopeArgs,
  runWithRetry,
} from './pipeline-stages.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV, resolveJudgeApiKey } from './judge-credentials.js';

const SCRIPTS_DIR = import.meta.dirname;
const DIST_DIR = join(SCRIPTS_DIR, '..', '..', 'dist');
/** Captured stderr ceiling per stage; a stack trace plus warnings is kilobytes, not megabytes. */
const STDERR_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
const MS_PER_SECOND = 1000;

const args = process.argv.slice(2);
const skipJudge = args.includes('--skip-judge');
const skipUpload = args.includes('--skip-upload');
const skipSync = args.includes('--skip-sync');
const dryRun = args.includes('--dry-run');
const seed = args.includes('--seed');
const batch = args.includes(JUDGE_BATCH_FLAG);
const perCriterion = args.includes(JUDGE_PER_CRITERION_FLAG);
const limitIdx = args.indexOf('--limit');
let limit: string | undefined;
if (limitIdx !== -1) {
  const raw = args[limitIdx + 1];
  const parsed = parseInt(raw ?? '', 10);
  if (!raw || isNaN(parsed) || parsed < 1) {
    console.error('[populate] Error: --limit requires a positive integer');
    process.exit(1);
  }
  limit = String(parsed);
}

// Both stages read the cloud over the last week unless --derive-source= /
// --derive-days= / --judge-source= / --judge-days= say otherwise. Checked here
// so a bad override stops the run before derive.
let deriveScope: string[];
let judgeScope: string[];
try {
  deriveScope = deriveScopeArgs(args);
  judgeScope = judgeScopeArgs(args);
} catch (err) {
  console.error(`[populate] Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Fail closed when the judge would run with no key.
//
// 🔴 There is no automatic --seed any more. Until 2026-09-30 this branch fell
// back to seed mode when ANTHROPIC_API_KEY was absent — first silently (an
// empty block), then with a warning — so a run that lost its key published
// SYNTHETIC judge scores while every stage reported success: a full dashboard
// of plausible numbers rather than an empty one. No evaluator vendor surveyed
// does this; they fail visibly (Langfuse marks the run Error, LangSmith pauses
// the evaluator). Seeded scores remain available, but only on request: pass
// --seed, or --skip-judge to leave judge metrics out.
//
// The check goes through resolveJudgeApiKey so both credential names count —
// the old check read ANTHROPIC_API_KEY alone and treated a run with only
// LLM_JUDGE_ANTHROPIC_KEY set as keyless. Dry runs are exempt: the judge's own
// --dry-run returns before its key check and spends nothing.
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
  if (!dryRun) {
    // Derive reads /v1/traces (Phase 1) and posts to ingest (Phase 3), so it is
    // the first stage that needs the network. A failed read or post loses
    // nothing — the next run covers the same window — so once the retries are
    // spent the run carries on (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
    const derive = await runWithNetworkRetry('derive-evaluations', 'derive-evaluations.ts', deriveScope);
    if (!derive.ok) {
      if (derive.status !== null && DERIVE_SOFT_FAILURE_EXITS.has(derive.status)) {
        console.error(`[populate] derive-evaluations exited ${derive.status}; continuing to judge, upload + sync, then exiting ${derive.status}`);
        pipelineExitCode = derive.status;
      } else {
        abort('derive-evaluations', derive);
      }
    }
  }

  if (!skipJudge) {
    const judgeArgs: string[] = [...judgeScope];
    if (dryRun) judgeArgs.push('--dry-run');
    if (seed) judgeArgs.push('--seed');
    if (limit) judgeArgs.push('--limit', limit);
    if (batch) judgeArgs.push(JUDGE_BATCH_FLAG);
    if (perCriterion) judgeArgs.push(JUDGE_PER_CRITERION_FLAG);
    const judge = runStep('judge-evaluations', 'judge-evaluations.ts', judgeArgs);
    if (!judge.ok) {
      if (judge.status !== null && JUDGE_SOFT_FAILURE_EXITS.has(judge.status)) {
        // The judge has already said on its own stderr why it produced nothing.
        // The rule-based evaluations from derive still deserve to reach the
        // cloud, so keep going — and carry the code to the exit, so the launchd
        // wrapper logs FAILED instead of the "completed" these runs used to get.
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
    if (dryRun) uploadArgs.push('--dry-run');
    // The 2026-09-28 18:00 run lost its sync to a network blip here: upload
    // gave up after its own four quick attempts and exited 1, which aborted
    // the run (UPLOAD-FAILURE-ABORTS-PIPELINE). Wait out a transient failure
    // like derive and sync do, and carry on to sync if a send still fails.
    const upload = await runWithNetworkRetry('upload-evaluations', 'upload-evaluations.ts', uploadArgs);
    if (!upload.ok) {
      if (upload.status !== null && UPLOAD_SOFT_FAILURE_EXITS.has(upload.status)) {
        console.error(`[populate] upload-evaluations exited ${upload.status}; continuing to sync, then exiting ${upload.status}`);
        pipelineExitCode = upload.status;
      } else {
        abort('upload-evaluations', upload);
      }
    }
  }

  if (!skipSync) {
    const syncArgs: string[] = [];
    if (dryRun) syncArgs.push('--dry-run');
    const sync = await runWithNetworkRetry('sync-to-kv', 'sync-to-kv.ts', syncArgs);
    if (!sync.ok) abort('sync-to-kv', sync);
  }

  const total = results.reduce((sum, r) => sum + r.ms, 0);
  console.log(`[populate] steps: ${results.map(r => `${r.name}=${r.ms}ms`).join(' ')} total=${total}ms exit=${pipelineExitCode}`);
  if (pipelineExitCode !== 0) process.exit(pipelineExitCode);
}

main().catch(err => {
  console.error('[populate] fatal:', err);
  process.exit(1);
});
