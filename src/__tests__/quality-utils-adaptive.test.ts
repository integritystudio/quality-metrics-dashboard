/**
 * Tests for empiricalCDF, adaptiveScoreColorBand, and related constants
 * in quality-utils.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  empiricalCDF,
  adaptiveScoreColorBand,
  MIN_QUANTILE_SAMPLE_SIZE,
  METRIC_SCALE_STRATEGY,
  type PercentileDistribution,
} from '../lib/quality-utils.js';

// Test fixtures

function makeDist(overrides: Partial<PercentileDistribution> = {}): PercentileDistribution {
  return {
    p10: 0.4,
    p25: 0.55,
    p50: 0.65,
    p75: 0.78,
    p90: 0.88,
    ...overrides,
  };
}

const CLOSE_TO_DIGITS = 5;
/** The CDF value each percentile of the distribution maps to. */
const CDF = { p10: 0.1, p25: 0.25, median: 0.5, p90: 0.9 };
const OUTSIDE_DIST = { belowP10: 0.1, aboveP90: 0.98 };
const QUANTILE_SCORES = { aboveMedian: 0.75, high: 0.9 };
const BINARY_SCORES = { threshold: 0.7, above: 0.85, below: 0.69 };
const LOG_SCORES = { nearZero: 0.001, nearOne: 0.99 };
const STEP_SCORES = { excellent: 0.8, justBelowExcellent: 0.79, adequate: 0.5, justBelowAdequate: 0.49 };
const UNIFORM_SCORES = { excellent: 0.95, good: 0.85, adequate: 0.7, poor: 0.5, failing: 0.3 };

// empiricalCDF

describe('empiricalCDF', () => {
  it('returns 0.5 for value at exact p50', () => {
    const dist = makeDist({ p50: 0.65 });
    expect(empiricalCDF(dist.p50, dist)).toBeCloseTo(CDF.median, CLOSE_TO_DIGITS);
  });

  it('returns a value near 0 for value below p10', () => {
    const dist = makeDist({ p10: 0.4 });
    const result = empiricalCDF(OUTSIDE_DIST.belowP10, dist);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(CDF.p10);
  });

  it('returns a value near 1 for value above p90', () => {
    const dist = makeDist({ p90: 0.88 });
    const result = empiricalCDF(OUTSIDE_DIST.aboveP90, dist);
    expect(result).toBeGreaterThanOrEqual(CDF.p90);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns interpolated value between 0.25 and 0.5 for value between p25 and p50', () => {
    const dist = makeDist({ p25: 0.55, p50: 0.65 });
    const midpoint = (dist.p25 + dist.p50) / 2;
    const result = empiricalCDF(midpoint, dist);
    expect(result).toBeGreaterThan(CDF.p25);
    expect(result).toBeLessThan(CDF.median);
  });

  it('returns 0.5 for non-finite value (NaN)', () => {
    expect(empiricalCDF(NaN, makeDist())).toBeCloseTo(CDF.median, CLOSE_TO_DIGITS);
  });

  it('returns 0.5 for non-finite value (Infinity)', () => {
    expect(empiricalCDF(Infinity, makeDist())).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 for non-finite value (-Infinity)', () => {
    expect(empiricalCDF(-Infinity, makeDist())).toBeGreaterThanOrEqual(0);
  });
});

// MIN_QUANTILE_SAMPLE_SIZE constant

describe('MIN_QUANTILE_SAMPLE_SIZE', () => {
  it('equals 100', () => {
    const EXPECTED_MIN_QUANTILE_SAMPLE_SIZE = 100;
    expect(MIN_QUANTILE_SAMPLE_SIZE).toBe(EXPECTED_MIN_QUANTILE_SAMPLE_SIZE);
  });
});

// METRIC_SCALE_STRATEGY constant

describe('METRIC_SCALE_STRATEGY', () => {
  it('maps relevance to quantile', () => {
    expect(METRIC_SCALE_STRATEGY.relevance).toBe('quantile');
  });

  it('maps faithfulness to binary', () => {
    expect(METRIC_SCALE_STRATEGY.faithfulness).toBe('binary');
  });

  it('maps coherence to uniform', () => {
    expect(METRIC_SCALE_STRATEGY.coherence).toBe('uniform');
  });

  it('maps hallucination to log', () => {
    expect(METRIC_SCALE_STRATEGY.hallucination).toBe('log');
  });

  it('maps task_completion to step', () => {
    expect(METRIC_SCALE_STRATEGY.task_completion).toBe('step');
  });

  it('maps tool_correctness to categorical', () => {
    expect(METRIC_SCALE_STRATEGY.tool_correctness).toBe('categorical');
  });

  it('maps evaluation_latency to percentile_rank', () => {
    expect(METRIC_SCALE_STRATEGY.evaluation_latency).toBe('percentile_rank');
  });
});

// adaptiveScoreColorBand — quantile strategy (relevance)

describe('adaptiveScoreColorBand — quantile strategy', () => {
  it('uses empiricalCDF when distribution and sufficient sampleSize are provided', () => {
    // dist where p50=0.6 means 0.75 is well above median — should be good/excellent
    const dist = makeDist({ p10: 0.3, p25: 0.5, p50: 0.6, p75: 0.72, p90: 0.82 });
    const result = adaptiveScoreColorBand(QUANTILE_SCORES.aboveMedian, 'relevance', 'maximize', { distribution: dist, sampleSize: 200 });
    expect(['excellent', 'good']).toContain(result);
  });

  it('falls back to uniform scoreColorBand when no distribution provided', () => {
    // 0.95 is excellent on uniform scale
    const result = adaptiveScoreColorBand(UNIFORM_SCORES.excellent, 'relevance', 'maximize', undefined);
    expect(result).toBe('excellent');
  });

  it('falls back to uniform scoreColorBand when sampleSize is below MIN_QUANTILE_SAMPLE_SIZE', () => {
    const dist = makeDist();
    // With sampleSize=50 (< 100), should fall back to uniform
    // 0.95 → excellent on uniform scale
    const result = adaptiveScoreColorBand(UNIFORM_SCORES.excellent, 'relevance', 'maximize', { distribution: dist, sampleSize: 50 });
    expect(result).toBe('excellent');
  });

  it('falls back to uniform when sampleSize is exactly MIN_QUANTILE_SAMPLE_SIZE - 1', () => {
    const dist = makeDist();
    const result = adaptiveScoreColorBand(UNIFORM_SCORES.excellent, 'relevance', 'maximize', { distribution: dist, sampleSize: MIN_QUANTILE_SAMPLE_SIZE - 1 });
    expect(result).toBe('excellent');
  });

  it('uses quantile when sampleSize equals MIN_QUANTILE_SAMPLE_SIZE', () => {
    // High value with generous dist should produce a high band
    const dist = makeDist({ p10: 0.3, p25: 0.45, p50: 0.55, p75: 0.65, p90: 0.75 });
    const result = adaptiveScoreColorBand(QUANTILE_SCORES.high, 'relevance', 'maximize', { distribution: dist, sampleSize: MIN_QUANTILE_SAMPLE_SIZE });
    expect(['excellent', 'good']).toContain(result);
  });
});

// adaptiveScoreColorBand — binary strategy (faithfulness)

describe('adaptiveScoreColorBand — binary strategy', () => {
  it('returns excellent for score >= 0.7', () => {
    expect(adaptiveScoreColorBand(BINARY_SCORES.threshold, 'faithfulness')).toBe('excellent');
  });

  it('returns excellent for score > 0.7', () => {
    expect(adaptiveScoreColorBand(BINARY_SCORES.above, 'faithfulness')).toBe('excellent');
  });

  it('returns failing for score < 0.7', () => {
    expect(adaptiveScoreColorBand(BINARY_SCORES.below, 'faithfulness')).toBe('failing');
  });

  it('returns failing for score = 0', () => {
    expect(adaptiveScoreColorBand(0, 'faithfulness')).toBe('failing');
  });
});

// adaptiveScoreColorBand — log strategy (hallucination)

describe('adaptiveScoreColorBand — log strategy', () => {
  it('returns excellent for a low hallucination score (near 0)', () => {
    // Very low hallucination = good. log scale inverted for minimize metrics.
    const result = adaptiveScoreColorBand(LOG_SCORES.nearZero, 'hallucination', 'minimize');
    expect(['excellent', 'good']).toContain(result);
  });

  it('returns failing or poor for a high hallucination score (near 1)', () => {
    const result = adaptiveScoreColorBand(LOG_SCORES.nearOne, 'hallucination', 'minimize');
    expect(['poor', 'failing']).toContain(result);
  });
});

// adaptiveScoreColorBand — step strategy (task_completion)

describe('adaptiveScoreColorBand — step strategy', () => {
  it('returns excellent for score >= 0.8', () => {
    expect(adaptiveScoreColorBand(STEP_SCORES.excellent, 'task_completion')).toBe('excellent');
  });

  it('returns excellent for score = 1', () => {
    expect(adaptiveScoreColorBand(1.0, 'task_completion')).toBe('excellent');
  });

  it('returns adequate for score >= 0.5 and < 0.8', () => {
    expect(adaptiveScoreColorBand(STEP_SCORES.adequate, 'task_completion')).toBe('adequate');
  });

  it('returns adequate for score = 0.79', () => {
    expect(adaptiveScoreColorBand(STEP_SCORES.justBelowExcellent, 'task_completion')).toBe('adequate');
  });

  it('returns failing for score < 0.5', () => {
    expect(adaptiveScoreColorBand(STEP_SCORES.justBelowAdequate, 'task_completion')).toBe('failing');
  });

  it('returns failing for score = 0', () => {
    expect(adaptiveScoreColorBand(0, 'task_completion')).toBe('failing');
  });
});

// adaptiveScoreColorBand — uniform strategy (coherence)

describe('adaptiveScoreColorBand — uniform strategy', () => {
  it('returns excellent for score >= 0.9', () => {
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.excellent, 'coherence')).toBe('excellent');
  });

  it('returns good for score >= 0.8 and < 0.9', () => {
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.good, 'coherence')).toBe('good');
  });

  it('returns adequate for score >= 0.6 and < 0.8', () => {
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.adequate, 'coherence')).toBe('adequate');
  });

  it('returns poor for score >= 0.4 and < 0.6', () => {
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.poor, 'coherence')).toBe('poor');
  });

  it('returns failing for score < 0.4', () => {
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.failing, 'coherence')).toBe('failing');
  });
});

// adaptiveScoreColorBand — unknown metric fallback

describe('adaptiveScoreColorBand — unknown metric', () => {
  it('falls back to uniform scoreColorBand for unrecognized metric name', () => {
    // 0.95 on uniform is excellent
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.excellent, 'unknown_metric_xyz')).toBe('excellent');
    // 0.3 on uniform is failing
    expect(adaptiveScoreColorBand(UNIFORM_SCORES.failing, 'unknown_metric_xyz')).toBe('failing');
  });
});
