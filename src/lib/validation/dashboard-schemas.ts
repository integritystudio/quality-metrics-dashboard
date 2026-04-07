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
export { TraceIdSchema, SpanIdSchema } from '@parent/lib/core/shared-schemas.js';

export {
  genAiEvaluatorSchema,
  genAiEvaluatorTypeSchema,
  HALLUCINATION_EVAL_NAME_SCHEMA,
  HALLUCINATION_EVAL_NAME,
  LLM_JUDGE_EVALUATOR_SCHEMA,
  LLM_JUDGE_EVALUATOR,
  LLM_EVALUATOR_TYPE_SCHEMA,
  LLM_EVALUATOR_TYPE,
  hrtSchema,
  traceSpanSchema,
  otelLogEntrySchema,
  transcriptEntrySchema,
  otelEvaluationRecordSchema,
  kvSyncEntrySchema,
  kvSyncStateSchema,
  metricDetailValueSchema,
  coverageHeatmapSchema,
} from '@parent/lib/validation/dashboard-schemas.js';

export type {
  GenAiEvaluator,
  GenAiEvaluatorType,
  HallucinationEvalName,
  LlmJudgeEvaluator,
  LlmEvaluatorType,
  TraceSpan,
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
  fallbackRate: z.number().min(0).max(1),
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
  fallbackRate: z.number().min(0).max(1),
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
