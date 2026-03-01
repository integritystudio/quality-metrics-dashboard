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

/** Zod schema for coverage input key param. Single source for type, values, and default. */
export const InputKeySchema = z.enum(['traceId', 'sessionId']).default('traceId');
export type InputKey = z.infer<typeof InputKeySchema>;
export const DEFAULT_INPUT_KEY: InputKey = InputKeySchema._def.defaultValue();

/** Zod schema for evaluation sort order param. */
export const SortBySchema = z.enum(['score_asc', 'score_desc', 'timestamp_desc']).default('timestamp_desc');
export type SortBy = z.infer<typeof SortBySchema>;
export const DEFAULT_SORT_BY: SortBy = SortBySchema._def.defaultValue();

/** Zod schema for role param. */
export const RoleSchema = z.enum(['executive', 'operator', 'auditor']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;
export const DEFAULT_ROLE: Role = 'executive';

/** Base URL for API requests. Uses VITE_API_URL env var, falls back to localhost:3001 in dev. */
export const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

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

/** Decimal places for displayed score values. */
export const SCORE_DISPLAY_PRECISION = 3;

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Period string → milliseconds, derived from VALID_PERIODS. */
export const PERIOD_MS: Record<string, number> = Object.fromEntries(
  Object.entries(VALID_PERIODS).map(([k, days]) => [k, days * MS_PER_DAY]),
);

/** Max session/trace IDs returned per agent in stats response. */
export const MAX_IDS = 50;

/** Recognized agent source type values. */
export const KNOWN_SOURCE_TYPES = new Set(['active', 'lazy', 'builtin', 'skill', 'settings', 'unknown']);

/** Rolling window for live quality endpoint (24 h). */
export const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Max evaluations returned by the live quality endpoint. */
export const EVAL_LIMIT = 100;

/** React Query staleTime tiers (ms). */
export const STALE_TIME = {
  /** Standard data queries (metrics, trends, coverage, compliance, pipeline, evaluations). */
  DEFAULT: 25_000,
  /** Entity detail views (session, trace, agent session). */
  DETAIL: 30_000,
  /** Slow-changing aggregate stats (agent stats). */
  AGGREGATE: 60_000,
} as const;

/** Polling / refetch interval for live and dashboard queries (ms). */
export const POLL_INTERVAL_MS = 30_000;

/** Exponential backoff base and cap for retry delays (ms). */
export const RETRY_DELAY_BASE = 1_000;
export const RETRY_DELAY_CAP = 30_000;

/** Default query params for metric detail endpoint. */
export const DEFAULT_TOP_N = 5;
export const DEFAULT_BUCKET_COUNT = 10;

/** Default page size for paginated evaluation queries. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Shared Recharts color palette for TrendChart and TrendSeries. */
export const CHART_COLORS = {
  line: '#58a6ff',
  grid: '#30363d',
  text: '#8b949e',
  tooltip: '#161b22',
  warning: '#d29922',
  critical: '#f85149',
} as const;

/** Color palette for per-agent visual distinction. */
export const AGENT_PALETTE = [
  '#6366f1', '#ec4899', '#14b8a6', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
] as const;
