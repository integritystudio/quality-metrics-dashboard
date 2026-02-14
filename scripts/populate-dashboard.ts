#!/usr/bin/env tsx
/**
 * Single-command pipeline to populate all 7 dashboard metrics.
 *
 * Steps:
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion)
 *   2. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *   3. sync-to-kv          → aggregate + upload to Cloudflare KV
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs ANTHROPIC_API_KEY)
 *   npm run populate -- --seed                # offline: synthetic judge scores
 *   npm run populate -- --dry-run --seed      # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based + sync only
 *   npm run populate -- --skip-sync           # derive + judge only
 *   npm run populate -- --limit 5 --seed      # judge at most 5 turns
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const SCRIPTS_DIR = import.meta.dirname;
const DIST_DIR = join(SCRIPTS_DIR, '..', '..', 'dist');

const args = process.argv.slice(2);
const skipJudge = args.includes('--skip-judge');
const skipSync = args.includes('--skip-sync');
const dryRun = args.includes('--dry-run');
const seed = args.includes('--seed');
const limitIdx = args.indexOf('--limit');
let limit: string | undefined;
if (limitIdx !== -1) {
  const raw = args[limitIdx + 1];
  const parsed = parseInt(raw, 10);
  if (!raw || isNaN(parsed) || parsed < 1) {
    console.error('[populate] Error: --limit requires a positive integer');
    process.exit(1);
  }
  limit = String(parsed);
}

// Auto-fallback to --seed when no API key is present
const autoSeed = !seed && !skipJudge && !process.env.ANTHROPIC_API_KEY;
if (autoSeed) {
  console.log('[populate] No ANTHROPIC_API_KEY detected — auto-enabling --seed for judge step');
}

// Preflight: dist/ must exist for sync-to-kv (imports compiled quality-metrics)
if (!skipSync && !existsSync(DIST_DIR)) {
  console.error(`[populate] Error: ${DIST_DIR} not found. Run \`npm run build\` in the parent observability-toolkit first.`);
  process.exit(1);
}

interface StepResult { name: string; ms: number }
const results: StepResult[] = [];

function runStep(name: string, script: string, extraArgs: string[] = []): void {
  console.log(`\n${'='.repeat(60)}\n[populate] Step: ${name}\n${'='.repeat(60)}`);
  const start = performance.now();
  execFileSync('npx', ['tsx', join(SCRIPTS_DIR, script), ...extraArgs], {
    stdio: 'inherit',
    cwd: join(SCRIPTS_DIR, '..'),
  });
  const ms = Math.round(performance.now() - start);
  results.push({ name, ms });
  console.log(`[populate] ${name} completed in ${ms}ms`);
}

// --- Step 1: derive-evaluations (always writes; skipped under --dry-run) ---
if (!dryRun) {
  runStep('derive-evaluations', 'derive-evaluations.ts');
} else {
  console.log(`\n${'='.repeat(60)}\n[populate] Skipping derive-evaluations (--dry-run)\n${'='.repeat(60)}`);
}

// --- Step 2: judge-evaluations ---
if (!skipJudge) {
  const judgeArgs: string[] = [];
  if (dryRun) judgeArgs.push('--dry-run');
  if (seed || autoSeed) judgeArgs.push('--seed');
  if (limit) judgeArgs.push('--limit', limit);
  runStep('judge-evaluations', 'judge-evaluations.ts', judgeArgs);
}

// --- Step 3: sync-to-kv ---
if (!skipSync) {
  const syncArgs: string[] = [];
  if (dryRun) syncArgs.push('--dry-run');
  runStep('sync-to-kv', 'sync-to-kv.ts', syncArgs);
}

// --- Summary ---
console.log(`\n${'='.repeat(60)}`);
console.log('[populate] Pipeline complete');
for (const r of results) {
  console.log(`  ${r.name.padEnd(25)} ${r.ms}ms`);
}
const total = results.reduce((sum, r) => sum + r.ms, 0);
console.log(`  ${'total'.padEnd(25)} ${total}ms`);
