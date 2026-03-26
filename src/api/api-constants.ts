/** Divisor to convert percentage values to rank indexes. */
export const PERCENT_BASE = 100;

/** Common latency percentiles used in session summaries. */
export const LATENCY_P50 = 50;
export const LATENCY_P95 = 95;

/** Decimal places for displaying latency/duration values. */
export const LATENCY_DISPLAY_PRECISION = 1;

/** Decimal places for rate values (error rate, truncation rate, etc.) */
export const RATE_DISPLAY_PRECISION = 4;

/** OpenTelemetry status code representing an error.
 * Intentionally duplicated in lib/constants.ts — api-constants.ts serves the Node API server
 * which cannot import lib/constants.ts (Vite-specific import.meta.env). */
export const OTEL_STATUS_ERROR_CODE = 2;

/** Maximum number of file-access entries returned in session detail. */
export const FILE_ACCESS_TOP_N = 30;

/** Fraction of the query period below which data is considered concentrated and the time axis is auto-narrowed. */
export const CONCENTRATION_THRESHOLD = 0.2;

/** Fallback max characters for commit subject preview. */
export const COMMIT_SUBJECT_FALLBACK_MAX_CHARS = 80;

/** Number of leading commit message lines to skip before body extraction. */
export const COMMIT_BODY_START_LINE_INDEX = 2;

/** Maximum trace/session ID length accepted by Zod schemas and path-param validation. */
export const MAX_TRACE_ID_LEN = 128;

/** Format validation for path parameters (session IDs, trace IDs). Min 2 chars; IDs in practice are much longer. */
export const PARAM_ID_RE = /^[\w.:-]{2,128}$/;
/** Format validation for metric name path parameters. Aliased to PARAM_ID_RE since both allow identical character sets. */
export const PARAM_METRIC_NAME_RE = PARAM_ID_RE;

/** Multiply/divide factor for rounding scores to 4 decimal places. */
export const SCORE_ROUND_FACTOR = 10_000;

/** Maximum number of log entries returned in logSummary.logs (most recent). */
export const LOG_SUMMARY_MAX_ENTRIES = 200;

/** Safe fields exposed per log entry in logSummary (strips attributes/extractedFields/body). */
export const LOG_SUMMARY_FIELDS = ['timestamp', 'severity', 'severityNumber', 'traceId', 'spanId'] as const;

/** Sanitized log entry shape derived from LOG_SUMMARY_FIELDS allowlist. */
export type SafeLogEntry = Partial<Pick<import('../../../dist/backends/index.js').LogRecord, typeof LOG_SUMMARY_FIELDS[number]>>;

/** Divisor to convert nanosecond timestamps (OTel UnixNano) to milliseconds. */
export const NANOS_TO_MS = 1_000_000;

/** Increment a numeric counter in a record, initializing to 1 on first use. */
export function incrementCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Hook name attribute values emitted by Claude Code hook handlers. */
export const HOOK_NAME = {
  SESSION_START: 'session-start',
  TOKEN_METRICS: 'token-metrics-extraction',
  AGENT_POST_TOOL: 'agent-post-tool',
  POST_COMMIT_REVIEW: 'post-commit-review',
  ALERT_EVALUATION: 'telemetry-alert-evaluation',
  CODE_STRUCTURE: 'code-structure',
} as const;

/** Returns true if a route path parameter is present and matches the given regex. */
export function isValidParam(value: string | undefined, re: RegExp): boolean {
  return !!value && re.test(value);
}

/** Convert a Date or ISO timestamp string to a YYYY-MM-DD date string. */
export function toDateOnly(d: Date): string;
export function toDateOnly(d: string): string;
export function toDateOnly(d: Date | string): string {
  return (typeof d === 'string' ? d : d.toISOString()).split('T')[0];
}

/** Span attribute accessor helpers — shared across API routes and scripts. */
export type SpanLike = { attributes?: Record<string, unknown> };

/** Extract a string span attribute with optional fallback. */
export function attrStr(span: SpanLike, key: string, fallback = 'unknown'): string {
  const v = span.attributes?.[key];
  return typeof v === 'string' ? v : fallback;
}

/** Extract a numeric span attribute with optional fallback. */
export function attrNum(span: SpanLike, key: string, fallback = 0): number {
  const v = span.attributes?.[key];
  return typeof v === 'number' ? v : fallback;
}

/** Extract a typed span attribute (no fallback). */
export function spanAttr<T>(span: SpanLike, key: string): T | undefined {
  return span.attributes?.[key] as T | undefined;
}

/** Extract finite numeric scores from an evaluation array, dropping null/undefined/NaN. */
export function extractFiniteScores(evals: Array<{ scoreValue?: number | null }>): number[] {
  return evals.reduce<number[]>((acc, e) => {
    if (e.scoreValue != null && Number.isFinite(e.scoreValue)) acc.push(e.scoreValue);
    return acc;
  }, []);
}
