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
} from '../../dist/lib/quality-metrics.js';

export type { EvaluationResult } from '../../dist/backends/index.js';

export type Period = '24h' | '7d' | '30d';

export type OverallStatus = 'healthy' | 'warning' | 'critical' | 'no_data';
