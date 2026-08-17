/**
 * Zod schemas for dashboard script data validation.
 *
 * Re-exports shared schemas from the parent observability-toolkit package
 * via @parent so existing consumers keep stable imports. Only the
 * routing telemetry KV schema is defined locally.
 */

import { z } from 'zod';

// ---------- Shared schemas from parent ----------
// Re-export canonical schemas so existing consumers keep their imports stable.
// TraceIdSchema/SpanIdSchema live in shared-schemas; the rest in dashboard-schemas.
export { TraceIdSchema, SpanIdSchema, evaluatorTypeSchema, type EvaluatorType } from '@parent/lib/core/shared-schemas.js';

/** Normalized score value: 0–1 inclusive (mirrors parent shared-schemas.ts) */
const normalizedScoreSchema = z.number().min(0).max(1);

export {
  HALLUCINATION_EVAL_NAME_SCHEMA,
  HALLUCINATION_EVAL_NAME,
  LLM_EVALUATOR_TYPE_SCHEMA,
  LLM_EVALUATOR_TYPE,
  hrtSchema,
  localTraceSpanSchema,
  otelLogEntrySchema,
  transcriptEntrySchema,
  otelEvaluationRecordSchema,
  kvSyncEntrySchema,
  kvSyncStateSchema,
  metricDetailValueSchema,
  coverageHeatmapSchema,
} from '@parent/lib/validation/dashboard-schemas.js';

export type {
  HallucinationEvalName,
  LlmEvaluatorType,
  LocalTraceSpan,
  OTelLogEntry,
  TranscriptEntry,
  OTelEvaluationRecord,
  KvSyncEntry,
  KvSyncState,
  MetricDetailValue,
  CoverageHeatmap,
} from '@parent/lib/validation/dashboard-schemas.js';

// ---------- Dashboard-only schemas ----------

const routingTelemetrySummarySchema = z.object({
  routedSpans: z.int().min(0),
  fallbackRate: normalizedScoreSchema,
});

const routingTelemetryModelPairGroupSchema = z.object({
  pair: z.string(),
  requestedModel: z.string(),
  actualModel: z.string(),
  provider: z.string().nullable(),
  count: z.int().min(0),
});

const routingTelemetryStrategyGroupSchema = z.object({
  strategy: z.string(),
  count: z.int().min(0),
  fallbackCount: z.int().min(0),
  fallbackRate: normalizedScoreSchema,
});

const routingTelemetryGroupSchema = z.union([
  routingTelemetryStrategyGroupSchema,
  routingTelemetryModelPairGroupSchema,
]);

export const routingTelemetryKvSchema = z.object({
  period: z.string().optional(),
  totalSpansScanned: z.int().min(0).default(0),
  summary: routingTelemetrySummarySchema.default({ routedSpans: 0, fallbackRate: 0 }),
  modelDistribution: z.record(z.string(), z.int().min(0)).default({}),
  providerDistribution: z.record(z.string(), z.int().min(0)).default({}),
  costSavings: z.number().min(0).default(0),
  routingLatency: z.object({
    p50: z.number().min(0),
    p99: z.number().min(0),
    source: z.enum(['classification_time', 'span_duration']),
  }).optional(),
  groups: z.array(routingTelemetryGroupSchema).default([]),
});

export type RoutingTelemetryKvData = z.infer<typeof routingTelemetryKvSchema>;

// ---------- Calibration KV contract ----------

/**
 * Percentiles of one metric's score distribution.
 *
 * Deliberately NOT the parent's `percentileDistributionSchema`, which is built
 * on `normalizedScoreSchema` (0–1). Calibration is computed in
 * `derive-evaluations.ts` over every `evaluationName`'s raw `scoreValue`, and
 * `scoreValueSchema` is `z.number().finite()` — unbounded. Bounding these to
 * 0–1 would reject a legitimate distribution for any unbounded metric and turn
 * a working route into a 500.
 */
const calibrationPercentilesSchema = z.object({
  p10: z.number().finite(),
  p25: z.number().finite(),
  p50: z.number().finite(),
  p75: z.number().finite(),
  p90: z.number().finite(),
});

/**
 * KV `meta:calibration` — the single contract for its whole pipeline.
 *
 * `buildCalibrationEntry` (scripts/sync-to-kv.ts) writes this payload, the
 * worker's `GET /api/calibration` parses it here and serves it verbatim, and
 * `useCalibration` consumes it. Every stage types against `CalibrationResponse`
 * below, so producer/consumer drift is a typecheck failure and a stale KV value
 * written by an older sync is a caught 500 rather than a frontend crash.
 *
 * Not `.strict()`: the sync script deploys independently of the worker, so a
 * newer producer must not 500 an older worker. Unknown keys are stripped, which
 * means a newly added field does not reach the frontend until the worker's
 * schema catches up — the safe direction of that tradeoff.
 *
 * `lastCalibrated` is an ISO string in practice but is validated only as
 * non-empty: it is displayed, never parsed, and a format check would 500 on
 * legacy state files for no gain.
 */
export const calibrationResponseSchema = z.object({
  distributions: z.record(z.string(), calibrationPercentilesSchema),
  sampleCounts: z.record(z.string(), z.int().min(0)),
  lastCalibrated: z.string().min(1),
});

export type CalibrationResponse = z.infer<typeof calibrationResponseSchema>;
