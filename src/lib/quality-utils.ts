/**
 * Subset of the parent's quality utilities needed by the frontend.
 * Duplicated rather than imported so Vite can build standalone (CI) without the
 * parent `dist/` directory — the parent's runtime values cannot reach frontend
 * code in any case (`src/api/parent/*` barrels are Node-only).
 *
 * Keep in sync with the parent when these definitions change. The parent module
 * that was the single source, `src/lib/quality/quality-feature-engineering.ts`,
 * no longer exists — it was split into `src/lib/quality/qfe-*.ts`, so the
 * counterparts now live in several files:
 *   - ROLE_DISPLAY_LIMITS, ROLE_FEATURE_CONFIG        → `qfe-role-config.ts`
 *   - scoreColorBand, labelToOrdinal, ordinalToCategory → `qfe-label-ordinals.ts`
 *
 * ⚠️ Nothing enforces this sync. `src/__tests__/quality-utils-drift.test.ts`
 * pins these values against literals in its own file, not against the parent,
 * so it catches an edit to THIS file and cannot catch parent drift.
 */

export type ScoreDirection = 'maximize' | 'minimize';
export type ScoreColorBand = 'excellent' | 'good' | 'adequate' | 'poor' | 'failing';
export type LabelFilterCategory = 'Pass' | 'Review' | 'Fail';

export type LabelOrdinal = {
  ordinal: number;
  category: LabelFilterCategory;
  mapped: boolean;
}

import { scaleLinear, scaleOrdinal, scaleThreshold, type ScaleThreshold } from 'd3-scale';
import {
  type Role,
  AGENT_PALETTE,
  FAIL_SCORE_LABEL,
  HALLUCINATION_RISK_EVALUATION_NAMES,
  HALLUCINATION_RISK_THRESHOLD,
  SCORE_FORMAT_PRECISION,
  COMPACT_UNIT_PRECISION,
  TIME_MS,
  MINUTES_PER_HOUR,
  HOURS_PER_DAY,
  DAYS_PER_WEEK,
  ID_DISPLAY_MAX_CHARS,
  ID_DISPLAY_EDGE_CHARS,
  PERCENT_MULTIPLIER,
} from './constants.js';
export type FeatureRoleType = Role;

/** Each agent's palette color by its position in `agentNames`, cycling; an unlisted agent gets the first color. */
export function agentColorScale(agentNames: readonly string[]): (agentName: string) => string {
  return scaleOrdinal<string, string, string>(AGENT_PALETTE).domain(agentNames).unknown(AGENT_PALETTE[0]);
}

export type RoleFeatureConfig = {
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

export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function truncateId(id: string, max = ID_DISPLAY_MAX_CHARS): string {
  if (id.length <= max) return id;
  return `${id.slice(0, ID_DISPLAY_EDGE_CHARS)}\u2026${id.slice(-ID_DISPLAY_EDGE_CHARS)}`;
}

/** `part` as a percentage of `whole`. */
export function percentOf(part: number, whole: number): number {
  return (part / whole) * PERCENT_MULTIPLIER;
}

/** The fields of an evaluation that decide whether it is a failure or a hallucination indicator. */
export type ScoredEvaluation = {
  evaluationName: string;
  scoreValue?: number | null | undefined;
  scoreLabel?: string | null | undefined;
};

/** Whether an evaluation carries the failing label. */
export function isFailedEvaluation(evaluation: ScoredEvaluation): boolean {
  return (evaluation.scoreLabel ?? '').toLowerCase() === FAIL_SCORE_LABEL;
}

/**
 * Whether an evaluation indicates hallucination: a hallucination rate at or above
 * HALLUCINATION_RISK_THRESHOLD. A hallucination score is higher-is-worse, so a
 * low one (no fabrication found) is not an indicator, and neither is an evaluation
 * with no finite score. Other metrics never are, however low or failed: a failed
 * evaluation belongs in the failed list (isFailedEvaluation), not here.
 */
export function isHallucinationIndicator(evaluation: ScoredEvaluation): boolean {
  const score = evaluation.scoreValue;
  if (typeof score !== 'number' || !Number.isFinite(score)) return false;
  return HALLUCINATION_RISK_EVALUATION_NAMES.has(evaluation.evaluationName.toLowerCase())
    && score >= HALLUCINATION_RISK_THRESHOLD;
}

export function formatScore(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A';
  return val.toFixed(SCORE_FORMAT_PRECISION);
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '\u2014';
  return `${value.toFixed(decimals)}%`;
}

export function plural(count: number, singular: string, suffix = 's'): string {
  return `${count} ${singular}${count !== 1 ? suffix : ''}`;
}

export const byValueDesc = ([, a]: [string, number], [, b]: [string, number]): number => b - a;

export const SCORE_COLORS: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
  no_data: '#6b7280',
};

export function scoreColor(value: number, direction?: ScoreDirection): string {
  return SCORE_COLORS[scoreColorBand(value, direction)];
}

const SCORE_BANDS_ASCENDING: ScoreColorBand[] = ['failing', 'poor', 'adequate', 'good', 'excellent'];
const SCORE_BAND_LOWER_BOUNDS = [0.4, 0.6, 0.8, 0.9];

function bandScale(lowerBounds: number[]): ScaleThreshold<number, ScoreColorBand, ScoreColorBand> {
  return scaleThreshold<number, ScoreColorBand>()
    .domain(lowerBounds)
    .range(SCORE_BANDS_ASCENDING)
    .unknown<ScoreColorBand>('failing');
}

const scoreBandOf = bandScale(SCORE_BAND_LOWER_BOUNDS);

export function scoreColorBand(
  value: number,
  direction: ScoreDirection = 'maximize',
): ScoreColorBand {
  return scoreBandOf(direction === 'minimize' ? 1 - value : value);
}

type ThresholdDirection = 'above' | 'below';

export function inferScoreDirection(
  alertDirection: ThresholdDirection | undefined,
): ScoreDirection {
  return alertDirection === 'above' ? 'minimize' : 'maximize';
}

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
  complete: { ordinal: 3, category: 'Pass' },
  appropriate: { ordinal: 3, category: 'Pass' },
  partial: { ordinal: 2, category: 'Review' },
  borderline: { ordinal: 2, category: 'Review' },
  adequate: { ordinal: 2, category: 'Review' },
  mixed: { ordinal: 2, category: 'Review' },
  off_topic: { ordinal: 1, category: 'Fail' },
  irrelevant: { ordinal: 1, category: 'Fail' },
  not_relevant: { ordinal: 1, category: 'Fail' },
  unfaithful: { ordinal: 1, category: 'Fail' },
  fail: { ordinal: 1, category: 'Fail' },
  incorrect: { ordinal: 1, category: 'Fail' },
  incoherent: { ordinal: 1, category: 'Fail' },
  incomplete: { ordinal: 1, category: 'Fail' },
  inappropriate: { ordinal: 1, category: 'Fail' },
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

/** Lowest label ordinal that reads as a pass. */
const PASS_MIN_ORDINAL = 3;

export function ordinalToCategory(ordinal: number): LabelFilterCategory {
  if (ordinal >= PASS_MIN_ORDINAL) return 'Pass';
  if (ordinal === 2) return 'Review';
  return 'Fail';
}

type LabelTier = 'excellent' | 'pass' | 'review' | 'fail';
type LabelVocabulary = Record<LabelTier, string>;

/** Per-metric labels, every value a key of LABEL_ORDINAL_MAP so the derived label maps to its tier. */
const METRIC_LABEL_VOCABULARY: Record<string, LabelVocabulary> = {
  relevance: { excellent: 'highly_relevant', pass: 'relevant', review: 'partial', fail: 'irrelevant' },
  faithfulness: { excellent: 'fully_faithful', pass: 'faithful', review: 'partial', fail: 'unfaithful' },
  coherence: { excellent: 'coherent', pass: 'coherent', review: 'partial', fail: 'incoherent' },
};
const DEFAULT_LABEL_VOCABULARY: LabelVocabulary = { excellent: 'excellent', pass: 'pass', review: 'partial', fail: 'fail' };
const HALLUCINATED_LABEL = 'hallucinated';
const PASS_LABEL = 'pass';

const BAND_TIER: Record<ScoreColorBand, LabelTier> = {
  excellent: 'excellent',
  good: 'pass',
  adequate: 'review',
  poor: 'fail',
  failing: 'fail',
};

/**
 * The categorical label a score implies for a metric, for producers that score
 * without labelling and for rows that reached the dashboard without one. A
 * hallucination rate is a two-way verdict at HALLUCINATION_RISK_THRESHOLD, the
 * same cutoff isHallucinationIndicator applies; every other metric takes the
 * tier of its color band.
 */
export function scoreLabelForMetric(evaluationName: string, score: number): string {
  const name = evaluationName.toLowerCase();
  if (HALLUCINATION_RISK_EVALUATION_NAMES.has(name)) {
    return score >= HALLUCINATION_RISK_THRESHOLD ? HALLUCINATED_LABEL : PASS_LABEL;
  }
  const vocabulary = METRIC_LABEL_VOCABULARY[name] ?? DEFAULT_LABEL_VOCABULARY;
  return vocabulary[BAND_TIER[scoreColorBand(score)]];
}

/** The evaluation's own label, or the one its score implies; undefined only when it has neither. */
export function resolveScoreLabel(evaluation: ScoredEvaluation): string | undefined {
  if (evaluation.scoreLabel) return evaluation.scoreLabel;
  const score = evaluation.scoreValue;
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  return scoreLabelForMetric(evaluation.evaluationName, score);
}

/** The display-limit half of {@link RoleFeatureConfig} — the numeric fields only */
export type RoleDisplayLimits = Pick<
  RoleFeatureConfig,
  'explanationTruncation' | 'maxWorstEvaluations'
>;

/**
 * Per-role display limits — mirrors ROLE_DISPLAY_LIMITS in the parent's
 * `src/lib/quality/qfe-role-config.ts`, same shape and same values.
 *
 * This is a hand-maintained copy, not an import: the parent's runtime values
 * cannot reach frontend code (the `src/api/parent/*` barrels are Node-only, and
 * `@parent` resolves to `../dist`, which standalone CI builds without). Keeping
 * the same shape on both sides is what makes a sync a one-table diff.
 *
 * Was six loose constants until 2026-08-17 (parent QSD-6). Note the parent has
 * no OPERATOR_EXPLANATION_TRUNCATION to match: its operator truncation used to
 * come from TEXT_PREVIEW_LIMIT, which this file never mirrored — the asymmetry
 * QSD-6 removed existed only on the parent side.
 */
export const ROLE_DISPLAY_LIMITS = {
  /** Headline view: one worst evaluation, one line of explanation */
  executive: { explanationTruncation: 80, maxWorstEvaluations: 1 },
  /** Triage view */
  operator: { explanationTruncation: 500, maxWorstEvaluations: 5 },
  /** Evidence view: full judge rationale, deepest worst-list */
  auditor: { explanationTruncation: 2000, maxWorstEvaluations: 10 },
} as const satisfies Record<FeatureRoleType, RoleDisplayLimits>;

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
    ...ROLE_DISPLAY_LIMITS.executive,
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
    ...ROLE_DISPLAY_LIMITS.operator,
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
    ...ROLE_DISPLAY_LIMITS.auditor,
  },
};

const PATH_TAIL_SEGMENTS = 3;

export function shortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts.length > PATH_TAIL_SEGMENTS ? `\u2026/${parts.slice(-PATH_TAIL_SEGMENTS).join('/')}` : fullPath;
}

export function fmtDuration(ms: number, secDecimals = 1): string {
  return ms < TIME_MS.SECOND ? `${Math.round(ms)}ms` : `${(ms / TIME_MS.SECOND).toFixed(secDecimals)}s`;
}

const COMPACT_COUNT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: COMPACT_UNIT_PRECISION });

/** A count as `950`, `1.5K`, `2.3M`. */
export function formatCompactCount(n: number): string {
  return COMPACT_COUNT.format(n);
}

export type PercentileDistribution = {
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
const quantileBandOf = bandScale([QUANTILE_P25, QUANTILE_P50, QUANTILE_P75, QUANTILE_P90]);

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
  if (dist.p10 === dist.p25 || dist.p25 === dist.p50 || dist.p50 === dist.p75 || dist.p75 === dist.p90) {
    return QUANTILE_P50;
  }
  return scaleLinear()
    .domain([dist.p10, dist.p25, dist.p50, dist.p75, dist.p90])
    .range([QUANTILE_P10, QUANTILE_P25, QUANTILE_P50, QUANTILE_P75, QUANTILE_P90])
    .clamp(true)(value);
}

/** The org's observed distribution for a metric, with the sample it was drawn from. */
export type ScoreCalibration = {
  distribution: PercentileDistribution;
  sampleSize?: number;
}

export function adaptiveScoreColorBand(
  value: number,
  metric: string,
  direction: ScoreDirection = 'maximize',
  calibration?: ScoreCalibration,
): ScoreColorBand {
  const strategy = METRIC_SCALE_STRATEGY[metric] ?? 'uniform';
  switch (strategy) {
    case 'quantile': {
      if (!calibration || (calibration.sampleSize !== undefined && calibration.sampleSize < MIN_QUANTILE_SAMPLE_SIZE)) {
        return scoreColorBand(value, direction);
      }
      return quantileBandOf(empiricalCDF(value, calibration.distribution));
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
      if (!calibration) return scoreColorBand(value, direction);
      return scoreColorBand(empiricalCDF(value, calibration.distribution), 'maximize');
    }
    case 'uniform':
    default: return scoreColorBand(value, direction);
  }
}


import { format, differenceInMinutes, differenceInHours, differenceInDays } from 'date-fns';

export function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts || '-';
  const now = new Date();
  const diffMin = differenceInMinutes(now, d);
  if (diffMin < 1) return 'just now';
  if (diffMin < MINUTES_PER_HOUR) return `${diffMin}m ago`;
  const diffHr = differenceInHours(now, d);
  if (diffHr < HOURS_PER_DAY) return `${diffHr}h ago`;
  const diffDay = differenceInDays(now, d);
  if (diffDay < DAYS_PER_WEEK) return `${diffDay}d ago`;
  return format(d, 'PP');
}
