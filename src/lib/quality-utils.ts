/**
 * Subset of quality-feature-engineering utilities needed by the frontend.
 * Extracted from parent src/lib/quality-feature-engineering.ts to allow
 * standalone Vite builds (CI) without the parent dist/ directory.
 *
 * Keep in sync with the parent when these definitions change.
 */

// -- Types ------------------------------------------------------------------

export type ScoreDirection = 'maximize' | 'minimize';
export type ScoreColorBand = 'excellent' | 'good' | 'adequate' | 'poor' | 'failing';
export type LabelFilterCategory = 'Pass' | 'Review' | 'Fail';

export interface LabelOrdinal {
  ordinal: number;
  category: LabelFilterCategory;
  mapped: boolean;
}

import type { Role } from './constants.js';
export type FeatureRoleType = Role;

export interface RoleFeatureConfig {
  showCQI: boolean;
  showCQIBreakdown: boolean;
  showVariance: boolean;
  showAcceleration: boolean;
  showProjectedBreach: boolean;
  showCorrelationRemediation: boolean;
  showCoverageHeatmap: boolean;
  showPipelineFunnel: boolean;
  showProvenance: boolean;
  showRawExport: boolean;
  explanationTruncation: number;
  maxWorstEvaluations: number;
}

// -- Shared helpers ---------------------------------------------------------

export function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

export function truncateId(id: string, max = 10): string {
  if (id.length <= max) return id;
  return `${id.slice(0, 4)}\u2026${id.slice(-4)}`;
}

export function formatScore(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A';
  return val.toFixed(4);
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '\u2014';
  return `${value.toFixed(decimals)}%`;
}

export function plural(count: number, singular: string, suffix = 's'): string {
  return `${count} ${singular}${count !== 1 ? suffix : ''}`;
}

export const SCORE_COLORS: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
  no_data: '#6b7280',
};

/** Shorthand: returns the hex color for a given score + direction. */
export function scoreColor(value: number, direction?: ScoreDirection): string {
  return SCORE_COLORS[scoreColorBand(value, direction)];
}

// -- scoreColorBand ---------------------------------------------------------

export function scoreColorBand(
  value: number,
  direction: ScoreDirection = 'maximize',
): ScoreColorBand {
  const v = direction === 'minimize' ? 1 - value : value;
  if (v >= 0.9) return 'excellent';
  if (v >= 0.8) return 'good';
  if (v >= 0.6) return 'adequate';
  if (v >= 0.4) return 'poor';
  return 'failing';
}

// -- inferScoreDirection ----------------------------------------------------

type ThresholdDirection = 'above' | 'below';

export function inferScoreDirection(
  alertDirection: ThresholdDirection | undefined,
): ScoreDirection {
  return alertDirection === 'above' ? 'minimize' : 'maximize';
}

// -- Label ordinal encoding -------------------------------------------------

const LABEL_ORDINAL_MAP: Record<string, { ordinal: number; category: LabelFilterCategory }> = {
  excellent: { ordinal: 4, category: 'Pass' },
  highly_relevant: { ordinal: 4, category: 'Pass' },
  fully_faithful: { ordinal: 4, category: 'Pass' },
  perfect: { ordinal: 4, category: 'Pass' },
  relevant: { ordinal: 3, category: 'Pass' },
  good: { ordinal: 3, category: 'Pass' },
  faithful: { ordinal: 3, category: 'Pass' },
  pass: { ordinal: 3, category: 'Pass' },
  correct: { ordinal: 3, category: 'Pass' },
  coherent: { ordinal: 3, category: 'Pass' },
  partial: { ordinal: 2, category: 'Review' },
  borderline: { ordinal: 2, category: 'Review' },
  adequate: { ordinal: 2, category: 'Review' },
  mixed: { ordinal: 2, category: 'Review' },
  off_topic: { ordinal: 1, category: 'Fail' },
  irrelevant: { ordinal: 1, category: 'Fail' },
  unfaithful: { ordinal: 1, category: 'Fail' },
  fail: { ordinal: 1, category: 'Fail' },
  incorrect: { ordinal: 1, category: 'Fail' },
  incoherent: { ordinal: 1, category: 'Fail' },
  hallucinated: { ordinal: 0, category: 'Fail' },
  fabricated: { ordinal: 0, category: 'Fail' },
  toxic: { ordinal: 0, category: 'Fail' },
  dangerous: { ordinal: 0, category: 'Fail' },
};

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/-/g, '_').trim();
}

export function labelToOrdinal(label: string): LabelOrdinal {
  const normalized = normalizeLabel(label);
  const entry = LABEL_ORDINAL_MAP[normalized];
  if (entry) {
    return { ordinal: entry.ordinal, category: entry.category, mapped: true };
  }
  return { ordinal: 2, category: 'Review', mapped: false };
}

export function ordinalToCategory(ordinal: number): LabelFilterCategory {
  if (ordinal >= 3) return 'Pass';
  if (ordinal === 2) return 'Review';
  return 'Fail';
}

// -- Role feature config ----------------------------------------------------

export const ROLE_FEATURE_CONFIG: Record<FeatureRoleType, RoleFeatureConfig> = {
  executive: {
    showCQI: true,
    showCQIBreakdown: true,
    showVariance: false,
    showAcceleration: false,
    showProjectedBreach: true,
    showCorrelationRemediation: false,
    showCoverageHeatmap: false,
    showPipelineFunnel: false,
    showProvenance: false,
    showRawExport: false,
    explanationTruncation: 80,
    maxWorstEvaluations: 1,
  },
  operator: {
    showCQI: false,
    showCQIBreakdown: false,
    showVariance: true,
    showAcceleration: true,
    showProjectedBreach: true,
    showCorrelationRemediation: true,
    showCoverageHeatmap: true,
    showPipelineFunnel: true,
    showProvenance: false,
    showRawExport: false,
    explanationTruncation: 500,
    maxWorstEvaluations: 5,
  },
  auditor: {
    showCQI: true,
    showCQIBreakdown: true,
    showVariance: true,
    showAcceleration: false,
    showProjectedBreach: false,
    showCorrelationRemediation: true,
    showCoverageHeatmap: true,
    showPipelineFunnel: true,
    showProvenance: true,
    showRawExport: true,
    explanationTruncation: 2000,
    maxWorstEvaluations: 10,
  },
};

// -- Path/byte formatters ---------------------------------------------------

export function shortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? `\u2026/${parts.slice(-3).join('/')}` : fullPath;
}

export function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// -- Adaptive scoring -------------------------------------------------------

export interface PercentileDistribution {
  p10: number; p25: number; p50: number; p75: number; p90: number;
}

export type ScaleStrategy = 'quantile' | 'binary' | 'log' | 'step' | 'categorical' | 'percentile_rank' | 'uniform';

export const MIN_QUANTILE_SAMPLE_SIZE = 100;

const NUMERICAL_MIN_DENOMINATOR = 0.001;
const LOG_SCALE_DIVISOR = 3;
const BINARY_SCALE_EXCELLENT_THRESHOLD = 0.7;
const STEP_SCALE_EXCELLENT_THRESHOLD = 0.8;
const STEP_SCALE_ADEQUATE_THRESHOLD = 0.5;
const QUANTILE_P10 = 0.1;
const QUANTILE_P25 = 0.25;
const QUANTILE_P50 = 0.5;
const QUANTILE_P75 = 0.75;
const QUANTILE_P90 = 0.9;

export const METRIC_SCALE_STRATEGY: Record<string, ScaleStrategy> = {
  relevance: 'quantile',
  faithfulness: 'binary',
  coherence: 'uniform',
  hallucination: 'log',
  task_completion: 'step',
  tool_correctness: 'categorical',
  evaluation_latency: 'percentile_rank',
};

export function empiricalCDF(value: number, dist: PercentileDistribution): number {
  if (!Number.isFinite(value)) return QUANTILE_P50;
  const points: [number, number][] = [
    [dist.p10, QUANTILE_P10], [dist.p25, QUANTILE_P25],
    [dist.p50, QUANTILE_P50], [dist.p75, QUANTILE_P75], [dist.p90, QUANTILE_P90],
  ];
  if (value <= dist.p10) return Math.max(0, QUANTILE_P10 * (value / Math.max(dist.p10, NUMERICAL_MIN_DENOMINATOR)));
  if (value >= dist.p90) return Math.min(1, QUANTILE_P90 + QUANTILE_P10 * Math.min(1, (value - dist.p90) / Math.max(1 - dist.p90, NUMERICAL_MIN_DENOMINATOR)));
  for (let i = 0; i < points.length - 1; i++) {
    const [v0, p0] = points[i];
    const [v1, p1] = points[i + 1];
    if (value >= v0 && value <= v1) {
      const range = v1 - v0;
      if (range === 0) return p0;
      return p0 + (p1 - p0) * ((value - v0) / range);
    }
  }
  return QUANTILE_P50;
}

export function adaptiveScoreColorBand(
  value: number,
  metric: string,
  direction: ScoreDirection = 'maximize',
  distribution?: PercentileDistribution,
  sampleSize?: number,
): ScoreColorBand {
  const strategy = METRIC_SCALE_STRATEGY[metric] ?? 'uniform';
  switch (strategy) {
    case 'quantile': {
      if (!distribution || (sampleSize !== undefined && sampleSize < MIN_QUANTILE_SAMPLE_SIZE)) {
        return scoreColorBand(value, direction);
      }
      const rank = empiricalCDF(value, distribution);
      if (rank >= QUANTILE_P90) return 'excellent';
      if (rank >= QUANTILE_P75) return 'good';
      if (rank >= QUANTILE_P50) return 'adequate';
      if (rank >= QUANTILE_P25) return 'poor';
      return 'failing';
    }
    case 'log': {
      const clamped = Math.max(value, NUMERICAL_MIN_DENOMINATOR);
      const logNorm = Math.min(1, -Math.log10(clamped) / LOG_SCALE_DIVISOR);
      return scoreColorBand(logNorm, 'maximize');
    }
    case 'binary': return value >= BINARY_SCALE_EXCELLENT_THRESHOLD ? 'excellent' : 'failing';
    case 'step': return value >= STEP_SCALE_EXCELLENT_THRESHOLD ? 'excellent' : value >= STEP_SCALE_ADEQUATE_THRESHOLD ? 'adequate' : 'failing';
    case 'categorical': return scoreColorBand(value, direction);
    case 'percentile_rank': {
      if (!distribution) return scoreColorBand(value, direction);
      return scoreColorBand(empiricalCDF(value, distribution), 'maximize');
    }
    case 'uniform':
    default: return scoreColorBand(value, direction);
  }
}

// -- Timestamp formatting ---------------------------------------------------

import { format, differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts || '-';
  const now = new Date();
  const diffMin = differenceInMinutes(now, d);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = differenceInHours(now, d);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = differenceInDays(now, d);
  if (diffDay < 7) return `${diffDay}d ago`;
  return format(d, 'PP');
}
