export type {
  QualityDashboardSummary,
  QualityMetricResult,
  QualityMetricConfig,
  TriggeredAlert,
  MetricTrend,
  ConfidenceIndicator,
  WorstExplanation,
  SLAComplianceResult,
  AlertSeverity,
  TrendDirection,
  PipelineResult,
  PipelineStage,
  PipelineDropoff,
  CoverageHeatmap,
  CoverageCell,
  CoverageGap,
  CoverageStatus,
} from '../../dist/lib/quality/quality-metrics.js';

// View types live in quality-views.js (not re-exported via quality-metrics.js;
// see quality-metrics.ts — the re-export formed a load-order TDZ cycle).
export type {
  MetricDetailResult,
  ExecutiveView,
  OperatorView,
  AuditorView,
  RoleView,
} from '../../dist/lib/quality/quality-views.js';

export type { RoleType as RoleViewType } from '../../dist/lib/quality/quality-constants.js';

export type { EvaluationResult, TraceSpan } from '../../dist/backends/index.js';
export type { CompositeQualityIndex, CQIContribution, MetricDynamics, CorrelationFeature } from '../../dist/lib/quality/quality-feature-engineering.js';
export type { HandoffEvaluation, TurnLevelResult, MultiAgentEvaluation } from '../../dist/lib/quality/quality-multi-agent.js';
export type { HumanVerificationEvent } from '../../dist/lib/audit/verification-events.js';
export type { SLAEvaluationResult } from '../../dist/lib/quality/quality-sla.js';

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
