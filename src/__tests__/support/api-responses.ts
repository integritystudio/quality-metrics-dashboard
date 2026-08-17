/**
 * Response shapes for the Hono API routes, for use in route tests.
 *
 * These mirror the `c.json(...)` payload of each route. Two rules keep them
 * honest rather than decorative:
 *
 * 1. Compose from the parent result types (`MetricDetailResult`,
 *    `QualityDashboardSummary`, …) instead of restating fields, so a parent type
 *    change surfaces as a typecheck failure here rather than passing under `as any`.
 * 2. Wrap anything carrying `bigint` in `JsonSafe<…>`. Routes pass their payload
 *    through `jsonSafe()`, which encodes `bigint` to a decimal string — typing the
 *    body as the pre-serialization type would claim `bigint` survives JSON, which
 *    is the exact assumption that hid the BigInt 500s.
 *
 * Type-only module: `src/types.ts` re-exports are erased at runtime, so this stays
 * safe when the parent `dist/` is stubbed in standalone CI.
 */

import type { JsonSafe } from '../../api/api-constants.js';
import type { WorkflowGraph } from '../../types/workflow-graph.js';
import type {
  CompositeQualityIndex,
  CoverageHeatmap,
  EvaluationResult,
  HumanVerificationEvent,
  MetricDetailResult,
  MetricDynamics,
  MultiAgentEvaluation,
  PercentileDistribution,
  QualityDashboardSummary,
  RoleView,
  SLAComplianceResult,
} from '../../types.js';

/** An evaluation as it appears on the wire (`timestamp` bigint → decimal string). */
export type WireEvaluation = JsonSafe<EvaluationResult>;

/** Every route funnels failures through `sanitizeErrorForResponse` into this shape. */
export interface ErrorResponse {
  error: string;
}

/** `GET /dashboard` and `GET /dashboard?role=…` both add these to their payload. */
interface DashboardExtras {
  /**
   * Present on the unscoped dashboard and the executive role view only.
   *
   * The whole `CompositeQualityIndex` object — `computeCQI` returns the object
   * and the route passes it through untouched. Not a bare number.
   */
  cqi?: JsonSafe<CompositeQualityIndex>;
  sparklines: Record<string, (number | null)[]>;
}

/** `GET /dashboard` — `{ ...dashboard, cqi, sparklines }`. */
export type DashboardResponse = JsonSafe<QualityDashboardSummary> & DashboardExtras;

/** `GET /dashboard?role=…` — `{ ...view, sparklines }` (plus `cqi` for executive). */
export type RoleViewResponse = JsonSafe<RoleView> & DashboardExtras;

/** `GET /health` — mirrors `checkHealth()` in data-loader. */
export interface HealthResponse {
  status: string;
  hasData: boolean;
}

/** `GET /quality/live` — `lastUpdated` is a decimal-nanos string or an ISO date. */
export interface QualityLiveResponse {
  metrics: { name: string; score: number; evaluatorType: string; timestamp: string }[];
  sessionCount: number;
  lastUpdated: string;
}

/** `GET /metrics/:name` — `{ ...detail, dynamics }`; `dynamics` is omitted for short periods. */
export type MetricDetailResponse = JsonSafe<MetricDetailResult> & {
  dynamics?: JsonSafe<MetricDynamics>;
};

/** One row of `GET /metrics/:name/evaluations`, projected from `EvaluationResult`. */
interface MetricEvaluationRowRaw {
  score: number;
  explanation: EvaluationResult['explanation'];
  traceId: EvaluationResult['traceId'];
  timestamp: EvaluationResult['timestamp'];
  evaluator: EvaluationResult['evaluator'];
  label: EvaluationResult['scoreLabel'];
  evaluatorType: EvaluationResult['evaluatorType'];
  spanId: EvaluationResult['spanId'];
  sessionId: EvaluationResult['sessionId'];
  agentName: EvaluationResult['agentName'];
  trajectoryLength: EvaluationResult['trajectoryLength'];
  stepScores: EvaluationResult['stepScores'];
  toolVerifications: EvaluationResult['toolVerifications'];
}

export type MetricEvaluationRow = JsonSafe<MetricEvaluationRowRaw>;

/** `GET /metrics/:name/evaluations`. */
export interface MetricEvaluationsResponse {
  rows: MetricEvaluationRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** `GET /trends/:name`. */
export interface TrendDetailResponse {
  metric: string;
  period: string;
  bucketCount: number;
  totalEvaluations: number;
  overallPercentiles: JsonSafe<PercentileDistribution> | null | undefined;
  trendData: unknown[];
  narrowed: boolean;
}

/** `GET /trends`. */
export interface TrendSummaryResponse {
  period: string;
  metrics: {
    metric: string;
    count: number;
    percentiles: JsonSafe<PercentileDistribution> | null;
  }[];
}

/** A span as it appears on the wire: `bigint` nanos encoded to decimal strings. */
export interface WireSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  durationMs?: number;
  status?: { code?: string | number; message?: string };
  attributes?: Record<string, unknown>;
}

/** `GET /traces/:traceId`. */
export interface TraceDetailResponse {
  traceId: string;
  spans: WireSpan[];
  evaluations: WireEvaluation[];
}

/** One entry of `GET /agents`. */
export interface AgentSummary {
  agentName: string;
  invocations: number;
  errors: number;
  errorRate: number;
  rateLimitCount: number;
  avgOutputSize: number;
  sessionCount: number;
  sessionIds: string[];
  sessionIdsTruncated: boolean;
  traceIdsTotal: number;
  traceIds: string[];
  traceIdsTruncated: boolean;
  sourceTypes: Record<string, number>;
  dailyCounts: Record<string, number>;
  evalSummary: Record<string, { avg: number; min: number; max: number; count: number }>;
}

/** `GET /agents`. */
export interface AgentListResponse {
  period: string;
  startDate: string;
  endDate: string;
  agents: AgentSummary[];
}

/** `GET /agents/:sessionId`. */
export interface AgentDetailResponse {
  sessionId: string;
  spans: WireSpan[];
  evaluation: JsonSafe<MultiAgentEvaluation> | null;
  evaluations: WireEvaluation[];
  agentMap: Record<string, string>;
  graph: JsonSafe<WorkflowGraph>;
}

/** `GET /sessions/:sessionId` — only the fields the route tests assert on are named. */
export interface SessionDetailResponse {
  sessionId: string;
  dataSources: { traces: unknown; logs: unknown; evaluations: unknown; total: number };
  timespan: unknown;
  sessionInfo: unknown;
  tokenTotals: unknown;
  tokenProgression: unknown;
  toolUsage: Record<string, number>;
  mcpUsage: Record<string, number>;
  spanBreakdown: Record<string, number>;
  hookLatency: unknown;
  errors: { byCategory: Record<string, number>; details: unknown[] };
  agentActivity: unknown;
  fileAccess: unknown;
  gitCommits: unknown;
  alertSummary: unknown;
  codeStructure: unknown;
  evaluationBreakdown: unknown;
  logSummary: {
    bySeverity: Record<string, number>;
    logs: Partial<Record<'timestamp' | 'severity' | 'traceId', unknown>>[];
  };
  multiAgentEvaluation: unknown;
  evaluations: WireEvaluation[];
}

/** `GET /evaluations/trace/:traceId`. */
export interface TraceEvaluationsResponse {
  evaluations: WireEvaluation[];
}

/** `GET /compliance/sla`. */
export interface SlaComplianceResponse {
  period: string;
  results: JsonSafe<SLAComplianceResult>[];
  noSLAsConfigured: boolean;
}

/** `GET /compliance/verifications`. */
export interface VerificationsResponse {
  period: string;
  count: number;
  verifications: JsonSafe<HumanVerificationEvent>[];
}

/** `GET /coverage` — `{ period, ...heatmap }`. */
export type CoverageResponse = JsonSafe<CoverageHeatmap> & { period: string };

/** `GET /correlations`. */
export interface CorrelationsResponse {
  correlations: unknown;
  metrics: string[];
}

/** `GET /api/calibration` (worker route, served from KV). */
export interface CalibrationResponse {
  distributions: Record<string, Record<string, number>>;
  sampleCounts?: Record<string, number>;
  lastCalibrated: string;
}
