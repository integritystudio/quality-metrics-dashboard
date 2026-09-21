#!/usr/bin/env tsx
/**
 * Single-command pipeline to populate all 7 dashboard metrics.
 *
 * Steps:
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion)
 *   2. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *   3. upload-evaluations  → ship local evaluations JSONL to the cloud evaluations table
 *   4. sync-to-kv          → aggregate + upload to Cloudflare KV
 *
 * Step 3 is not optional plumbing. Steps 1-2 write `evaluations-<date>.jsonl`
 * to `TELEMETRY_DIR`, but step 4 reads the *cloud* (`CloudBackend.queryEvaluations`,
 * source `'table'`). Without an upload between them the pipeline looks healthy
 * at every stage and still computes an empty dashboard — which is exactly how
 * it ran, unnoticed, until 2026-09-15. It needs `INJECT_HMAC_SECRET`.
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs ANTHROPIC_API_KEY)
 *   npm run populate -- --seed                # offline: synthetic judge scores
 *   npm run populate -- --dry-run --seed      # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based + upload + sync only
 *   npm run populate -- --skip-upload         # derive + judge + sync (sync will see no new evals)
 *   npm run populate -- --skip-sync           # derive + judge + upload only
 *   npm run populate -- --limit 5 --seed      # judge at most 5 turns
 
 *
 * Exit codes (read by the launchd wrapper, which logs FAILED for anything non-zero):
 *   0  every stage succeeded
 *   3  JUDGE_EXIT_NO_SCORES — the judge attempted evaluations and produced none;
 *      upload + sync still ran, so rule-based evaluations reached the dashboard
 *   4  JUDGE_EXIT_BILLING   — the judge was refused for billing; upload + sync still ran
 *   1  any other stage failure; the pipeline stops at that stage
 *
 * sync-to-kv is retried on transient network failures (DNS, reset connections)
 * with the bounded schedule in pipeline-stages.ts: the 18:00 firings on
 * 2026-09-17, 18 and 19 all died there while the laptop had no network, and
 * each left `lastSync` a day stale. Anything that is not a network failure is
 * not retried.
 */

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  JUDGE_SOFT_FAILURE_EXITS,
  SYNC_RETRY_DELAYS_MS,
  isTransientNetworkFailure,
  runWithRetry,
} from './pipeline-stages.js';

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

// Auto-fallback to --seed when no API key is present.
//
// 🔴 THIS MUST ANNOUNCE ITSELF. The branch was an empty block, so a run with no
// ANTHROPIC_API_KEY quietly published SYNTHETIC judge scores while every stage
// reported success — the same shape as the dead-dashboard failure the
// INJECT_HMAC_SECRET check below was added to prevent, and harder to notice,
// because the output is a full dashboard of plausible numbers rather than an
// empty one. Doppler `prd` carries the key today, so the scheduled run judges
// for real; rotate it out and this is the branch that decides, twice a day,
// without saying so.
//
// Warns rather than exits, unlike its neighbour: running offline against seeded
// scores is a legitimate local workflow (`npm run populate -- --seed` asks for
// exactly this). What is not legitimate is doing it by accident.
const autoSeed = !seed && !skipJudge && !process.env.ANTHROPIC_API_KEY;
if (autoSeed) {
  console.warn(
    '[populate] WARNING: ANTHROPIC_API_KEY is not set — falling back to --seed, ' +
    'so judge scores in this run are SYNTHETIC, not real. The dashboard it ' +
    'publishes will look populated and be fabricated. Set the key (e.g. run ' +
    'under `doppler run --project integrity-studio --config prd`), or pass ' +
    '--skip-judge to leave judge metrics out entirely.',
  );
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

function abort(name: string, outcome: Extract<StepOutcome, { ok: false }>): never {
  console.error(`[populate] ${name} failed with exit ${outcome.status ?? 'signal'} after ${outcome.ms} ms; stopping here`);
  process.exit(1);
}

let pipelineExitCode = 0;

async function main(): Promise<void> {
  if (!dryRun) {
    const derive = runStep('derive-evaluations', 'derive-evaluations.ts');
    if (!derive.ok) abort('derive-evaluations', derive);
  }

  if (!skipJudge) {
    const judgeArgs: string[] = [];
    if (dryRun) judgeArgs.push('--dry-run');
    if (seed || autoSeed) judgeArgs.push('--seed');
    if (limit) judgeArgs.push('--limit', limit);
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
    const upload = runStep('upload-evaluations', 'upload-evaluations.ts', uploadArgs);
    if (!upload.ok) abort('upload-evaluations', upload);
  }

  if (!skipSync) {
    const syncArgs: string[] = [];
    if (dryRun) syncArgs.push('--dry-run');
    const sync = await runWithRetry<StepOutcome>({
      attempt: () => runStep('sync-to-kv', 'sync-to-kv.ts', syncArgs, true),
      shouldRetry: outcome => !outcome.ok && isTransientNetworkFailure(outcome.stderr),
      delaysMs: SYNC_RETRY_DELAYS_MS,
      onRetry: (waitMs, failedAttempt, totalAttempts) => {
        console.error(`[populate] sync-to-kv attempt ${failedAttempt}/${totalAttempts} failed on a transient network error; retrying in ${Math.round(waitMs / MS_PER_SECOND)} s`);
      },
    });
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
