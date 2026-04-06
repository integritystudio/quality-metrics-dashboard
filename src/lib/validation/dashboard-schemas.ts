/**
 * Zod schemas for dashboard script data validation.
 *
 * Provides runtime validation for:
 * - derive-evaluations.ts: TraceSpan, OTel evaluation records
 * - judge-evaluations.ts: Log entries, transcript turns, evaluation records
 * - sync-to-kv.ts: KV sync state files
 *
 * All schemas are strict and coercive where appropriate to handle
 * telemetry data from various sources.
 */

import { z } from 'zod';

/** Normalized score value: 0–1 inclusive (mirrors parent shared-schemas.ts) */
const normalizedScoreSchema = z.number().min(0).max(1);

// ---------- IDs ----------
// OTel traceId: 16 bytes => 32 hex chars
// OTel spanId:  8 bytes  => 16 hex chars
const hex = /^[0-9a-f]+$/i;

export const TraceIdSchema = z
  .string()
  .length(32)
  .regex(hex)
  .refine((v) => !/^0{32}$/i.test(v), "traceId cannot be all zeros");

export const SpanIdSchema = z
  .string()
  .length(16)
  .regex(hex)
  .refine((v) => !/^0{16}$/i.test(v), "spanId cannot be all zeros");

export const SpanKindSchema = z.enum([
  "SPAN_KIND_UNSPECIFIED",
  "SPAN_KIND_INTERNAL",
  "SPAN_KIND_SERVER",
  "SPAN_KIND_CLIENT",
  "SPAN_KIND_PRODUCER",
  "SPAN_KIND_CONSUMER",
]);

export const StatusCodeSchema = z.enum([
  "STATUS_CODE_UNSET",
  "STATUS_CODE_OK",
  "STATUS_CODE_ERROR",
]);

export const SpanNameSchema = z.string().min(1).max(256);

// ---------- Attributes ----------
// OTel attributes are primitive values or arrays of primitive values.
const PrimitiveAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);

export const AttributeValueSchema: z.ZodType =
  z.union([
    PrimitiveAttributeValueSchema,
    z.array(PrimitiveAttributeValueSchema),
  ]);

export const AttributesSchema = z.record(z.string(), AttributeValueSchema);
// ---------- Common nested pieces ----------
export const SpanEventSchema = z.object({
  name: z.string(),
  timeUnixNano: z.union([z.string(), z.bigint()]), // OTLP often uses uint64-ish values
  attributes: AttributesSchema.optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
});

export const SpanLinkSchema = z.object({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  traceState: z.string().optional(),
  attributes: AttributesSchema.optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
});

export const StatusSchema = z.object({
  code: StatusCodeSchema,
  message: z.string().optional(),
});

export const ResourceSchema = z.object({
  attributes: AttributesSchema.default({}),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
});

// ---------- Evaluators ----------
export const genAiEvaluatorSchema = z.enum([
  'llm-judge',
  'seed-hash',
  'telemetry-rule-engine',
]);
export type GenAiEvaluator = z.infer<typeof genAiEvaluatorSchema>;


/**
 * Classifies the mechanism that produced an evaluation record.
 * Distinct from GenAiEvaluator (which identifies the system).
 */
export const genAiEvaluatorTypeSchema = z.enum([
  'llm',
  'seed',
  'canary',
  'rule',
  'human',
  'trace-backfill',
]);
export type GenAiEvaluatorType = z.infer<typeof genAiEvaluatorTypeSchema>;

/**
 * Evaluation metric names used in LLM-as-Judge and rule-based evaluation pipelines.
 * Zod 4 enum with type-safe inference for all supported evaluation metrics.
 */
export const evaluationNameSchema = z.enum([
  'relevance',
  'coherence',
  'faithfulness',
  'hallucination',
  'tool_correctness',
  'tool_selection',
  'tool_arguments',
  'tool_integration',
]);
export type EvaluationName = z.infer<typeof evaluationNameSchema>;

/** Hallucination evaluation metric identifier */
export const HALLUCINATION_EVAL_NAME_SCHEMA = z.enum(['hallucination'] as const);
export type HallucinationEvalName = z.infer<typeof HALLUCINATION_EVAL_NAME_SCHEMA>;
export const HALLUCINATION_EVAL_NAME = HALLUCINATION_EVAL_NAME_SCHEMA.parse('hallucination');

/** LLM Judge evaluator identifier */
export const LLM_JUDGE_EVALUATOR_SCHEMA = z.enum(['llm-judge'] as const);
export type LlmJudgeEvaluator = z.infer<typeof LLM_JUDGE_EVALUATOR_SCHEMA>;
export const LLM_JUDGE_EVALUATOR = LLM_JUDGE_EVALUATOR_SCHEMA.parse('llm-judge');

/** LLM evaluator type classification */
export const LLM_EVALUATOR_TYPE_SCHEMA = z.enum(['llm'] as const);
export type LlmEvaluatorType = z.infer<typeof LLM_EVALUATOR_TYPE_SCHEMA>;
export const LLM_EVALUATOR_TYPE = LLM_EVALUATOR_TYPE_SCHEMA.parse('llm');

/**
 * High-resolution time tuple: [seconds, nanoseconds]
 */
export const hrtSchema = z.tuple([z.number(), z.number()]).describe('High-resolution time [seconds, nanoseconds]');

/**
 * OpenTelemetry TraceSpan with optional attributes.
 * Used in traces-*.jsonl files read by derive-evaluations.ts and judge-evaluations.ts.
 */
export const traceSpanSchema = z.object({
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
  name: SpanNameSchema,
  kind: SpanKindSchema,
  startTime: hrtSchema,
  endTime: hrtSchema.optional(),
  duration: hrtSchema,
  status: StatusCodeSchema.optional(),
  attributes: AttributesSchema,
  events: z.array(SpanEventSchema).optional(),
});

export type TraceSpan = z.infer<typeof traceSpanSchema>;

/**
* OTel log record with structured attributes.
 * Used by judge-evaluations.ts to discover transcript paths via token-metrics-extraction hook.
 */
export const otelLogEntrySchema = z.object({
  timestamp: z.string().optional(),
  severity: z.string().optional(),
  body: z.string().optional(),
  attributes: AttributesSchema.optional(),
  traceId: TraceIdSchema,
  spanId: SpanIdSchema,
});

export type OTelLogEntry = z.infer<typeof otelLogEntrySchema>;


/**
 * Single turn in a conversation transcript (user message, assistant response, etc).
 * Used by judge-evaluations.ts when parsing session transcript JSONL files.
 */
export const transcriptEntrySchema = z.object({
  type: z.enum(['user', 'assistant', 'progress', 'file-history-snapshot', 'system']),
  message: z.object({
    role: z.string().optional(),
    content: z.unknown().optional(),
    model: z.string().optional(),
    usage: z.object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().optional(),
    }).optional(),
  }).optional(),
  timestamp: z.string().optional(),
});

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;


/**
 * OTel evaluation record written by derive-evaluations.ts.
 * Schema: attributes object with gen_ai.evaluation.* fields plus traceId.
 * Used by both derive-evaluations.ts (preserving non-rule evals) and
 * judge-evaluations.ts (detecting LLM judge results).
 */
export const otelEvaluationRecordSchema = z.object({
  timestamp: z.string(),
  name: z.literal('gen_ai.evaluation.result'),
  attributes: z.object({
    'gen_ai.evaluation.name': z.string().optional(),
    'gen_ai.evaluation.score.value': z.number().optional(),
    'gen_ai.evaluation.score.unit': z.string().optional(),
    'gen_ai.evaluation.explanation': z.string().optional(),
    'gen_ai.evaluation.evaluator': genAiEvaluatorSchema,
    'gen_ai.evaluation.evaluator.type': genAiEvaluatorTypeSchema,
    'session.id': z.string().optional(),
  }).catchall(z.unknown()),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

export type OTelEvaluationRecord = z.infer<typeof otelEvaluationRecordSchema>;


/**
 * KV sync state file schema (.kv-sync-state.json).
 * Tracks hash and metadata for entries synced to Cloudflare KV.
 */
export const kvSyncEntrySchema = z.object({
  hash: z.string().describe('Content hash (SHA-256 hex)'),
});

export type KvSyncEntry = z.infer<typeof kvSyncEntrySchema>;

/**
 * KV sync state object (.kv-sync-state.json).
 * Maps entry keys to sync metadata.
 */
export const kvSyncStateSchema = z.record(z.string(), kvSyncEntrySchema);

export type KvSyncState = z.infer<typeof kvSyncStateSchema>;


/**
 * Dashboard metric detail value stored in Cloudflare KV.
 * Typically contains aggregated quality metrics or trend data.
 * Used by sync-to-kv.ts when reading back entries for coverage/debugging.
 */
export const kvEntryValueSchema = z.object({
  timestamp: z.string().optional(),
  value: z.number().optional(),
  count: z.number().optional(),
  unit: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type KvEntryValue = z.infer<typeof kvEntryValueSchema>;


/**
 * Coverage heatmap cell: code location → line coverage percentage.
 * Used in sync-to-kv.ts coverage-heatmap entries.
 */
export const coverageHeatmapCellSchema = z.object({
  line: z.number(),
  coverage: z.number().min(0).max(100),
  hitCount: z.number().optional(),
});

export const coverageHeatmapSchema = z.record(z.string(), z.array(coverageHeatmapCellSchema));

export type CoverageHeatmap = z.infer<typeof coverageHeatmapSchema>;


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
