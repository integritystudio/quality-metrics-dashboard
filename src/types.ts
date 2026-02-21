export type {
  QualityDashboardSummary,
  QualityMetricResult,
  QualityMetricConfig,
  MetricDetailResult,
  TriggeredAlert,
  MetricTrend,
  ConfidenceIndicator,
  WorstExplanation,
  SLAComplianceResult,
  ExecutiveView,
  OperatorView,
  AuditorView,
  RoleView,
  RoleViewType,
  AlertSeverity,
  TrendDirection,
  PipelineResult,
  PipelineStage,
  PipelineDropoff,
  CoverageHeatmap,
  CoverageCell,
  CoverageGap,
  CoverageStatus,
} from '../../dist/lib/quality-metrics.js';

export type { EvaluationResult, TraceSpan } from '../../dist/backends/index.js';
export type { CompositeQualityIndex, CQIContribution, MetricDynamics, CorrelationFeature } from '../../dist/lib/quality-feature-engineering.js';
export type { HandoffEvaluation, TurnLevelResult, MultiAgentEvaluation } from '../../dist/lib/quality-multi-agent.js';
export type { HumanVerificationEvent } from '../../dist/lib/verification-events.js';
export type { SLAEvaluationResult } from '../../dist/lib/quality-sla.js';

export type Period = '24h' | '7d' | '30d';

export type OverallStatus = 'healthy' | 'warning' | 'critical' | 'no_data';
