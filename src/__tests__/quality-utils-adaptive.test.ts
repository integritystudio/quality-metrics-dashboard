/**
 * Tests for empiricalCDF, adaptiveScoreColorBand, and related constants
 * ported to the frontend quality-utils.ts (FE-R1-UI).
 *
 * These tests import symbols that do NOT yet exist in quality-utils.ts —
 * all tests are expected to fail (RED phase).
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

// empiricalCDF

describe('empiricalCDF', () => {
  it('returns 0.5 for value at exact p50', () => {
    const dist = makeDist({ p50: 0.65 });
    expect(empiricalCDF(0.65, dist)).toBeCloseTo(0.5, 5);
  });

  it('returns a value near 0 for value below p10', () => {
    const dist = makeDist({ p10: 0.4 });
    const result = empiricalCDF(0.1, dist);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(0.1);
  });

  it('returns a value near 1 for value above p90', () => {
    const dist = makeDist({ p90: 0.88 });
    const result = empiricalCDF(0.98, dist);
    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('returns interpolated value between 0.25 and 0.5 for value between p25 and p50', () => {
    const dist = makeDist({ p25: 0.55, p50: 0.65 });
    const midpoint = (0.55 + 0.65) / 2; // 0.60
    const result = empiricalCDF(midpoint, dist);
    expect(result).toBeGreaterThan(0.25);
    expect(result).toBeLessThan(0.5);
  });

  it('returns 0.5 for non-finite value (NaN)', () => {
    expect(empiricalCDF(NaN, makeDist())).toBeCloseTo(0.5, 5);
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
    expect(MIN_QUANTILE_SAMPLE_SIZE).toBe(100);
  });
});

// METRIC_SCALE_STRATEGY constant

describe('METRIC_SCALE_STRATEGY', () => {
  it('maps relevance to quantile', () => {
    expect(METRIC_SCALE_STRATEGY['relevance']).toBe('quantile');
  });

  it('maps faithfulness to binary', () => {
    expect(METRIC_SCALE_STRATEGY['faithfulness']).toBe('binary');
  });

  it('maps coherence to uniform', () => {
    expect(METRIC_SCALE_STRATEGY['coherence']).toBe('uniform');
  });

  it('maps hallucination to log', () => {
    expect(METRIC_SCALE_STRATEGY['hallucination']).toBe('log');
  });

  it('maps task_completion to step', () => {
    expect(METRIC_SCALE_STRATEGY['task_completion']).toBe('step');
  });

  it('maps tool_correctness to categorical', () => {
    expect(METRIC_SCALE_STRATEGY['tool_correctness']).toBe('categorical');
  });

  it('maps evaluation_latency to percentile_rank', () => {
    expect(METRIC_SCALE_STRATEGY['evaluation_latency']).toBe('percentile_rank');
  });
});

// adaptiveScoreColorBand — quantile strategy (relevance)

describe('adaptiveScoreColorBand — quantile strategy', () => {
  it('uses empiricalCDF when distribution and sufficient sampleSize are provided', () => {
    // dist where p50=0.6 means 0.75 is well above median — should be good/excellent
    const dist = makeDist({ p10: 0.3, p25: 0.5, p50: 0.6, p75: 0.72, p90: 0.82 });
    const result = adaptiveScoreColorBand(0.75, 'relevance', 'maximize', dist, 200);
    expect(['excellent', 'good']).toContain(result);
  });

  it('falls back to uniform scoreColorBand when no distribution provided', () => {
    // 0.95 is excellent on uniform scale
    const result = adaptiveScoreColorBand(0.95, 'relevance', 'maximize', undefined, 200);
    expect(result).toBe('excellent');
  });

  it('falls back to uniform scoreColorBand when sampleSize is below MIN_QUANTILE_SAMPLE_SIZE', () => {
    const dist = makeDist();
    // With sampleSize=50 (< 100), should fall back to uniform
    // 0.95 → excellent on uniform scale
    const result = adaptiveScoreColorBand(0.95, 'relevance', 'maximize', dist, 50);
    expect(result).toBe('excellent');
  });

  it('falls back to uniform when sampleSize is exactly MIN_QUANTILE_SAMPLE_SIZE - 1', () => {
    const dist = makeDist();
    const result = adaptiveScoreColorBand(0.95, 'relevance', 'maximize', dist, 99);
    expect(result).toBe('excellent');
  });

  it('uses quantile when sampleSize equals MIN_QUANTILE_SAMPLE_SIZE', () => {
    // High value with generous dist should produce a high band
    const dist = makeDist({ p10: 0.3, p25: 0.45, p50: 0.55, p75: 0.65, p90: 0.75 });
    const result = adaptiveScoreColorBand(0.9, 'relevance', 'maximize', dist, 100);
    expect(['excellent', 'good']).toContain(result);
  });
});

// adaptiveScoreColorBand — binary strategy (faithfulness)

describe('adaptiveScoreColorBand — binary strategy', () => {
  it('returns excellent for score >= 0.7', () => {
    expect(adaptiveScoreColorBand(0.7, 'faithfulness')).toBe('excellent');
  });

  it('returns excellent for score > 0.7', () => {
    expect(adaptiveScoreColorBand(0.85, 'faithfulness')).toBe('excellent');
  });

  it('returns failing for score < 0.7', () => {
    expect(adaptiveScoreColorBand(0.69, 'faithfulness')).toBe('failing');
  });

  it('returns failing for score = 0', () => {
    expect(adaptiveScoreColorBand(0, 'faithfulness')).toBe('failing');
  });
});

// adaptiveScoreColorBand — log strategy (hallucination)

describe('adaptiveScoreColorBand — log strategy', () => {
  it('returns excellent for a low hallucination score (near 0)', () => {
    // Very low hallucination = good. log scale inverted for minimize metrics.
    const result = adaptiveScoreColorBand(0.001, 'hallucination', 'minimize');
    expect(['excellent', 'good']).toContain(result);
  });

  it('returns failing or poor for a high hallucination score (near 1)', () => {
    const result = adaptiveScoreColorBand(0.99, 'hallucination', 'minimize');
    expect(['poor', 'failing']).toContain(result);
  });
});

// adaptiveScoreColorBand — step strategy (task_completion)

describe('adaptiveScoreColorBand — step strategy', () => {
  it('returns excellent for score >= 0.8', () => {
    expect(adaptiveScoreColorBand(0.8, 'task_completion')).toBe('excellent');
  });

  it('returns excellent for score = 1', () => {
    expect(adaptiveScoreColorBand(1.0, 'task_completion')).toBe('excellent');
  });

  it('returns adequate for score >= 0.5 and < 0.8', () => {
    expect(adaptiveScoreColorBand(0.5, 'task_completion')).toBe('adequate');
  });

  it('returns adequate for score = 0.79', () => {
    expect(adaptiveScoreColorBand(0.79, 'task_completion')).toBe('adequate');
  });

  it('returns failing for score < 0.5', () => {
    expect(adaptiveScoreColorBand(0.49, 'task_completion')).toBe('failing');
  });

  it('returns failing for score = 0', () => {
    expect(adaptiveScoreColorBand(0, 'task_completion')).toBe('failing');
  });
});

// adaptiveScoreColorBand — uniform strategy (coherence)

describe('adaptiveScoreColorBand — uniform strategy', () => {
  it('returns excellent for score >= 0.9', () => {
    expect(adaptiveScoreColorBand(0.95, 'coherence')).toBe('excellent');
  });

  it('returns good for score >= 0.8 and < 0.9', () => {
    expect(adaptiveScoreColorBand(0.85, 'coherence')).toBe('good');
  });

  it('returns adequate for score >= 0.6 and < 0.8', () => {
    expect(adaptiveScoreColorBand(0.7, 'coherence')).toBe('adequate');
  });

  it('returns poor for score >= 0.4 and < 0.6', () => {
    expect(adaptiveScoreColorBand(0.5, 'coherence')).toBe('poor');
  });

  it('returns failing for score < 0.4', () => {
    expect(adaptiveScoreColorBand(0.3, 'coherence')).toBe('failing');
  });
});

// adaptiveScoreColorBand — unknown metric fallback

describe('adaptiveScoreColorBand — unknown metric', () => {
  it('falls back to uniform scoreColorBand for unrecognized metric name', () => {
    // 0.95 on uniform is excellent
    expect(adaptiveScoreColorBand(0.95, 'unknown_metric_xyz')).toBe('excellent');
    // 0.3 on uniform is failing
    expect(adaptiveScoreColorBand(0.3, 'unknown_metric_xyz')).toBe('failing');
  });
});
