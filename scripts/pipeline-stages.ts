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
 * Judge exits populate-dashboard.ts forwards to its own exit instead of
 * aborting: the judge already said why, and the rule-based evaluations from
 * derive still deserve to reach the cloud.
 */
export const JUDGE_SOFT_FAILURE_EXITS: ReadonlySet<number> = new Set([JUDGE_EXIT_BILLING, JUDGE_EXIT_NO_SCORES]);

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
