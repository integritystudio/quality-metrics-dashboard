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
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPTS_DIR = import.meta.dirname;
const DIST_DIR = join(SCRIPTS_DIR, '..', '..', 'dist');

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

function runStep(name: string, script: string, extraArgs: string[] = []): void {
  const start = performance.now();
  execFileSync('npx', ['tsx', join(SCRIPTS_DIR, script), ...extraArgs], {
    stdio: 'inherit',
    cwd: join(SCRIPTS_DIR, '..'),
  });
  const ms = Math.round(performance.now() - start);
  results.push({ name, ms });
}

if (!dryRun) {
  runStep('derive-evaluations', 'derive-evaluations.ts');
} else { /* dry-run: skip derive */ }

if (!skipJudge) {
  const judgeArgs: string[] = [];
  if (dryRun) judgeArgs.push('--dry-run');
  if (seed || autoSeed) judgeArgs.push('--seed');
  if (limit) judgeArgs.push('--limit', limit);
  runStep('judge-evaluations', 'judge-evaluations.ts', judgeArgs);
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
  runStep('upload-evaluations', 'upload-evaluations.ts', uploadArgs);
}

if (!skipSync) {
  const syncArgs: string[] = [];
  if (dryRun) syncArgs.push('--dry-run');
  runStep('sync-to-kv', 'sync-to-kv.ts', syncArgs);
}

for (const _r of results) { /* step summary */ }
const _total = results.reduce((sum, r) => sum + r.ms, 0);
