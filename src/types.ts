export type {
  QualityDashboardSummary,
  QualityMetricResult,
  QualityMetricConfig,
  TriggeredAlert,
  ConfidenceIndicator,
  WorstExplanation,
  SLAComplianceResult,
  AlertSeverity,
  TrendDirection,
} from '@parent/lib/quality/quality-metrics.js';
export type { MetricTrend } from '@parent/lib/quality/quality-constants.js';
export type {
  PipelineResult,
  PipelineStage,
  PipelineDropoff,
  CoverageHeatmap,
  CoverageCell,
  CoverageGap,
  CoverageStatus,
} from '@parent/lib/quality/quality-visualization.js';

// View types live in quality-views.js (not re-exported via quality-metrics.js;
// see quality-metrics.ts — the re-export formed a load-order TDZ cycle).
export type {
  MetricDetailResult,
  ExecutiveView,
  OperatorView,
  AuditorView,
  RoleView,
} from '@parent/lib/quality/quality-views.js';

export type { RoleType as RoleViewType } from '@parent/lib/quality/quality-constants.js';

export type { EvaluationResult, TraceSpan, LogRecord, StepScore } from '@parent/backends/index.js';
export type { MetricDynamics } from '@parent/lib/quality/qfe-dynamics.js';
export type { CompositeQualityIndex, CQIContribution } from '@parent/lib/quality/qfe-cqi.js';
export type { CorrelationFeature } from '@parent/lib/quality/qfe-correlation.js';
export type { HandoffEvaluation, TurnLevelResult, MultiAgentEvaluation } from '@parent/lib/quality/quality-multi-agent.js';
export type { HumanVerificationEvent } from '@parent/lib/audit/verification-events.js';
export type { SLAEvaluationResult } from '@parent/lib/quality/quality-sla.js';

export type Period = '24h' | '7d' | '30d';

export type OverallStatus = 'healthy' | 'warning' | 'critical' | 'no_data';

export interface LiveMetric {
  name: string;
  score: number;
  evaluatorType: string;
  timestamp: string;
}

export interface QualityLiveData {
  metrics: LiveMetric[];
  sessionCount: number;
  lastUpdated: string;
}
