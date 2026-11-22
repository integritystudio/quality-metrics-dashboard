#!/usr/bin/env tsx
/**
 * Single-command pipeline: derive and judge evaluations. The dashboard's KV
 * keys are written by the parent's kv-sync Workflow, hourly, from the cloud.
 *
 * Steps:
 *   0. hook-gap-check      → flags background sessions whose turns ran without hooks
 *                            (local transcripts, read-only; skipped by `--skip-judge`,
 *                            `--skip-hook-gap-check` skips it)
 *   1. derive-evaluations  → rule-based (tool_correctness, evaluation_latency, task_completion,
 *                            handoff_correctness) plus the five agent heuristics from local transcripts
 *                            over the cloud's last 7 days of spans, the last 2 days
 *                            POSTed to ingest (`--days=7 --post-days=2`)
 *   2. ship-turn-content   → redacted turn text from this machine's transcripts,
 *                            POSTed to ingest per account over the judge's scope
 *                            (runs with the judge; `--skip-ship-turns` skips it)
 *   3. judge-evaluations   → LLM-based (relevance, coherence, faithfulness, hallucination)
 *                            over turns the cloud lists for the last 7 days
 *                            (`--days=7`), POSTed to ingest
 *
 * Steps 1 and 3 post their own records, and the hooks' records reach the cloud
 * as log events through the span shipper.
 *
 * Usage:
 *   npm run populate                          # full pipeline (needs LLM_JUDGE_ANTHROPIC_KEY or ANTHROPIC_API_KEY; exits 1 without one)
 *   npm run populate -- --dry-run             # preview only, no writes
 *   npm run populate -- --skip-judge          # rule-based only
 *   npm run populate -- --skip-judge-scoring  # everything but the judge itself: turns are still shipped, for a judge that runs elsewhere
 *   npm run populate -- --skip-derive-rules   # derive posts the agent heuristics only (the rule metrics are the Workflow's)
 *   npm run populate -- --limit 5             # judge at most 5 turns
 *   npm run populate -- --batch               # judge through the Message Batches API (half price, unattended)
 *   npm run populate -- --per-criterion       # one call per criterion (~10x cost, opt-out of consolidated)
 *   npm run populate -- --direct-hallucination # the consolidated call also judges hallucination
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
 * derive-evaluations and ship-turn-content are retried on transient
 * network failures with the bounded schedule in pipeline-stages.ts.
 */

import { sum } from 'd3-array';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DERIVE_SKIP_RULES_FLAG,
  DRY_RUN_FLAG,
  JUDGE_BATCH_FLAG,
  JUDGE_LIMIT_FLAG,
  JUDGE_PER_CRITERION_FLAG,
  JUDGE_DIRECT_HALLUCINATION_FLAG,
  rejectRemovedFlags,
  NETWORK_RETRY_DELAYS_MS,
  deriveScopeArgs,
  isTransientNetworkFailure,
  judgeScopeArgs,
  nextStepAfter,
  runWithRetry,
  stagesToRun,
  type PipelineStage,
} from './pipeline-stages.js';
import { DEFAULT_API_KEY_ENV, JUDGE_API_KEY_ENV, resolveJudgeApiKey } from './judge-credentials.js';
import { exitOnCliArgError, parseCli, positiveIntArg, type CliSpec } from './cli-args.js';
import { BYTES, TIME_MS } from '../../src/lib/core/units.js';

const SCRIPTS_DIR = import.meta.dirname;
/** Captured stderr ceiling per stage; a stack trace plus warnings is kilobytes, not megabytes. */
// eslint-disable-next-line local/no-magic-numbers-ignore-bitwise -- the multiplier is the named constant's value
const STDERR_CAPTURE_MAX_BYTES = 16 * BYTES.MB;

const SKIP_DERIVE_FLAG = '--skip-derive';
const SKIP_JUDGE_FLAG = '--skip-judge';
/** Skips judge-evaluations alone; `--skip-judge` also skips the two stages that feed it. */
const SKIP_JUDGE_SCORING_FLAG = '--skip-judge-scoring';
const SKIP_SHIP_TURNS_FLAG = '--skip-ship-turns';
const SKIP_HOOK_GAP_CHECK_FLAG = '--skip-hook-gap-check';
const POPULATE_CLI: CliSpec = {
  values: [JUDGE_LIMIT_FLAG],
  switches: [
    SKIP_DERIVE_FLAG, DERIVE_SKIP_RULES_FLAG, SKIP_JUDGE_FLAG, SKIP_JUDGE_SCORING_FLAG, SKIP_SHIP_TURNS_FLAG, SKIP_HOOK_GAP_CHECK_FLAG, DRY_RUN_FLAG,
    JUDGE_BATCH_FLAG, JUDGE_PER_CRITERION_FLAG, JUDGE_DIRECT_HALLUCINATION_FLAG,
  ],
};

/**
 * The run's switches and each stage's scope. Both stages read the cloud over
 * the last week unless --derive-days= / --judge-days= say otherwise. Read before any stage runs, so a bad flag stops
 * the run before derive.
 */
type PopulateArgs = {
  skipDerive: boolean;
  skipDeriveRules: boolean;
  skipJudge: boolean;
  skipJudgeScoring: boolean;
  skipShipTurns: boolean;
  skipHookGapCheck: boolean;
  dryRun: boolean;
  batch: boolean;
  perCriterion: boolean;
  directHallucination: boolean;
  limit: string | undefined;
  deriveScope: string[];
  judgeScope: string[];
};

function readArgs(argv: readonly string[]): PopulateArgs {
  rejectRemovedFlags(argv);
  const cli = parseCli(argv, POPULATE_CLI);
  const limit = positiveIntArg(JUDGE_LIMIT_FLAG, cli.value(JUDGE_LIMIT_FLAG));
  return {
    skipDerive: cli.has(SKIP_DERIVE_FLAG),
    skipDeriveRules: cli.has(DERIVE_SKIP_RULES_FLAG),
    skipJudge: cli.has(SKIP_JUDGE_FLAG),
    skipJudgeScoring: cli.has(SKIP_JUDGE_SCORING_FLAG),
    skipShipTurns: cli.has(SKIP_SHIP_TURNS_FLAG),
    skipHookGapCheck: cli.has(SKIP_HOOK_GAP_CHECK_FLAG),
    dryRun: cli.has(DRY_RUN_FLAG),
    batch: cli.has(JUDGE_BATCH_FLAG),
    perCriterion: cli.has(JUDGE_PER_CRITERION_FLAG),
    directHallucination: cli.has(JUDGE_DIRECT_HALLUCINATION_FLAG),
    limit: limit === undefined ? undefined : String(limit),
    deriveScope: deriveScopeArgs(argv),
    judgeScope: judgeScopeArgs(argv),
  };
}

const { skipDerive, skipDeriveRules, skipJudge, skipJudgeScoring, skipShipTurns, skipHookGapCheck, dryRun, batch, perCriterion, directHallucination, limit, deriveScope, judgeScope } =
  exitOnCliArgError('[populate] Error:', () => readArgs(process.argv.slice(2)));
const stagesRun: ReadonlySet<PipelineStage> = new Set(stagesToRun({ dryRun, skipDerive, skipJudge, skipJudgeScoring, skipShipTurns, skipHookGapCheck }));

// Fail closed when the judge would run with no key: never fall back to
// synthetic scores, which fill the dashboard with plausible numbers while every
// stage reports success. --skip-judge and --skip-judge-scoring leave judge metrics out.
// resolveJudgeApiKey counts both credential names.
// Dry runs are exempt: the judge's own --dry-run spends nothing.
if (stagesRun.has('judge') && !dryRun && !resolveJudgeApiKey()) {
  console.error(
    `[populate] Error: neither ${JUDGE_API_KEY_ENV} nor ${DEFAULT_API_KEY_ENV} is set, so the ` +
    'judge cannot run. Refusing to fall back to synthetic scores: a seeded dashboard looks ' +
    'populated and is fabricated. Set the key (e.g. run under `doppler run --project ' +
    'integrity-studio --config prd`), or pass --skip-judge to leave judge metrics out.',
  );
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
function runStep(name: string, script: string, extraArgs: readonly string[] = [], captureStderr = false): StepOutcome {
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
async function runWithNetworkRetry(name: string, script: string, extraArgs: readonly string[] = []): Promise<StepOutcome> {
  return runWithRetry<StepOutcome>({
    attempt: () => runStep(name, script, extraArgs, true),
    shouldRetry: outcome => !outcome.ok && isTransientNetworkFailure(outcome.stderr),
    delaysMs: NETWORK_RETRY_DELAYS_MS,
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

type StageSpec = {
  stage: PipelineStage;
  /** Script basename under scripts/, without `.ts`; also the stage's name in the log. */
  script: string;
  args: readonly string[];
  networkRetry: boolean;
  /** Log wording after a soft failure, before `exiting <code>`. */
  continuation: string;
};

const dryRunArgs = dryRun ? [DRY_RUN_FLAG] : [];
const CONTINUE_TO_JUDGE = 'continuing to the judge, then ';

/** The stages in run order. A soft failure carries its code to the exit, so the launchd wrapper logs FAILED. */
const STAGES: readonly StageSpec[] = [
  // Read-only, local and quick, so it runs first.
  {
    stage: 'hook-gap-check',
    script: 'hook-gap-check',
    args: judgeScope,
    networkRetry: false,
    continuation: 'continuing, then ',
  },
  // The first stage that needs the network. A failed read or post loses nothing:
  // the next run covers the same window (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
  {
    stage: 'derive',
    script: 'derive-evaluations',
    args: [...deriveScope, ...(skipDeriveRules ? [DERIVE_SKIP_RULES_FLAG] : [])],
    networkRetry: true,
    continuation: CONTINUE_TO_JUDGE,
  },
  // Over the judge's scope, so the cloud holds the text the judge is about to read.
  {
    stage: 'ship-turns',
    script: 'ship-turn-content',
    args: [...judgeScope, ...dryRunArgs],
    networkRetry: true,
    continuation: CONTINUE_TO_JUDGE,
  },
  {
    stage: 'judge',
    script: 'judge-evaluations',
    args: [
      ...judgeScope,
      ...dryRunArgs,
      ...(limit ? [JUDGE_LIMIT_FLAG, limit] : []),
      ...(batch ? [JUDGE_BATCH_FLAG] : []),
      ...(perCriterion ? [JUDGE_PER_CRITERION_FLAG] : []),
      ...(directHallucination ? [JUDGE_DIRECT_HALLUCINATION_FLAG] : []),
    ],
    networkRetry: false,
    continuation: '',
  },
];

/** Run one stage; a soft-failure exit goes to the pipeline's code, anything else stops the run here. */
async function runStage({ stage, script, args, networkRetry, continuation }: StageSpec): Promise<void> {
  const file = `${script}.ts`;
  const outcome = networkRetry
    ? await runWithNetworkRetry(script, file, args)
    : runStep(script, file, args);
  if (outcome.ok) return;
  if (outcome.status !== null && nextStepAfter(stage, outcome.status)) {
    console.error(`[populate] ${script} exited ${outcome.status}; ${continuation}exiting ${outcome.status}`);
    pipelineExitCode = outcome.status;
    return;
  }
  abort(script, outcome);
}

async function main(): Promise<void> {
  for (const spec of STAGES.filter(s => stagesRun.has(s.stage))) {
    // Stages run in order: each reads what the one before it wrote.
    // eslint-disable-next-line no-await-in-loop -- see above
    await runStage(spec);
  }

  const total = sum(results, r => r.ms);
  console.log(`[populate] steps: ${results.map(r => `${r.name}=${r.ms}ms`).join(' ')} total=${total}ms exit=${pipelineExitCode}`);
  if (pipelineExitCode !== 0) process.exit(pipelineExitCode);
}

main().catch((err: unknown) => {
  console.error('[populate] fatal:', err);
  process.exit(1);
});
