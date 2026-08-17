import type { LogRecord } from '../types.js';
import { z } from 'zod';

export const PERCENT_BASE = 100;

/** Schema version embedded in every KV payload envelope. Increment when the payload shape changes. */
export const KV_SCHEMA_VERSION = 1;

export const LATENCY_P50 = 50;
export const LATENCY_P95 = 95;

export const LATENCY_DISPLAY_PRECISION = 1;

export const RATE_DISPLAY_PRECISION = 4;

/** OpenTelemetry status code representing an error.
 * Intentionally duplicated in lib/constants.ts — api-constants.ts serves the Node API server
 * which cannot import lib/constants.ts (Vite-specific import.meta.env). */
export const OTEL_STATUS_ERROR_CODE = 2;

export const FILE_ACCESS_TOP_N = 30;

/** Fraction of the query period below which data is considered concentrated and the time axis is auto-narrowed. */
export const CONCENTRATION_THRESHOLD = 0.2;

export const COMMIT_SUBJECT_FALLBACK_MAX_CHARS = 80;

/** Number of leading commit message lines to skip before body extraction. */
export const COMMIT_BODY_START_LINE_INDEX = 2;

export const MAX_TRACE_ID_LEN = 128;

/** Format validation for path parameters (session IDs, trace IDs). Min 2 chars; IDs in practice are much longer. */
export const PARAM_ID_RE = /^[\w.:-]{2,128}$/;
/** Format validation for metric name path parameters. Aliased to PARAM_ID_RE since both allow identical character sets. */
export const PARAM_METRIC_NAME_RE = PARAM_ID_RE;

/** Multiply/divide factor for rounding scores to 4 decimal places. */
export const SCORE_ROUND_FACTOR = 10_000;

export const LOG_SUMMARY_MAX_ENTRIES = 200;

/** Schema for safe fields exposed per log entry in logSummary (strips attributes/extractedFields/body). */
export const logSummaryFieldSchema = z.enum(['timestamp', 'severity', 'traceId']);

export type LogSummaryField = z.infer<typeof logSummaryFieldSchema>;

export type SafeLogEntry = Partial<Pick<LogRecord, LogSummaryField>>;

/** Divisor to convert nanosecond timestamps (OTel UnixNano) to milliseconds. */
export const NANOS_TO_MS = 1_000_000;

const NS_THRESHOLD = 1e15;
const NS_PER_MS_BIG = 1_000_000n;

/**
 * Normalize a timestamp to milliseconds. Accepts bigint nanoseconds (OTel UnixNano),
 * numeric ns/ms (auto-detected via magnitude), or ISO 8601 strings.
 * Returns NaN for unparseable inputs.
 */
export function timestampToMs(ts: string | number | bigint | null | undefined): number {
  if (ts == null) return NaN;
  if (typeof ts === 'bigint') return Number(ts / NS_PER_MS_BIG);
  if (typeof ts === 'number') return ts >= NS_THRESHOLD ? ts / NANOS_TO_MS : ts;
  const asNum = Number(ts);
  if (Number.isFinite(asNum) && asNum >= NS_THRESHOLD) return asNum / NANOS_TO_MS;
  return new Date(ts).getTime();
}

/** Structural result of {@link jsonSafe}: every `bigint` becomes a decimal `string`. */
export type JsonSafe<T> =
  T extends bigint ? string
  : T extends (infer U)[] ? JsonSafe<U>[]
  : T extends Date ? T
  : T extends object ? { [K in keyof T]: JsonSafe<T[K]> }
  : T;

/** Plain objects are walked; class instances (Date, Map, …) are passed through untouched. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function convert(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(convert);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
  }
  return value;
}

/**
 * Recursively replace `bigint` with its decimal-string form so a response body
 * survives `JSON.stringify`.
 *
 * The backends decode OTLP `fixed64` timestamps to `bigint` — spans via the
 * parent `numericNanosToEpochNanos` codec (`startTimeUnixNano`,
 * `endTimeUnixNano`) and evaluations via `isoDatetimeToEpochNanos`
 * (`timestamp`), with `CloudBackend` building both with `BigInt(...)` directly.
 * `JSON.stringify` throws outright on `bigint`, so **any** route returning that
 * data unconverted 500s on real input — including routes that only embed it
 * indirectly, such as `/metrics/:name` spreading `computeMetricDetail`'s
 * `evaluations` and `worstEvaluations`.
 *
 * A decimal string is the on-the-wire OTLP-JSON representation these values were
 * decoded from, and `timestampToMs` already accepts it, so this restores the
 * wire shape rather than inventing one. Applied at the response boundary rather
 * than per field: the bigint-bearing types are nested at varying depth, and a
 * field-by-field helper silently misses each new one.
 */
export function jsonSafe<T>(value: T): JsonSafe<T> {
  return convert(value) as JsonSafe<T>;
}

export function incrementCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export const HOOK_NAME = {
  SESSION_START: 'session-start',
  TOKEN_METRICS: 'token-metrics-extraction',
  AGENT_POST_TOOL: 'agent-post-tool',
  POST_COMMIT_REVIEW: 'post-commit-review',
  ALERT_EVALUATION: 'telemetry-alert-evaluation',
  CODE_STRUCTURE: 'code-structure',
} as const;

export function isValidParam(value: string | undefined, re: RegExp): boolean {
  return !!value && re.test(value);
}

export function toDateOnly(d: Date): string;
export function toDateOnly(d: string): string;
export function toDateOnly(d: Date | string): string {
  return (typeof d === 'string' ? d : d.toISOString()).split('T')[0] ?? '';
}

export type SpanLike = { attributes?: Record<string, unknown> };

export function attrStr(span: SpanLike, key: string, fallback = 'unknown'): string {
  const v = span.attributes?.[key];
  return typeof v === 'string' ? v : fallback;
}

export function attrNum(span: SpanLike, key: string, fallback = 0): number {
  const v = span.attributes?.[key];
  return typeof v === 'number' ? v : fallback;
}

export type SpanAttrType = 'string' | 'number' | 'boolean';

type SpanAttrValue<K extends SpanAttrType> =
  K extends 'string' ? string :
  K extends 'number' ? number :
  K extends 'boolean' ? boolean :
  never;

/**
 * Extracts and validates a span attribute by primitive type.
 * Returns `undefined` if the attribute is missing or fails the type check.
 * Prevents silent `unknown`-to-T casts by enforcing a runtime type guard.
 */
export function spanAttr<K extends SpanAttrType>(span: SpanLike, key: string, type: K): SpanAttrValue<K> | undefined {
  const v = span.attributes?.[key];
  if (typeof v === type) return v as SpanAttrValue<K>;
  return undefined;
}

export function extractFiniteScores(evals: Array<{ scoreValue?: number | null }>): number[] {
  return evals
    .filter(e => e.scoreValue != null && Number.isFinite(e.scoreValue))
    .map(e => e.scoreValue as number);
}
