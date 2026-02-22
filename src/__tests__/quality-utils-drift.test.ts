/**
 * Drift detection for dashboard/src/lib/quality-utils.ts (DR12).
 *
 * These tests pin the exact output of every exported function and constant
 * against reference values derived from src/lib/quality-feature-engineering.ts.
 * If the parent changes a threshold or mapping and quality-utils.ts is not
 * updated, at least one assertion here will fail.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreColorBand,
  inferScoreDirection,
  labelToOrdinal,
  ordinalToCategory,
  truncateText,
  ROLE_FEATURE_CONFIG,
  SCORE_COLORS,
} from '../lib/quality-utils.js';

// ---------------------------------------------------------------------------
// scoreColorBand
// ---------------------------------------------------------------------------

describe('scoreColorBand', () => {
  describe('maximize direction (default)', () => {
    it.each<[number, string]>([
      [1.0, 'excellent'],
      [0.95, 'excellent'],
      [0.9, 'excellent'],   // >= 0.9 threshold
      [0.89, 'good'],
      [0.8, 'good'],        // >= 0.8 threshold
      [0.79, 'adequate'],
      [0.6, 'adequate'],    // >= 0.6 threshold
      [0.59, 'poor'],
      [0.4, 'poor'],        // >= 0.4 threshold
      [0.39, 'failing'],
      [0.0, 'failing'],
    ])('score %f → %s', (score, expected) => {
      expect(scoreColorBand(score, 'maximize')).toBe(expected);
    });
  });

  describe('minimize direction', () => {
    it.each<[number, string]>([
      [0.0, 'excellent'],   // 1 - 0.0 = 1.0 >= 0.9
      [0.1, 'excellent'],   // 1 - 0.1 = 0.9 >= 0.9
      [0.11, 'good'],       // 1 - 0.11 = 0.89 >= 0.8
      [0.2, 'good'],        // 1 - 0.2 = 0.8 >= 0.8
      [0.4, 'adequate'],    // 1 - 0.4 = 0.6 >= 0.6
      [0.6, 'poor'],        // 1 - 0.6 = 0.4 >= 0.4
      [0.61, 'failing'],    // 1 - 0.61 = 0.39
    ])('score %f → %s', (score, expected) => {
      expect(scoreColorBand(score, 'minimize')).toBe(expected);
    });
  });

  it('defaults to maximize when direction omitted', () => {
    expect(scoreColorBand(0.95)).toBe('excellent');
    expect(scoreColorBand(0.5)).toBe('poor');
  });
});

// ---------------------------------------------------------------------------
// inferScoreDirection
// ---------------------------------------------------------------------------

describe('inferScoreDirection', () => {
  it('above → minimize', () => {
    expect(inferScoreDirection('above')).toBe('minimize');
  });

  it('below → maximize', () => {
    expect(inferScoreDirection('below')).toBe('maximize');
  });

  it('undefined → maximize', () => {
    expect(inferScoreDirection(undefined)).toBe('maximize');
  });
});

// ---------------------------------------------------------------------------
// labelToOrdinal
// ---------------------------------------------------------------------------

describe('labelToOrdinal', () => {
  it.each([
    ['excellent', 4, 'Pass'],
    ['highly_relevant', 4, 'Pass'],
    ['fully_faithful', 4, 'Pass'],
    ['perfect', 4, 'Pass'],
    ['relevant', 3, 'Pass'],
    ['good', 3, 'Pass'],
    ['faithful', 3, 'Pass'],
    ['pass', 3, 'Pass'],
    ['correct', 3, 'Pass'],
    ['coherent', 3, 'Pass'],
    ['partial', 2, 'Review'],
    ['borderline', 2, 'Review'],
    ['adequate', 2, 'Review'],
    ['mixed', 2, 'Review'],
    ['off_topic', 1, 'Fail'],
    ['irrelevant', 1, 'Fail'],
    ['unfaithful', 1, 'Fail'],
    ['fail', 1, 'Fail'],
    ['incorrect', 1, 'Fail'],
    ['incoherent', 1, 'Fail'],
    ['hallucinated', 0, 'Fail'],
    ['fabricated', 0, 'Fail'],
    ['toxic', 0, 'Fail'],
    ['dangerous', 0, 'Fail'],
  ] as [string, number, string][])('"%s" → ordinal %i, category %s', (label, ordinal, category) => {
    const result = labelToOrdinal(label);
    expect(result.ordinal).toBe(ordinal);
    expect(result.category).toBe(category);
    expect(result.mapped).toBe(true);
  });

  it('normalizes case and hyphens', () => {
    expect(labelToOrdinal('EXCELLENT').ordinal).toBe(4);
    expect(labelToOrdinal('highly-relevant').ordinal).toBe(4);
    expect(labelToOrdinal('Fully_Faithful').ordinal).toBe(4);
  });

  it('unknown label → ordinal 2, Review, mapped false', () => {
    const result = labelToOrdinal('unknown_label');
    expect(result).toEqual({ ordinal: 2, category: 'Review', mapped: false });
  });
});

// ---------------------------------------------------------------------------
// ordinalToCategory
// ---------------------------------------------------------------------------

describe('ordinalToCategory', () => {
  it.each<[number, string]>([
    [4, 'Pass'],
    [3, 'Pass'],
    [2, 'Review'],
    [1, 'Fail'],
    [0, 'Fail'],
  ])('ordinal %i → %s', (ordinal, expected) => {
    expect(ordinalToCategory(ordinal)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// SCORE_COLORS
// ---------------------------------------------------------------------------

describe('SCORE_COLORS', () => {
  it('has all required bands', () => {
    const bands = ['excellent', 'good', 'adequate', 'poor', 'failing', 'no_data'] as const;
    for (const band of bands) {
      expect(SCORE_COLORS[band]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('pins exact color values (drift sentinel)', () => {
    expect(SCORE_COLORS.excellent).toBe('#26d97f');
    expect(SCORE_COLORS.good).toBe('#34d399');
    expect(SCORE_COLORS.adequate).toBe('#e5a00d');
    expect(SCORE_COLORS.poor).toBe('#f97316');
    expect(SCORE_COLORS.failing).toBe('#f04438');
    expect(SCORE_COLORS.no_data).toBe('#6b7280');
  });
});

// ---------------------------------------------------------------------------
// ROLE_FEATURE_CONFIG shape (sentinel)
// ---------------------------------------------------------------------------

describe('ROLE_FEATURE_CONFIG', () => {
  const roles = ['executive', 'operator', 'auditor'] as const;

  it('has all three roles', () => {
    for (const role of roles) {
      expect(ROLE_FEATURE_CONFIG[role]).toBeDefined();
    }
  });

  it('executive hides variance and operator controls', () => {
    expect(ROLE_FEATURE_CONFIG.executive.showVariance).toBe(false);
    expect(ROLE_FEATURE_CONFIG.executive.showAcceleration).toBe(false);
    expect(ROLE_FEATURE_CONFIG.executive.showRawExport).toBe(false);
    expect(ROLE_FEATURE_CONFIG.executive.maxWorstEvaluations).toBe(1);
  });

  it('operator shows operational metrics', () => {
    expect(ROLE_FEATURE_CONFIG.operator.showVariance).toBe(true);
    expect(ROLE_FEATURE_CONFIG.operator.showCorrelationRemediation).toBe(true);
    expect(ROLE_FEATURE_CONFIG.operator.showCoverageHeatmap).toBe(true);
    expect(ROLE_FEATURE_CONFIG.operator.maxWorstEvaluations).toBe(5);
  });

  it('auditor has full access with raw export', () => {
    expect(ROLE_FEATURE_CONFIG.auditor.showProvenance).toBe(true);
    expect(ROLE_FEATURE_CONFIG.auditor.showRawExport).toBe(true);
    expect(ROLE_FEATURE_CONFIG.auditor.maxWorstEvaluations).toBe(10);
    expect(ROLE_FEATURE_CONFIG.auditor.explanationTruncation).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------

describe('truncateText', () => {
  it('returns original text when under limit', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('truncates at max and appends ellipsis', () => {
    expect(truncateText('hello world', 5)).toBe('hello...');
  });

  it('returns original when exactly at limit', () => {
    expect(truncateText('hello', 5)).toBe('hello');
  });
});
