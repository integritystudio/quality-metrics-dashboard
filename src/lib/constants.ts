import { z } from 'zod';

/** HTTP status codes used in API error responses. */
export const enum HttpStatus {
  BadRequest = 400,
  NotFound = 404,
  InternalServerError = 500,
}

/** Reusable error messages for API and response validation. */
export const enum ErrorMessage {
  InvalidResponseShape = 'Invalid response shape',
  MissingPeriodOrAgents = 'Invalid response: missing period or agents',
  InvalidPeriod = 'Invalid period. Must be 24h, 7d, or 30d.',
  InvalidRole = 'Invalid role. Must be executive, operator, or auditor.',
  InvalidMetricNameFormat = 'Invalid metric name format',
  InvalidTopN = 'Invalid topN parameter. Must be integer 1-50.',
  InvalidBucketCount = 'Invalid bucketCount parameter. Must be integer 2-20.',
  InvalidLimit = 'Invalid limit. Must be integer 1-200.',
  InvalidOffset = 'Invalid offset. Must be non-negative integer.',
  InvalidSortBy = 'Invalid sortBy. Must be score_asc, score_desc, or timestamp_desc.',
  InvalidScoreLabel = 'Invalid scoreLabel. Max 100 characters.',
  InvalidBuckets = 'Invalid buckets. Must be integer 3-30.',
}
/** Base URL for API requests. Uses VITE_API_URL env var, falls back to localhost:3001 in dev. */
export const API_BASE = import.meta.env?.VITE_API_URL ?? (import.meta.env?.DEV ? 'http://127.0.0.1:3001' : '');


/** Zod schema for coverage input key param. Single source for type, values, and default. */
export const InputKeySchema = z.enum(['traceId', 'sessionId']).default('traceId');
export type InputKey = z.infer<typeof InputKeySchema>;
export const DEFAULT_INPUT_KEY: InputKey = 'traceId';
/** Zod schema for evaluation sort order param. */
export const SortBySchema = z.enum(['score_asc', 'score_desc', 'timestamp_desc']).default('timestamp_desc');
export type SortBy = z.infer<typeof SortBySchema>;
export const DEFAULT_SORT_BY: SortBy = 'timestamp_desc';
/** Zod schema for role param. */
export const RoleSchema = z.enum(['executive', 'operator', 'auditor']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;
export const DEFAULT_ROLE: Role = 'executive';
/** Recognized agent source type values. */
export const KNOWN_SOURCE_TYPES = new Set(['active', 'lazy', 'builtin', 'skill', 'settings', 'unknown']);

export const TIME_MS = {
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;
/** Period string → day count for API route validation. */
export const VALID_PERIODS: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30 };
/** Zod-compatible tuple of valid period keys, derived from VALID_PERIODS. */
export const PERIOD_KEYS = Object.keys(VALID_PERIODS) as [string, ...string[]];
/** Zod enum for period values, derived from VALID_PERIODS keys. */
export const PeriodEnum = z.enum(PERIOD_KEYS);
/** Default client-side period for list/evaluation queries. */
export const DEFAULT_PERIOD = PeriodEnum.parse('7d') as '7d';
/** Default client-side period for metric detail views (wider window). */
export const DEFAULT_PERIOD_DETAIL = PeriodEnum.parse('30d') as '30d';
/** Shared Zod schema for period query param validation (default: '7d'). */
export const PeriodSchema = PeriodEnum.default(DEFAULT_PERIOD);
/** Period string → milliseconds, derived from VALID_PERIODS. */
export const PERIOD_MS: Record<string, number> = Object.fromEntries(
  Object.entries(VALID_PERIODS).map(([k, days]) => [k, days * TIME_MS.DAY]),
);
/** Compute { start, end } ISO strings for a validated period key (e.g. '7d'). */
export function computePeriodDates(period: string): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getTime() - (PERIOD_MS[period] ?? PERIOD_MS['7d']));
  return { start: start.toISOString(), end: now.toISOString() };
}


/** Percentage of events sampled for T2 LLM evaluation. */
export const LLM_SAMPLE_RATE = 10;
/** Score band thresholds for quality indicator color coding. */
export const SCORE_THRESHOLD_GREEN = 0.8;
export const SCORE_THRESHOLD_YELLOW = 0.5;
/** Error rate fraction above which agent activity is flagged as critical. */
export const ERROR_RATE_WARNING_THRESHOLD = 0.1;
/** Score below which a hallucination evaluation is flagged. */
export const HALLUCINATION_SCORE_THRESHOLD = 0.4;
export const MAX_ERROR_ROWS = 10;
export const MAX_HALLUCINATION_ROWS = 8;
export const MAX_FAILED_EVAL_ROWS = 6;
/** Rolling window for live quality endpoint (24 h). */
export const LIVE_WINDOW_MS = TIME_MS.DAY;
export const QUERY_RETRY_COUNT = 2;
export const POLL_INTERVAL_MS = 30_000;
/** Exponential backoff base and cap for retry delays (ms). */
export const RETRY_DELAY_BASE = 1_000;
export const RETRY_DELAY_CAP = 30_000;
export const MAX_IDS = 50;
export const EVAL_LIMIT = 100;
/** Decimal places for displayed score values in API responses. */
export const SCORE_DISPLAY_PRECISION = 3;
/** Decimal places for compact score display in chips and table cells. */
export const SCORE_CHIP_PRECISION = 2;
/** Decimal places for formatted raw score values in formatScore. */
export const SCORE_FORMAT_PRECISION = 4;

/** OpenTelemetry span status code for errors. */
export const OTEL_STATUS_ERROR_CODE = 2;

/** React Query staleTime tiers (ms). */
export const STALE_TIME = {
  /** Standard data queries (metrics, trends, coverage, compliance, pipeline, evaluations). */
  DEFAULT: 25_000,
  /** Entity detail views (session, trace, agent session). */
  DETAIL: 30_000,
  /** Slow-changing aggregate stats (agent stats). */
  AGGREGATE: 60_000,
} as const;
export const DEFAULT_TOP_N = 5;
export const DEFAULT_BUCKET_COUNT = 10;

export const SKELETON_HEIGHT_SM = 200;
export const SKELETON_HEIGHT_MD = 300;
export const SKELETON_HEIGHT_LG = 400;
export const CODE_QUALITY_WARN_THRESHOLD = 0.6;
export const DEFAULT_PAGE_LIMIT = 50;

export const HEATMAP_ROW_HEADER_WIDTH = 80;
export const HEATMAP_COL_HEADER_HEIGHT = 32;
export const COVERAGE_GRID_HEADER_WIDTH = 120;
export const COVERAGE_GRID_CELL_SIZE = 28;
export const COVERAGE_GRID_MAX_INPUTS = 30;
/** PipelineFunnel dropoff warning threshold (%). */
export const FUNNEL_DROPOFF_WARN_PCT = 20;
export const SPAN_TREE_INDENT = 20;
export const SPAN_TREE_BASE_PADDING = 8;
export const SPARKLINE_WIDTH = 160;
export const SPARKLINE_HEIGHT = 28;

/** ConfidencePanel: minimum sample size for "sample size" confidence method. */
export const CONFIDENCE_MIN_SAMPLE_SIZE = 50;
export const VARIANCE_LOW_PCT = 20;
export const VARIANCE_MEDIUM_PCT = 50;

export const CHART_HEIGHT = 200;
export const CHART_STROKE_WIDTH = 2;
export const CHART_DOT_RADIUS = 4;
export const CHART_DOT_RADIUS_ACTIVE = 6;
export const CHART_DOT_RADIUS_PROJECTED = 3;
export const CHART_DASH_THRESHOLD = '6 3';
export const CHART_DASH_PROJECTED = '6 4';
export const EVAL_TABLE_EXPAND_COL_SIZE = 32;
export const CHART_COLORS = {
  line: '#58a6ff',
  grid: '#30363d',
  text: '#8b949e',
  surface: '#1f2937',
  tooltip: '#161b22',
  warning: '#d29922',
  critical: '#f85149',
} as const;
export const AGENT_PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
] as const;

export const CHART_MARGIN = { top: 8, right: 16, bottom: 4, left: 16 };
export const CHART_GRID_PROPS = { stroke: CHART_COLORS.grid, strokeDasharray: '3 3' };
export const CHART_AXIS_TICK = { fill: CHART_COLORS.text, fontSize: 12 };
export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: CHART_COLORS.tooltip,
  border: `1px solid ${CHART_COLORS.grid}`,
  borderRadius: 'var(--radius)',
  color: CHART_COLORS.text,
  fontSize: 12,
};
export const CHART_TOOLTIP_LABEL_STYLE = { color: '#e6edf3' };
export const CHART_YAXIS_WIDTH = 48;
export const CHART_YAXIS_TICK_FORMATTER = (v: number): string => v.toFixed(2);
