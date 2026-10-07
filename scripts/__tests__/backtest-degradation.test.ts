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

/** Nanosecond timestamp for a given ms offset from epoch 0. */
function tsNs(ms: number): bigint {
  return BigInt(ms) * NS_PER_MS;
}

describe('buildDailyBuckets', () => {
  it('distributes evaluations into the correct daily bucket', () => {
    const startMs = 0;
    const buckets = buildDailyBuckets(
      [
        { timestamp: tsNs(0), scoreValue: 0.9 },            // day 0
        { timestamp: tsNs(DAY_MS + 1000), scoreValue: 0.5 }, // day 1
        { timestamp: tsNs(2 * DAY_MS), scoreValue: 0.3 },    // day 2
      ],
      startMs,
      3,
    );

    expect(buckets).toHaveLength(3);
    expect(buckets[0]?.scores).toEqual([0.9]);
    expect(buckets[1]?.scores).toEqual([0.5]);
    expect(buckets[2]?.scores).toEqual([0.3]);
  });

  it('drops evaluations outside the bucket window', () => {
    const startMs = DAY_MS; // window starts at day 1
    const buckets = buildDailyBuckets(
      [
        { timestamp: tsNs(0), scoreValue: 0.9 },          // before window
        { timestamp: tsNs(DAY_MS), scoreValue: 0.7 },      // day 0 of window
        { timestamp: tsNs(3 * DAY_MS), scoreValue: 0.4 }, // beyond window (only 1 bucket)
      ],
      startMs,
      1,
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.scores).toEqual([0.7]);
  });

  it('returns empty score arrays for buckets with no evaluations', () => {
    const startMs = 0;
    const buckets = buildDailyBuckets([], startMs, 3);
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
    expect(points).toHaveLength(3);
    expect(points[0]?.coverageGapCount).toBe(0);
    expect(points[1]?.coverageGapCount).toBe(1);
    expect(points[2]?.coverageGapCount).toBe(1);
  });

  it('preserves cumulative historical values across points', () => {
    const buckets = [
      { timestamp: 0, scores: [0.5] },
      { timestamp: DAY_MS, scores: [0.6, 0.7] },
    ];

    const points = buildTimeSeries(buckets);
    expect(points[0]?.historicalValues).toEqual([0.5]);
    expect(points[1]?.historicalValues).toEqual([0.5, 0.6, 0.7]);
  });

  it('sets latency fields to 0 (not available from evaluation data)', () => {
    const buckets = [{ timestamp: 0, scores: [0.8] }];
    const [point] = buildTimeSeries(buckets);
    expect(point?.latencyP95Seconds).toBe(0);
    expect(point?.latencyP50Seconds).toBe(0);
  });
});
