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

/** Epoch milliseconds to the epoch-nanosecond bigint the cloud backend queries take. */
export function msToNs(ms: number): bigint {
  return BigInt(ms) * BigInt(NANOS_TO_MS);
}

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

/** A hook span's name is this prefix plus its `integritystudio.hook.name`. */
export const HOOK_SPAN_PREFIX = 'hook:';

export const HOOK_NAME = {
  SESSION_START: 'session-start',
  TOKEN_METRICS: 'token-metrics-extraction',
  /**
   * PreToolUse and PostToolUse on the Agent tool. Named `agent-pre-tool` and
   * `agent-post-tool` until the hooks renamed them on 2026-08-13 (~/.claude
   * ba8f3ce4), after which every reader of the old names found nothing
   * (AGENT-POST-TOOL-READERS-DEAD). Only the new names are read: the old ones
   * fall outside every period-scoped reader's 30-day window.
   */
  AGENT_PREPARE: 'agent.operation.prepare',
  AGENT_FINALIZE: 'agent.operation.finalize',
  /** SubagentStop; carries the subagent's own transcript path. */
  SUBAGENT_STOP: 'subagent-stop',
  /** PostToolUse on a built-in tool and on an MCP tool. */
  BUILTIN_POST_TOOL: 'builtin-post-tool',
  MCP_POST_TOOL: 'mcp-post-tool',
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

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_START_SUFFIX = 'T00:00:00.000Z';
const DAY_END_SUFFIX = 'T23:59:59.999Z';

/**
 * Widen a date bound to the full ISO datetime `queryTraces` actually requires.
 *
 * Its `startDate`/`endDate` are typed `string | bigint`, but the string arm is
 * validated as an ISO *datetime* — so a date-only 'YYYY-MM-DD' type-checks and
 * then fails Zod at request time. A date-only value names a whole UTC day, so
 * the start bound opens it and the end bound closes it; values that already
 * carry a time are returned unchanged.
 */
export function toIsoWindowBound(value: string, bound: 'start' | 'end'): string {
  if (!DATE_ONLY_RE.test(value)) return value;
  return `${value}${bound === 'start' ? DAY_START_SUFFIX : DAY_END_SUFFIX}`;
}

/**
 * An optional `startDate`/`endDate` query param: a date-only 'YYYY-MM-DD' (widened
 * by {@link toIsoWindowBound}) or the ISO datetime the parent's query tools accept.
 * Anything else used to reach `BigInt(NaN)` in the loaders and answer 500.
 */
export const DateBoundParamSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional();

export type SpanLike = { attributes?: Record<string, unknown> };

export function attrStr(span: SpanLike, key: string, fallback = 'unknown'): string {
  const v = span.attributes?.[key];
  return typeof v === 'string' ? v : fallback;
}

export function attrNum(span: SpanLike, key: string, fallback = 0): number {
  const v = span.attributes?.[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
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
  if (type === 'number' && typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n as SpanAttrValue<K>;
  }
  return undefined;
}

/**
 * An attribute of `type` under its canonical key, else under the key it had
 * before a rename. Cloud reads resolve a legacy key through the alias table only
 * once it has a row, raw reads never do, so readers of renamed keys ask for both.
 * A canonical value of the wrong type falls through to the legacy key.
 */
export function renamedAttr(span: SpanLike, canonical: string, legacy: string): string | undefined;
export function renamedAttr<K extends SpanAttrType>(span: SpanLike, canonical: string, legacy: string, type: K): SpanAttrValue<K> | undefined;
export function renamedAttr(span: SpanLike, canonical: string, legacy: string, type: SpanAttrType = 'string'): SpanAttrValue<SpanAttrType> | undefined {
  return spanAttr(span, canonical, type) ?? spanAttr(span, legacy, type);
}

/**
 * `owner/repo` for display. Since 2026-09-29 the hooks emit the owner as
 * `vcs.owner.name` and the repository alone as `vcs.repository.name`, as semconv
 * requires; earlier spans carry `owner/repo` in `vcs.repository.name`.
 */
export function gitRepositoryLabel(span: SpanLike): string {
  const name = spanAttr(span, 'vcs.repository.name', 'string') ?? '';
  // Already `owner/repo` (an earlier span, or another producer): never prefix the owner twice.
  if (name.includes('/')) return name;
  return [spanAttr(span, 'vcs.owner.name', 'string'), name].filter(Boolean).join('/');
}

export function extractFiniteScores(evals: Array<{ scoreValue?: number | null }>): number[] {
  return evals
    .filter(e => e.scoreValue != null && Number.isFinite(e.scoreValue))
    .map(e => e.scoreValue as number);
}

/** `evaluatorType` value for rule-based (non-LLM) evaluators. Shared by the
 * coverage filter (`src/api/aggregates/coverage.ts`) and the evaluation record
 * writer (`scripts/eval-record.ts`). */
export const RULE_EVALUATOR_TYPE = 'rule';

/**
 * Canary evaluations carry synthetic scores. Records written before OBP16 mark
 * one in the overloaded `evaluatorType`; records after it use `cohort`.
 */
export const CANARY_EVALUATOR_TYPE = 'canary';
export const CANARY_COHORT = 'canary';
