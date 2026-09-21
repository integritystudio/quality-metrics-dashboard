import { describe, it, expect } from 'vitest';
import {
  JUDGE_EXIT_BILLING,
  JUDGE_EXIT_NO_SCORES,
  JUDGE_SOFT_FAILURE_EXITS,
  SYNC_RETRY_DELAYS_MS,
  isTransientNetworkFailure,
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
  it('treats both judge codes as soft failures and nothing else', () => {
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_BILLING)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(JUDGE_EXIT_NO_SCORES)).toBe(true);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(1)).toBe(false);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(0)).toBe(false);
  });

  it('bounds the sync retry window to between fifteen and thirty minutes', () => {
    const total = SYNC_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

    expect(total).toBeGreaterThanOrEqual(15 * MS_PER_MINUTE);
    expect(total).toBeLessThanOrEqual(30 * MS_PER_MINUTE);
  });
});
