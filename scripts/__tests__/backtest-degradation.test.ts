/**
 * Unit tests for the pure, exported helpers in backtest-degradation.ts.
 *
 * The script's main() path requires CloudBackend + local JSONL files, so we
 * test only the self-contained helpers: buildDailyBuckets and buildTimeSeries.
 */

import { describe, it, expect } from 'vitest';
import { buildDailyBuckets, buildTimeSeries } from '../backtest-degradation.js';

const DAY_MS = 86_400_000;
const NS_PER_MS = 1_000_000n;
const BUCKET_DAYS = 3;
const DAILY_SCORES = { day0: 0.9, day1: 0.5, day2: 0.3 };
const IN_WINDOW_SCORE = 0.7;
const FIRST_DAY_SCORES = [0.5];
const SECOND_DAY_SCORES = [0.6, 0.7];

/** Nanosecond timestamp for a given ms offset from epoch 0. */
function tsNs(ms: number): bigint {
  return BigInt(ms) * NS_PER_MS;
}

describe('buildDailyBuckets', () => {
  it('distributes evaluations into the correct daily bucket', () => {
    const startMs = 0;
    const evaluations = [
      { timestamp: tsNs(0), scoreValue: DAILY_SCORES.day0 },            // day 0
      { timestamp: tsNs(DAY_MS + 1000), scoreValue: DAILY_SCORES.day1 }, // day 1
      { timestamp: tsNs(2 * DAY_MS), scoreValue: DAILY_SCORES.day2 },    // day 2
    ];
    const buckets = buildDailyBuckets(evaluations, startMs, BUCKET_DAYS);

    expect(buckets).toHaveLength(BUCKET_DAYS);
    expect(buckets[0]?.scores).toEqual([DAILY_SCORES.day0]);
    expect(buckets[1]?.scores).toEqual([DAILY_SCORES.day1]);
    expect(buckets[2]?.scores).toEqual([DAILY_SCORES.day2]);
  });

  it('drops evaluations outside the bucket window', () => {
    const startMs = DAY_MS; // window starts at day 1
    const evaluations = [
      { timestamp: tsNs(0), scoreValue: 0.9 },                     // before window
      { timestamp: tsNs(DAY_MS), scoreValue: IN_WINDOW_SCORE },     // day 0 of window
      { timestamp: tsNs(3 * DAY_MS), scoreValue: 0.4 },            // beyond window (only 1 bucket)
    ];
    const buckets = buildDailyBuckets(evaluations, startMs, 1);

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.scores).toEqual([IN_WINDOW_SCORE]);
  });

  it('returns empty score arrays for buckets with no evaluations', () => {
    const startMs = 0;
    const buckets = buildDailyBuckets([], startMs, BUCKET_DAYS);
    expect(buckets.every(b => b.scores.length === 0)).toBe(true);
  });
});

describe('buildTimeSeries', () => {
  it('returns one point per bucket with correct coverageGapCount', () => {
    const buckets = [
      { timestamp: 0, scores: [0.8, 0.9] },
      { timestamp: DAY_MS, scores: [] },          // gap
      { timestamp: 2 * DAY_MS, scores: [0.7] },
    ];

    const points = buildTimeSeries(buckets);
    expect(points).toHaveLength(buckets.length);
    expect(points[0]?.coverageGapCount).toBe(0);
    expect(points[1]?.coverageGapCount).toBe(1);
    expect(points[2]?.coverageGapCount).toBe(1);
  });

  it('preserves cumulative historical values across points', () => {
    const buckets = [
      { timestamp: 0, scores: FIRST_DAY_SCORES },
      { timestamp: DAY_MS, scores: SECOND_DAY_SCORES },
    ];

    const points = buildTimeSeries(buckets);
    expect(points[0]?.historicalValues).toEqual(FIRST_DAY_SCORES);
    expect(points[1]?.historicalValues).toEqual([...FIRST_DAY_SCORES, ...SECOND_DAY_SCORES]);
  });

  it('sets latency fields to 0 (not available from evaluation data)', () => {
    const buckets = [{ timestamp: 0, scores: [0.8] }];
    const [point] = buildTimeSeries(buckets);
    expect(point?.latencyP95Seconds).toBe(0);
    expect(point?.latencyP50Seconds).toBe(0);
  });
});
