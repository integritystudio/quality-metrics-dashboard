import { z } from 'zod';

/** Named error identifiers for custom error classes. */
export const enum ErrorName {
  SessionNotFound = 'SessionNotFoundError',
}

/** HTTP status codes used in API error responses. */
export const enum HttpStatus {
  BadRequest = 400,
  NotFound = 404,
  InternalServerError = 500,
}

/** Reusable error messages for response validation. */
export const enum ErrorMessage {
  InvalidResponseShape = 'Invalid response shape',
  MissingPeriodOrAgents = 'Invalid response: missing period or agents',
  InvalidPeriod = 'Invalid period. Must be 24h, 7d, or 30d.',
  InvalidRole = 'Invalid role. Must be executive, operator, or auditor.',
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

const TIME_MS = {
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


/** Percentage of events sampled for T2 LLM evaluation. */
export const LLM_SAMPLE_RATE = 10;
/** Score band thresholds for quality indicator color coding. */
export const SCORE_THRESHOLD_GREEN = 0.8;
export const SCORE_THRESHOLD_YELLOW = 0.5;
/** Error rate fraction above which agent activity is flagged as critical. */
export const ERROR_RATE_WARNING_THRESHOLD = 0.1;
/** Score below which a hallucination evaluation is flagged. */
export const HALLUCINATION_SCORE_THRESHOLD = 0.4;
/** Maximum rows shown in session detail tables. */
export const MAX_ERROR_ROWS = 10;
export const MAX_HALLUCINATION_ROWS = 8;
export const MAX_FAILED_EVAL_ROWS = 6;
/** Rolling window for live quality endpoint (24 h). */
export const LIVE_WINDOW_MS = TIME_MS.DAY;
/** Default React Query retry count for data fetching. */
export const QUERY_RETRY_COUNT = 2;
/** Polling / refetch interval for live and dashboard queries (ms). */
export const POLL_INTERVAL_MS = 30_000;
/** Exponential backoff base and cap for retry delays (ms). */
export const RETRY_DELAY_BASE = 1_000;
export const RETRY_DELAY_CAP = 30_000;
/** Max session/trace IDs returned per agent in stats response. */
export const MAX_IDS = 50;
/** Max evaluations returned by the live quality endpoint. */
export const EVAL_LIMIT = 100;
/** Decimal places for displayed score values. */
export const SCORE_DISPLAY_PRECISION = 3;

/** React Query staleTime tiers (ms). */
export const STALE_TIME = {
  /** Standard data queries (metrics, trends, coverage, compliance, pipeline, evaluations). */
  DEFAULT: 25_000,
  /** Entity detail views (session, trace, agent session). */
  DETAIL: 30_000,
  /** Slow-changing aggregate stats (agent stats). */
  AGGREGATE: 60_000,
} as const;
/** Default query params for metric detail endpoint. */
export const DEFAULT_TOP_N = 5;
export const DEFAULT_BUCKET_COUNT = 10;

/** Page UI values */
export const SKELETON_HEIGHT_SM = 200;
export const SKELETON_HEIGHT_MD = 300;
export const SKELETON_HEIGHT_LG = 400;
export const ICON_BADGE_SIZE = 24;
export const CALLOUT_MAX_WIDTH = 480;
export const PAGE_CONTENT_MAX_WIDTH = 1100;
export const CODE_QUALITY_WARN_THRESHOLD = 0.6;
export const AGENT_CARD_MIN_WIDTH = '220px';
export const FILE_ACCESS_COL_MIN = '320px';
export const DEFAULT_PAGE_LIMIT = 50;

// ─── Component layout constants ───────────────────────────────────────────────
/** CorrelationHeatmap row-header column width, column-header row height, and cell min-height (px). */
export const HEATMAP_ROW_HEADER_WIDTH = 80;
export const HEATMAP_COL_HEADER_HEIGHT = 32;
export const HEATMAP_CELL_MIN_HEIGHT = 36;
/** CoverageGrid layout dimensions (px) and max displayed input columns. */
export const COVERAGE_GRID_HEADER_WIDTH = 120;
export const COVERAGE_GRID_CELL_SIZE = 28;
export const COVERAGE_GRID_LEGEND_SIZE = 12;
export const COVERAGE_GRID_MAX_INPUTS = 30;
export const COVERAGE_GRID_HEADER_MAX_HEIGHT = 60;
/** PipelineFunnel stage bar height and minimum width (px), dropoff warning threshold (%). */
export const FUNNEL_BAR_HEIGHT = 32;
export const FUNNEL_BAR_MIN_WIDTH = 40;
export const FUNNEL_DROPOFF_WARN_PCT = 20;
/** SpanTree indentation per depth level and base left padding (px). */
export const SPAN_TREE_INDENT = 20;
export const SPAN_TREE_BASE_PADDING = 8;
/** SplitPane drag-handle width and minimum container height (px). */
export const SPLIT_PANE_DIVIDER_WIDTH = 6;
export const SPLIT_PANE_MIN_HEIGHT = 300;
/** TurnTimeline card minimum width (px). */
export const TURN_CARD_MIN_WIDTH = 120;
/** AgentActivityPanel table minimum width, bar minimum width, eval card minimum width (px). */
export const AGENT_TABLE_MIN_WIDTH = 640;
export const AGENT_BAR_MIN_WIDTH = 48;
export const AGENT_EVAL_CARD_MIN_WIDTH = 140;
/** Sparkline canvas dimensions (px). */
export const SPARKLINE_WIDTH = 160;
export const SPARKLINE_HEIGHT = 28;

// Component computed value consts
/** ConfidencePanel: minimum sample size for "sample size" confidence method. */
export const CONFIDENCE_MIN_SAMPLE_SIZE = 50;
/** ConfidencePanel VarianceBar: band thresholds (pct). */
export const VARIANCE_LOW_PCT = 20;
export const VARIANCE_MEDIUM_PCT = 50;
/** VarianceBar score display minimum width (px). */
export const VARIANCE_DISPLAY_MIN_WIDTH = 36;

// ─── Chart constants ──────────────────────────────────────────────────────────
/** TrendChart: responsive container height (px). */
export const CHART_HEIGHT = 200;
/** TrendChart: line stroke width (px). */
export const CHART_STROKE_WIDTH = 2;
/** TrendChart: dot radii for data, active, and projected points (px). */
export const CHART_DOT_RADIUS = 4;
export const CHART_DOT_RADIUS_ACTIVE = 6;
export const CHART_DOT_RADIUS_PROJECTED = 3;
/** TrendChart: SVG strokeDasharray for threshold reference lines and projected line. */
export const CHART_DASH_THRESHOLD = '6 3';
export const CHART_DASH_PROJECTED = '6 4';
// ─── Evaluation table constants ───────────────────────────────────────────────
/** EvaluationTable: expand/collapse column width (px). */
export const EVAL_TABLE_EXPAND_COL_SIZE = 32;
/** EvaluationTable: opacity for inactive category filter buttons. */
export const EVAL_FILTER_INACTIVE_OPACITY = 0.6;

// ─── Quality live indicator ───────────────────────────────────────────────────

/** Hex alpha suffix (10% opacity) appended to status colors for score badge backgrounds. */
export const SCORE_BADGE_ALPHA_HEX = '1a';

/** Shared Recharts color palette for TrendChart and TrendSeries. */
export const CHART_COLORS = {
  line: '#58a6ff',
  grid: '#30363d',
  text: '#8b949e',
  surface: '#1f2937',
  tooltip: '#161b22',
  warning: '#d29922',
  critical: '#f85149',
} as const;
/** Color palette for per-agent visual distinction. */
export const AGENT_PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
] as const;

/** Shared Recharts layout and style constants (TrendChart, TrendSeries). */
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
