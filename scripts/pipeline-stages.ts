/**
 * Shared contract between populate-dashboard.ts (the stage orchestrator) and
 * the stages it runs.
 *
 * Kept apart from both so the orchestrator can read the judge's exit codes
 * without importing the judge (which pulls in p-limit and the judge library),
 * and so the retry policy is a pure function a test can drive with a fake
 * clock instead of a real thirty-minute wait.
 */

import { CliArgError, parseCli, positiveIntArg } from './cli-args.js';
import { sleep } from './sleep.js';

/** judge-evaluations exit: calls were refused for billing (credit balance). Nothing to retry; the fix is external. */
export const JUDGE_EXIT_BILLING = 4;
/** judge-evaluations exit: evaluations were attempted and none produced a score. */
export const JUDGE_EXIT_NO_SCORES = 3;
/**
 * judge-evaluations exit: more than half the attempts failed, or the success
 * count dropped significantly from the previous run. Indicates a request-shape
 * or model-output regression that a 0-score check would not catch.
 */
export const JUDGE_EXIT_HIGH_FAILURE_RATE = 5;
/**
 * judge-evaluations exit: turns were scored, but ingest refused the post. The
 * records are in the judge's evaluations file, so nothing is lost; re-sending
 * that file is safe, because ingest drops an evaluationId it already holds.
 */
export const JUDGE_EXIT_POST_FAILED = 6;
/**
 * judge-evaluations exit: discovery failed before any turn was judged, so
 * nothing was spent. The cause is usually the network,
 * and the next run picks the same turns up.
 */
export const JUDGE_EXIT_DISCOVERY_FAILED = 7;
/**
 * judge-evaluations exit: `--batch` ran out of wall clock with a batch still
 * processing (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN). The batch was cancelled, the
 * scores it had already produced were kept and posted, and the rest of the
 * run's requests were abandoned; the next run picks those turns up again.
 * Numbered after the upload code because 8 to 11 were taken.
 */
export const JUDGE_EXIT_BATCH_WALL_CLOCK = 12;
/**
 * derive-evaluations exit: its post to ingest failed (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
 * Nothing is lost: the next unscoped run re-posts the last two days, and ingest
 * drops ids it already holds. Derive is the first stage that needs the
 * network, so populate waits out a transient failure and then
 * carries on rather than losing the whole run.
 */
export const DERIVE_EXIT_POST_FAILED = 8;
/**
 * derive-evaluations exit: reading `/v1/traces` failed, so nothing was
 * derived, written or posted. The next run reads the same window again.
 */
export const DERIVE_EXIT_READ_FAILED = 9;
/**
 * derive-evaluations exit: records were delivered, but some day's input no
 * longer matches what the derivations read, most likely a hooks-side rename
 * (HOOK-RENAME-SILENT). Soft, so the run still completes, but non-zero, so
 * the launchd wrapper logs FAILED.
 */
export const DERIVE_EXIT_INPUT_DRIFT = 10;

/**
 * Judge exits populate-dashboard.ts forwards to its own exit instead of
 * aborting: the judge already said why, and the rule-based evaluations from
 * derive still deserve to reach the cloud.
 */
export const JUDGE_SOFT_FAILURE_EXITS: ReadonlySet<number> = new Set([
  JUDGE_EXIT_BILLING,
  JUDGE_EXIT_NO_SCORES,
  JUDGE_EXIT_HIGH_FAILURE_RATE,
  JUDGE_EXIT_POST_FAILED,
  JUDGE_EXIT_DISCOVERY_FAILED,
  JUDGE_EXIT_BATCH_WALL_CLOCK,
]);

/** Derive exits populate forwards to its own exit instead of aborting, for the same reason. */
export const DERIVE_SOFT_FAILURE_EXITS: ReadonlySet<number> = new Set([DERIVE_EXIT_POST_FAILED, DERIVE_EXIT_READ_FAILED, DERIVE_EXIT_INPUT_DRIFT]);

/**
 * upload-evaluations exit: a send to ingest failed. Its state is saved up to
 * the last accepted batch, so the next run re-sends the rest and ingest drops
 * any id it already holds. Nothing is lost, and sync-to-kv still has what
 * derive and the judge posted themselves (UPLOAD-FAILURE-ABORTS-PIPELINE).
 */
export const UPLOAD_EXIT_SEND_FAILED = 11;

/** Upload exits populate forwards to its own exit instead of aborting, so sync-to-kv still runs. */
export const UPLOAD_SOFT_FAILURE_EXITS: ReadonlySet<number> = new Set([UPLOAD_EXIT_SEND_FAILED]);

/** Stage name used in `nextStepAfter`. */
export type PipelineStage = 'derive' | 'judge' | 'upload';

/**
 * Returns true when the pipeline should continue to the next step after
 * `stage` exits with `exitCode`. Centralises the per-stage soft-failure sets so
 * callers do not take a direct dependency on them.
 */
export function nextStepAfter(stage: PipelineStage, exitCode: number): boolean {
  switch (stage) {
    case 'derive': return DERIVE_SOFT_FAILURE_EXITS.has(exitCode);
    case 'judge': return JUDGE_SOFT_FAILURE_EXITS.has(exitCode);
    case 'upload': return UPLOAD_SOFT_FAILURE_EXITS.has(exitCode);
  }
}

/**
 * The `--source=` family chose between local telemetry files and the cloud;
 * only the cloud remains, so these now fail rather than being ignored.
 */
const REMOVED_SOURCE_FLAGS = ['--source', '--judge-source', '--derive-source'] as const;

export function rejectRemovedSourceFlags(args: readonly string[]): void {
  const stale = args.find(arg => REMOVED_SOURCE_FLAGS.some(flag => arg === flag || arg.startsWith(`${flag}=`)));
  if (stale !== undefined) {
    throw new CliArgError(`${stale.split('=')[0]} was removed: derive and the judge read the cloud only`, 'unknown');
  }
}

/** Stage flag: `--days=N` for the last N UTC days. */
export const DAYS_FLAG = '--days=';
/** derive flag: post only records from the last N days, whatever `--days=` read. */
export const POST_DAYS_FLAG = '--post-days=';
/** sync-to-kv flag: KV writes one run may spend. populate forwards `--sync-budget <n>` as `--budget=<n>`. */
export const SYNC_BUDGET_FLAG = '--budget';

/**
 * How far back derive posts when nothing narrower is asked for: an unscoped
 * run, and every populate run through `--post-days=`. Matches upload's and the
 * span shipper's two-day window; ingest drops a re-sent id, so a record posted
 * twice is harmless, but a wider window re-sends every run.
 */
export const DERIVE_POST_WINDOW_DAYS = 2;

/**
 * How far back the judge looks unless told otherwise: the last seven UTC
 * days. Seven is the dashboard's default period (`DEFAULT_PERIOD` in
 * src/lib/constants.ts), so every run keeps that window judged; a turn older
 * than the scope is never picked. Run on its own, judge-evaluations uses the
 * same window.
 */
export const JUDGE_DEFAULT_DAYS = 7;
/** populate flag that overrides the judge's scope for one run. */
const JUDGE_DAYS_FLAG = '--judge-days=';

/**
 * How far back derive reads unless told otherwise: the last
 * seven UTC days, posting only the last
 * `DERIVE_POST_WINDOW_DAYS` of it. The read is wider than the post so a
 * session-level record (task_completion, handoff_correctness) is built from
 * the whole session: a session that began before the read window would score
 * on part of its spans, and each run's slide would post it again under a new
 * id. Seven also sets the calibration corpus, since `.calibration-state.json`
 * is computed over every record derived. Run on its own, derive uses the same
 * window and posts the same two days.
 */
export const DERIVE_DEFAULT_DAYS = 7;
/** populate flag that overrides derive's scope for one run. */
const DERIVE_DAYS_FLAG = '--derive-days=';

interface StageScope {
  daysFlag: string;
  defaultDays: number;
}

/** A stage's `--days=` from its populate override, else its default. */
function stageScopeArgs(args: readonly string[], scope: StageScope): string[] {
  rejectRemovedSourceFlags(args);
  const cli = parseCli(args, { values: [scope.daysFlag] });
  const days = positiveIntArg(scope.daysFlag, cli.value(scope.daysFlag)) ?? scope.defaultDays;
  return [`${DAYS_FLAG}${days}`];
}

/**
 * The judge's `--days=` for a populate run given `args`.
 * Throws on a bad override, so populate can stop before any stage runs.
 */
export function judgeScopeArgs(args: readonly string[]): string[] {
  return stageScopeArgs(args, {
    daysFlag: JUDGE_DAYS_FLAG,
    defaultDays: JUDGE_DEFAULT_DAYS,
  });
}

/**
 * derive's `--days=` and `--post-days=` for a populate run given
 * `args`. Throws on a bad override, like `judgeScopeArgs`.
 */
export function deriveScopeArgs(args: readonly string[]): string[] {
  const scope = stageScopeArgs(args, {
    daysFlag: DERIVE_DAYS_FLAG,
    defaultDays: DERIVE_DEFAULT_DAYS,
  });
  return [...scope, `${POST_DAYS_FLAG}${DERIVE_POST_WINDOW_DAYS}`];
}

/**
 * judge-evaluations flag: run through the Message Batches API — half price,
 * results within minutes, nobody waiting. Passed by the scheduled pipeline
 * and forwarded by populate-dashboard.ts.
 */
export const JUDGE_BATCH_FLAG = '--batch';

/**
 * judge-evaluations flag: score every criterion in its own call instead of the
 * default consolidated one call per turn (JCP4, 2026-09-22). ~10x the cost;
 * kept for comparison runs and as the way back if the default regresses.
 */
export const JUDGE_PER_CRITERION_FLAG = '--per-criterion';
/** judge-evaluations flags populate forwards: synthetic scores, and a cap on turns judged. */
export const JUDGE_SEED_FLAG = '--seed';
export const JUDGE_LIMIT_FLAG = '--limit';
/** Every stage's preview switch: compute and report, write nothing. */
export const DRY_RUN_FLAG = '--dry-run';

/**
 * Waits between sync-to-kv attempts, in order — five retries, ~30 minutes in
 * total, sized to the 15–35 minute laptop network outages seen in practice
 * (docs/data-pipeline.md § Historical incidents). Bounded so a real code
 * failure cannot hold a run open.
 */
export const SYNC_RETRY_DELAYS_MS: readonly number[] = [60_000, 120_000, 240_000, 480_000, 900_000];

/**
 * Transport-level failure signatures worth waiting out. Deliberately only the
 * shapes that have actually appeared in the pipeline log plus their close
 * kin — an HTTP 4xx from the API is a configuration problem, not weather.
 */
const TRANSIENT_NETWORK_PATTERNS: readonly RegExp[] = [
  /\bENOTFOUND\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bEHOSTUNREACH\b/,
  /\bENETUNREACH\b/,
  /fetch failed/i,
  /socket hang up/i,
  /UND_ERR_(?:CONNECT_TIMEOUT|SOCKET|HEADERS_TIMEOUT)/,
];

/** True when a failed stage's stderr names a transport failure that a later attempt may not see. */
export function isTransientNetworkFailure(stderr: string): boolean {
  return TRANSIENT_NETWORK_PATTERNS.some(pattern => pattern.test(stderr));
}

export interface RetryOptions<T> {
  /** Runs one attempt. Attempt numbers start at 1. */
  attempt: (attemptNumber: number) => Promise<T> | T;
  /** Whether this outcome is worth another attempt. */
  shouldRetry: (outcome: T) => boolean;
  /** Called before each wait with the wait length, the attempt that just failed, and the total attempts. */
  onRetry?: (waitMs: number, failedAttempt: number, totalAttempts: number) => void;
  /** Waits before retry 1, retry 2, … Defaults to SYNC_RETRY_DELAYS_MS. */
  delaysMs?: readonly number[];
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}


/**
 * Run `attempt` up to `delaysMs.length + 1` times, waiting `delaysMs[i]` before
 * retry `i`. Returns the first outcome `shouldRetry` declines to retry, or the
 * last attempt's outcome once the delays are exhausted — it never throws on
 * the caller's behalf, so the caller decides what a final failure means.
 */
export async function runWithRetry<T>(options: RetryOptions<T>): Promise<T> {
  const delays = options.delaysMs ?? SYNC_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleep;
  const totalAttempts = delays.length + 1;
  let outcome = await options.attempt(1);
  for (let retry = 0; retry < delays.length && options.shouldRetry(outcome); retry++) {
    const waitMs = delays[retry]!;
    options.onRetry?.(waitMs, retry + 1, totalAttempts);
    await wait(waitMs);
    outcome = await options.attempt(retry + 2);
  }
  return outcome;
}
