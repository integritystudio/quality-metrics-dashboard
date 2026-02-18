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

export type FeatureRoleType = 'executive' | 'operator' | 'auditor';

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

export function getRoleFeatureConfig(role: FeatureRoleType): RoleFeatureConfig {
  return ROLE_FEATURE_CONFIG[role];
}
