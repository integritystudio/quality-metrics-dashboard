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
 *    body as the pre-serialization type would claim `bigint` survives JSON.
 *
 * Type-only module: `src/types.ts` re-exports are erased at runtime, so this stays
 * safe when the parent `dist/` is stubbed in standalone CI.
 */

import type { JsonSafe } from '../../api/api-constants.js';
import type { EvaluationRow } from '../../api/aggregates/evaluation-rows.js';
import type { TrendView } from '../../api/aggregates/trend.js';
import type { checkHealth } from '../../api/data-loader.js';
import type { WorkflowGraph } from '../../types/workflow-graph.js';
import type {
  CompositeQualityIndex,
  CoverageMatrix,
  EvaluationResult,
  HumanVerificationEvent,
  MetricDetailResult,
  MetricDynamics,
  MultiAgentEvaluation,
  QualityDashboardSummary,
  RoleView,
  SLAComplianceResult,
} from '../../types.js';

/** An evaluation as it appears on the wire (`timestamp` bigint → decimal string). */
export type WireEvaluation = JsonSafe<EvaluationResult>;

/** Every route funnels failures through `sanitizeErrorForResponse` into this shape. */
export type ErrorResponse = {
  error: string;
}

/** `GET /dashboard` and `GET /dashboard?role=…` both add these to their payload. */
type DashboardExtras = {
  /**
   * Present on the unscoped dashboard and the executive role view only.
   *
   * The whole `CompositeQualityIndex` object — `computeCQI` returns the object
   * and the route passes it through untouched. Not a bare number.
   */
  cqi?: JsonSafe<CompositeQualityIndex>;
  sparklines: Record<string, Array<number | null>>;
}

/** `GET /dashboard` — `{ ...dashboard, cqi, sparklines }`. */
export type DashboardResponse = JsonSafe<QualityDashboardSummary> & DashboardExtras;

/** `GET /dashboard?role=…` — `{ ...view, sparklines }` (plus `cqi` for executive). */
export type RoleViewResponse = JsonSafe<RoleView> & DashboardExtras;

/** `GET /health`. */
export type HealthResponse = Awaited<ReturnType<typeof checkHealth>>;

/** `GET /metrics/:name` — `{ ...detail, dynamics }`; `dynamics` is omitted for short periods. */
export type MetricDetailResponse = JsonSafe<MetricDetailResult> & {
  dynamics?: JsonSafe<MetricDynamics>;
};

export type MetricEvaluationRow = JsonSafe<EvaluationRow>;

/** `GET /metrics/:name/evaluations`. */
export type MetricEvaluationsResponse = {
  rows: MetricEvaluationRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** `GET /trends/:name`. */
export type TrendDetailResponse = JsonSafe<TrendView>;

/** A span as it appears on the wire: `bigint` nanos encoded to decimal strings. */
export type WireSpan = {
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
export type TraceDetailResponse = {
  traceId: string;
  spans: WireSpan[];
  evaluations: WireEvaluation[];
}

/** `GET /agents/:sessionId`. */
export type AgentDetailResponse = {
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
export type TraceEvaluationsResponse = {
  evaluations: WireEvaluation[];
}

/** `GET /compliance/sla`. */
export type SlaComplianceResponse = {
  period: string;
  results: Array<JsonSafe<SLAComplianceResult>>;
  noSLAsConfigured: boolean;
}

/** `GET /compliance/verifications`. */
export type VerificationsResponse = {
  period: string;
  count: number;
  verifications: Array<JsonSafe<HumanVerificationEvent>>;
}

/** `GET /coverage` — `{ period, ...heatmap }`. */
export type CoverageResponse = JsonSafe<CoverageMatrix> & { period: string };

/*
 * `GET /api/calibration` (worker route, served from KV) — `CalibrationResponse`
 * in `src/lib/validation/dashboard-schemas.ts`. Deliberately not re-exported here: the worker
 * serves the `meta:calibration` value byte-for-byte, so the producer and the
 * route share one declaration, and a second import path for it is exactly the
 * drift this file's rules exist to prevent. Import it from there.
 */
