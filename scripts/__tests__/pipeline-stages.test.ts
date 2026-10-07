import { describe, it, expect } from 'vitest';
import {
  DERIVE_EXIT_INPUT_DRIFT,
  DERIVE_EXIT_POST_FAILED,
  DERIVE_EXIT_READ_FAILED,
  DERIVE_SOFT_FAILURE_EXITS,
  JUDGE_EXIT_BATCH_WALL_CLOCK,
  JUDGE_EXIT_BILLING,
  JUDGE_EXIT_DISCOVERY_FAILED,
  JUDGE_EXIT_HIGH_FAILURE_RATE,
  JUDGE_EXIT_NO_SCORES,
  JUDGE_EXIT_POST_FAILED,
  JUDGE_SOFT_FAILURE_EXITS,
  SYNC_RETRY_DELAYS_MS,
  UPLOAD_EXIT_SEND_FAILED,
  UPLOAD_SOFT_FAILURE_EXITS,
  deriveScopeArgs,
  isTransientNetworkFailure,
  judgeScopeArgs,
  runWithRetry,
} from '../pipeline-stages.js';

const MS_PER_MINUTE = 60_000;

describe('isTransientNetworkFailure', () => {
  it.each([
    ['the DNS failure seen 2026-09-17 and 09-19', "Error: getaddrinfo ENOTFOUND api.integritystudio.ai\n    code: 'ENOTFOUND'"],
    ['the connection reset seen 2026-09-18', '[cause]: Error: read ECONNRESET'],
    ['the undici wrapper around both', 'TypeError: fetch failed'],
    ['a hung socket', 'Error: socket hang up'],
    ['a refused connection', 'connect ECONNREFUSED 127.0.0.1:443'],
  ])('is true for %s', (_label, stderr) => {
    expect(isTransientNetworkFailure(stderr)).toBe(true);
  });

  it.each([
    ['a type error in the script', "TypeError: Cannot read properties of undefined (reading 'length')"],
    ['an auth rejection', 'Cloud API error: 401 Invalid token'],
    ['an org-scope refusal', 'Cloud API error: 403 orgId is not permitted for this credential'],
    ['empty stderr', ''],
  ])('is false for %s', (_label, stderr) => {
    expect(isTransientNetworkFailure(stderr)).toBe(false);
  });
});

describe('runWithRetry', () => {
  const noSleep = async (): Promise<void> => {};

  it('returns the first outcome without sleeping when it needs no retry', async () => {
    const sleeps: number[] = [];

    const outcome = await runWithRetry({
      attempt: () => 'ok',
      shouldRetry: () => false,
      delaysMs: [10, 20],
      sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
    });

    expect(outcome).toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('waits the configured delays in order and stops at the first success', async () => {
    const sleeps: number[] = [];
    const attempts: number[] = [];
    const outcomes = ['fail', 'fail', 'ok'];

    const outcome = await runWithRetry({
      attempt: n => { attempts.push(n); return outcomes[n - 1]!; },
      shouldRetry: o => o === 'fail',
      delaysMs: [10, 20, 40],
      sleep: ms => { sleeps.push(ms); return Promise.resolve(); },
    });

    expect(outcome).toBe('ok');
    expect(attempts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([10, 20]);
  });

  it('gives up after the delays are exhausted and returns the last failure', async () => {
    let calls = 0;

    const outcome = await runWithRetry({
      attempt: () => { calls += 1; return 'fail'; },
      shouldRetry: () => true,
      delaysMs: [1, 1],
      sleep: noSleep,
    });

    expect(outcome).toBe('fail');
    expect(calls).toBe(3);
  });

  it('announces each retry with the wait and the attempt numbers', async () => {
    const announced: Array<[number, number, number]> = [];

    await runWithRetry({
      attempt: () => 'fail',
      shouldRetry: () => true,
      delaysMs: [5, 6],
      sleep: noSleep,
      onRetry: (waitMs, failedAttempt, total) => { announced.push([waitMs, failedAttempt, total]); },
    });

    expect(announced).toEqual([[5, 1, 3], [6, 2, 3]]);
  });
});

describe('pipeline exit-code contract', () => {
  it('treats a failed derive post as soft, so a network blip no longer stops judge, upload and sync', () => {
    expect(DERIVE_SOFT_FAILURE_EXITS.has(DERIVE_EXIT_POST_FAILED)).toBe(true);
    expect(DERIVE_SOFT_FAILURE_EXITS.has(1)).toBe(false);
  });

  it('treats a failed derive cloud read as soft, so reading /v1/traces first does not reopen that failure', () => {
    expect(DERIVE_SOFT_FAILURE_EXITS.has(DERIVE_EXIT_READ_FAILED)).toBe(true);
  });

  it('treats input drift as soft, so the run completes but still exits non-zero', () => {
    expect(DERIVE_SOFT_FAILURE_EXITS.has(DERIVE_EXIT_INPUT_DRIFT)).toBe(true);
  });

  // Regression: the 2026-09-28 18:00 run lost its sync to an upload that gave
  // up on a network blip and exited 1 (UPLOAD-FAILURE-ABORTS-PIPELINE).
  it('treats a failed upload send as soft, so sync still runs, and nothing else', () => {
    expect(UPLOAD_SOFT_FAILURE_EXITS.has(UPLOAD_EXIT_SEND_FAILED)).toBe(true);
    expect(UPLOAD_SOFT_FAILURE_EXITS.has(1)).toBe(false);
  });

  it('gives every soft code its own number, none of them 0 or the generic 1', () => {
    const codes = [
      JUDGE_EXIT_NO_SCORES,
      JUDGE_EXIT_BILLING,
      JUDGE_EXIT_HIGH_FAILURE_RATE,
      JUDGE_EXIT_POST_FAILED,
      JUDGE_EXIT_DISCOVERY_FAILED,
      JUDGE_EXIT_BATCH_WALL_CLOCK,
      DERIVE_EXIT_POST_FAILED,
      DERIVE_EXIT_READ_FAILED,
      DERIVE_EXIT_INPUT_DRIFT,
      UPLOAD_EXIT_SEND_FAILED,
    ];

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(0);
    expect(codes).not.toContain(1);
  });

  it('treats the judge\'s own codes as soft failures and nothing else', () => {
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_BILLING)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_NO_SCORES)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_POST_FAILED)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_DISCOVERY_FAILED)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(1)).toBe(false);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(0)).toBe(false);
  });

  // Regression: the 06:00 runs on 2026-09-29 and 09-30 hit the judge's batch
  // wall clock, exited 1, and lost their upload and sync
  // (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN).
  it('treats the judge\'s batch wall clock as soft, so upload and sync still run', () => {
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_BATCH_WALL_CLOCK)).toBe(true);
  });

  it('bounds the sync retry window to between fifteen and thirty minutes', () => {
    const total = SYNC_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

    expect(total).toBeGreaterThanOrEqual(15 * MS_PER_MINUTE);
    expect(total).toBeLessThanOrEqual(30 * MS_PER_MINUTE);
  });
});

describe('judgeScopeArgs', () => {
  it('points the judge at the cloud over the last seven days when populate is given nothing', () => {
    expect(judgeScopeArgs(['--limit', '100', '--batch'])).toEqual(['--source=cloud', '--days=7']);
  });

  it('takes the source and the day count from their overrides', () => {
    expect(judgeScopeArgs(['--judge-source=local', '--judge-days=30'])).toEqual(['--source=local', '--days=30']);
  });

  it('reads an override given as the next argument', () => {
    expect(judgeScopeArgs(['--judge-source', 'local', '--judge-days', '30'])).toEqual(['--source=local', '--days=30']);
  });

  it.each([
    ['an unknown source', ['--judge-source=s3'], /--judge-source= must be one of local\|cloud/],
    ['a zero day count', ['--judge-days=0'], /--judge-days= must be a positive integer/],
    ['a fractional day count', ['--judge-days=1.5'], /--judge-days= must be a positive integer/],
    ['a day count with trailing text', ['--judge-days=7d'], /--judge-days= must be a positive integer/],
  ])('rejects %s', (_label, args, message) => {
    expect(() => judgeScopeArgs(args)).toThrow(message);
  });
});

describe('deriveScopeArgs', () => {
  it('reads the cloud over seven days and posts only the last two when populate is given nothing', () => {
    expect(deriveScopeArgs(['--limit', '100', '--batch'])).toEqual(['--source=cloud', '--days=7', '--post-days=2']);
  });

  it('takes the source and the day count from their own overrides, not the judge\'s', () => {
    const args = ['--derive-source=local', '--derive-days=14', '--judge-source=cloud', '--judge-days=30'];

    expect(deriveScopeArgs(args)).toEqual(['--source=local', '--days=14', '--post-days=2']);
    expect(judgeScopeArgs(args)).toEqual(['--source=cloud', '--days=30']);
  });

  it.each([
    ['an unknown source', ['--derive-source=s3'], /--derive-source= must be one of local\|cloud/],
    ['a zero day count', ['--derive-days=0'], /--derive-days= must be a positive integer/],
  ])('rejects %s', (_label, args, message) => {
    expect(() => deriveScopeArgs(args)).toThrow(message);
  });
});
