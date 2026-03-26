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

// Trace and Span Data

/**
 * High-resolution time tuple: [seconds, nanoseconds]
 */
export const hrtSchema = z.tuple([z.number(), z.number()]).describe('High-resolution time [seconds, nanoseconds]');

/**
 * OpenTelemetry TraceSpan with optional attributes.
 * Used in traces-*.jsonl files read by derive-evaluations.ts and judge-evaluations.ts.
 */
export const traceSpanSchema = z.object({
  traceId: z.string().min(1).describe('OTel trace ID'),
  spanId: z.string().min(1).describe('OTel span ID'),
  name: z.string().describe('Span operation name'),
  startTime: hrtSchema,
  endTime: hrtSchema.optional(),
  duration: hrtSchema.optional(),
  status: z.object({
    code: z.number(),
    message: z.string().optional(),
  }).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.number().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
});

export type TraceSpan = z.infer<typeof traceSpanSchema>;

// Log Entry Data (from telemetry logs)

/**
 * OTel log record with structured attributes.
 * Used by judge-evaluations.ts to discover transcript paths via token-metrics-extraction hook.
 */
export const otelLogEntrySchema = z.object({
  timestamp: z.string().optional(),
  severity: z.string().optional(),
  body: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

export type OTelLogEntry = z.infer<typeof otelLogEntrySchema>;

// Transcript and Turn Data

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

// Evaluation Record Data (OTel format)

/**
 * OTel evaluation record written by derive-evaluations.ts.
 * Schema: attributes object with gen_ai.evaluation.* fields plus traceId.
 * Used by both derive-evaluations.ts (preserving non-rule evals) and
 * judge-evaluations.ts (detecting LLM judge results).
 */
export const otelEvaluationRecordSchema = z.object({
  timestamp: z.string(),
  name: z.string().optional(),
  attributes: z.object({
    'gen_ai.evaluation.name': z.string().optional(),
    'gen_ai.evaluation.score.value': z.number().optional(),
    'gen_ai.evaluation.score.unit': z.string().optional(),
    'gen_ai.evaluation.explanation': z.string().optional(),
    'gen_ai.evaluation.evaluator': z.string().optional(),
    'gen_ai.evaluation.evaluator.type': z.enum(['rule', 'llm', 'human', 'seed', 'trace-backfill']).optional(),
    'session.id': z.string().optional(),
  }).strict().catchall(z.unknown()),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

export type OTelEvaluationRecord = z.infer<typeof otelEvaluationRecordSchema>;

// KV Sync State (sync-to-kv.ts)

/**
 * KV sync state file schema (.kv-sync-state.json).
 * Tracks hash and metadata for entries synced to Cloudflare KV.
 */
export const kvSyncEntrySchema = z.object({
  hash: z.string().describe('Content hash (SHA-256 hex)'),
  syncedAt: z.string().optional().describe('ISO timestamp of last sync'),
  size: z.number().optional().describe('Size in bytes'),
});

export type KvSyncEntry = z.infer<typeof kvSyncEntrySchema>;

/**
 * KV sync state object (.kv-sync-state.json).
 * Maps entry keys to sync metadata.
 */
export const kvSyncStateSchema = z.record(z.string(), kvSyncEntrySchema);

export type KvSyncState = z.infer<typeof kvSyncStateSchema>;

// KV Entry Value (what's stored in KV namespace)

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

// Coverage Heatmap Data (dashboard visualization)

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

// Routing Telemetry KV Data

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
