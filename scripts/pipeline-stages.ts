/**
 * Shared contract between populate-dashboard.ts (the stage orchestrator) and
 * the stages it runs.
 *
 * Kept apart from both so the orchestrator can read the judge's exit codes
 * without importing the judge (which pulls in p-limit and the judge library),
 * and so the retry policy is a pure function a test can drive with a fake
 * clock instead of a real thirty-minute wait.
 */

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
 * nothing was spent. With `--source=cloud` the cause is usually the network,
 * and the next run picks the same turns up.
 */
export const JUDGE_EXIT_DISCOVERY_FAILED = 7;
/**
 * judge-evaluations exit: `--batch` ran out of wall clock with a batch still
 * processing (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN). The batch was cancelled, the
 * scores it had already produced were kept and posted, and the rest of the
 * run's requests were abandoned; the next run picks those turns up again.
 * Until 2026-10-05 this was an exit 1 that cost the run its upload and sync,
 * as at 06:00 on 09-29 and 09-30. Numbered after the upload code because
 * 8 to 11 were taken.
 */
export const JUDGE_EXIT_BATCH_WALL_CLOCK = 12;
/**
 * derive-evaluations exit: its post to ingest failed (DERIVE-POST-FAILURE-ABORTS-PIPELINE).
 * Nothing is lost: the next unscoped run re-posts the last two days, and ingest
 * drops ids it already holds. Since Phase 3 derive is the first stage that
 * needs the network, so populate waits out a transient failure and then
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
 * the launchd wrapper logs FAILED instead of the "completed" the last two
 * renames got for weeks.
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

/** `--source=` values: where derive, and the judge's discovery, read telemetry from. */
export const TRACE_SOURCES = ['local', 'cloud'] as const;
export type TraceSource = typeof TRACE_SOURCES[number];
/** Stage flags: `--source=local|cloud`, and `--days=N` for the last N UTC days. */
export const SOURCE_FLAG = '--source=';
export const DAYS_FLAG = '--days=';
/** derive flag: post only records from the last N days, whatever `--days=` read. */
export const POST_DAYS_FLAG = '--post-days=';

/**
 * How far back derive posts when nothing narrower is asked for: an unscoped
 * run, and every populate run through `--post-days=`. Matches upload's and the
 * span shipper's two-day window; ingest drops a re-sent id, so a record posted
 * twice is harmless, but a wider window re-sends every run.
 */
export const DERIVE_POST_WINDOW_DAYS = 2;

/**
 * Where populate points the judge unless told otherwise: the cloud source over
 * the last seven UTC days (cloud-read Phase 4). Seven is the dashboard's
 * default period (`DEFAULT_PERIOD` in src/lib/constants.ts), so every run keeps
 * that window judged; a turn older than the scope is never picked. Run on its
 * own, judge-evaluations uses the same source and window (cloud-read Phase 6);
 * `--source=local` is the rollback for one release.
 */
export const JUDGE_DEFAULT_SOURCE: TraceSource = 'cloud';
export const JUDGE_DEFAULT_DAYS = 7;
/** populate flags that override the judge's source and scope for one run. */
export const JUDGE_SOURCE_FLAG = '--judge-source=';
export const JUDGE_DAYS_FLAG = '--judge-days=';

/**
 * Where populate points derive unless told otherwise: the cloud over the last
 * seven UTC days (cloud-read Phase 1), posting only the last
 * `DERIVE_POST_WINDOW_DAYS` of it. The read is wider than the post so a
 * session-level record (task_completion, handoff_correctness) is built from
 * the whole session: a session that began before the read window would score
 * on part of its spans, and each run's slide would post it again under a new
 * id. Seven also sets the calibration corpus, since `.calibration-state.json`
 * is computed over every record derived. Run on its own, derive uses the same
 * source and window and posts the same two days (cloud-read Phase 6);
 * `--source=local` is the rollback for one release.
 */
export const DERIVE_DEFAULT_SOURCE: TraceSource = 'cloud';
export const DERIVE_DEFAULT_DAYS = 7;
/** populate flags that override derive's source and scope for one run. */
export const DERIVE_SOURCE_FLAG = '--derive-source=';
export const DERIVE_DAYS_FLAG = '--derive-days=';

interface StageScope {
  sourceFlag: string;
  daysFlag: string;
  defaultSource: TraceSource;
  defaultDays: number;
}

/** A stage's `--source=` and `--days=` from its populate overrides, else its defaults. */
function stageScopeArgs(args: readonly string[], scope: StageScope): string[] {
  const override = (flag: string): string | undefined => args.find(a => a.startsWith(flag))?.slice(flag.length);
  const source = override(scope.sourceFlag) ?? scope.defaultSource;
  if (!(TRACE_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`${scope.sourceFlag} must be one of ${TRACE_SOURCES.join('|')}, got "${source}"`);
  }
  const rawDays = override(scope.daysFlag);
  const days = rawDays === undefined ? scope.defaultDays : Number(rawDays);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`${scope.daysFlag} must be a positive integer, got "${rawDays}"`);
  }
  return [`${SOURCE_FLAG}${source}`, `${DAYS_FLAG}${days}`];
}

/**
 * The judge's `--source=` and `--days=` for a populate run given `args`.
 * Throws on a bad override, so populate can stop before any stage runs.
 */
export function judgeScopeArgs(args: readonly string[]): string[] {
  return stageScopeArgs(args, {
    sourceFlag: JUDGE_SOURCE_FLAG,
    daysFlag: JUDGE_DAYS_FLAG,
    defaultSource: JUDGE_DEFAULT_SOURCE,
    defaultDays: JUDGE_DEFAULT_DAYS,
  });
}

/**
 * derive's `--source=`, `--days=` and `--post-days=` for a populate run given
 * `args`. Throws on a bad override, like `judgeScopeArgs`.
 */
export function deriveScopeArgs(args: readonly string[]): string[] {
  const scope = stageScopeArgs(args, {
    sourceFlag: DERIVE_SOURCE_FLAG,
    daysFlag: DERIVE_DAYS_FLAG,
    defaultSource: DERIVE_DEFAULT_SOURCE,
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

/**
 * Waits between sync-to-kv attempts, in order — five retries, ~30 minutes in
 * total. Sized to the outages seen at the 18:00 firing on 2026-09-17, 18 and
 * 19: fifteen to thirty-five minutes of no DNS or reset connections on the
 * laptop, each of which left `lastSync` a day stale because the stage ran
 * once and gave up. Bounded so a real code failure cannot hold a run open.
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

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `attempt` up to `delaysMs.length + 1` times, waiting `delaysMs[i]` before
 * retry `i`. Returns the first outcome `shouldRetry` declines to retry, or the
 * last attempt's outcome once the delays are exhausted — it never throws on
 * the caller's behalf, so the caller decides what a final failure means.
 */
export async function runWithRetry<T>(options: RetryOptions<T>): Promise<T> {
  const delays = options.delaysMs ?? SYNC_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  const totalAttempts = delays.length + 1;
  let outcome = await options.attempt(1);
  for (let retry = 0; retry < delays.length && options.shouldRetry(outcome); retry++) {
    const waitMs = delays[retry]!;
    options.onRetry?.(waitMs, retry + 1, totalAttempts);
    await sleep(waitMs);
    outcome = await options.attempt(retry + 2);
  }
  return outcome;
}
