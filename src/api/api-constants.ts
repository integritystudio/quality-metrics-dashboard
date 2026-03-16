/** Divisor to convert percentage values to rank indexes. */
export const PERCENT_BASE = 100;

/** Milliseconds in one hour. */
export const TIME_MS = {
  HOUR: 3_600_000,
} as const;

/** Common latency percentiles used in session summaries. */
export const LATENCY_P50 = 50;
export const LATENCY_P95 = 95;

/** OpenTelemetry status code representing an error. */
export const OTEL_STATUS_ERROR_CODE = 2;

/** Maximum number of file-access entries returned in session detail. */
export const FILE_ACCESS_TOP_N = 30;

/** Fraction of the query period below which data is considered concentrated and the time axis is auto-narrowed. */
export const CONCENTRATION_THRESHOLD = 0.2;

/** Fallback max characters for commit subject preview. */
export const COMMIT_SUBJECT_FALLBACK_MAX_CHARS = 80;

/** Number of leading commit message lines to skip before body extraction. */
export const COMMIT_BODY_START_LINE_INDEX = 2;

/** Format validation for path parameters (session IDs, trace IDs). Min 2 chars; IDs in practice are much longer. */
export const PARAM_ID_RE = /^[\w.:-]{2,128}$/;
/** Format validation for metric name path parameters. Aliased to PARAM_ID_RE since both allow identical character sets. */
export const PARAM_METRIC_NAME_RE = PARAM_ID_RE;

/** Maximum number of log entries returned in logSummary.logs (most recent). */
export const LOG_SUMMARY_MAX_ENTRIES = 200;

/** Safe fields exposed per log entry in logSummary (strips attributes/extractedFields/body). */
export const LOG_SUMMARY_FIELDS = ['timestamp', 'severity', 'severityNumber', 'traceId', 'spanId'] as const;

/** Sanitized log entry shape derived from LOG_SUMMARY_FIELDS allowlist. */
export type SafeLogEntry = Partial<Pick<import('../../../dist/backends/index.js').LogRecord, typeof LOG_SUMMARY_FIELDS[number]>>;
