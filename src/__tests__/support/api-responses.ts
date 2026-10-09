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
  CorrelationFeature,
  CoverageMatrix,
  EvaluationResult,
  HumanVerificationEvent,
  MetricDetailResult,
  MetricDynamics,
  MetricTrend,
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
  /** True when `label` is the dashboard's derivation from the score, not the producer's. */
  labelDerived: boolean;
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

/** One `GET /trends/:name` bucket — mirrors the route's `trendData` entries. */
export interface TrendBucket {
  startTime: string;
  endTime: string;
  count: number;
  avg: number | null;
  percentiles: JsonSafe<PercentileDistribution> | null | undefined;
  trend: JsonSafe<MetricTrend> | null;
  dynamics: JsonSafe<MetricDynamics> | null;
}

/** `GET /trends/:name`. */
export interface TrendDetailResponse {
  metric: string;
  period: string;
  bucketCount: number;
  totalEvaluations: number;
  overallPercentiles: JsonSafe<PercentileDistribution> | null | undefined;
  trendData: TrendBucket[];
  narrowed: boolean;
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

/** `GET /agents/:sessionId/graph`. */
export type AgentGraphResponse = Pick<AgentDetailResponse, 'sessionId' | 'evaluation' | 'graph'>;

/*
 * `GET /sessions/:sessionId` — `SessionDetailResponse` in
 * `src/hooks/useSessionDetail.ts`, wrapped in `JsonSafe<…>`. Deliberately not
 * restated here: the hook is the consumer of that payload, so the route test
 * and the page test read it through one declaration, and a route field the
 * page cannot see is a typecheck failure rather than a second shape to keep
 * in step.
 */

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
export type CoverageResponse = JsonSafe<CoverageMatrix> & { period: string };

/** `GET /correlations`. */
export interface CorrelationsResponse {
  correlations: CorrelationFeature[];
  metrics: string[];
}

/*
 * `GET /api/calibration` (worker route, served from KV) — `CalibrationResponse`
 * in `src/lib/kv-contracts.ts`. Deliberately not re-exported here: the worker
 * serves the `meta:calibration` value byte-for-byte, so the producer and the
 * route share one declaration, and a second import path for it is exactly the
 * drift this file's rules exist to prevent. Import it from `kv-contracts`.
 */
