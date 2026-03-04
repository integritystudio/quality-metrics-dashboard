/** Divisor to convert percentage values to rank indexes. */
export const PERCENT_BASE = 100;

/** Milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000;

/** Common latency percentiles used in session summaries. */
export const LATENCY_P50 = 50;
export const LATENCY_P95 = 95;

/** OpenTelemetry status code representing an error. */
export const OTEL_STATUS_ERROR_CODE = 2;

/** Maximum number of file-access entries returned in session detail. */
export const FILE_ACCESS_TOP_N = 30;

/** Fallback max characters for commit subject preview. */
export const COMMIT_SUBJECT_FALLBACK_MAX_CHARS = 80;

/** Number of leading commit message lines to skip before body extraction. */
export const COMMIT_BODY_START_LINE_INDEX = 2;
