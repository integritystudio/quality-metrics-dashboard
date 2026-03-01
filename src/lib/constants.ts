import { z } from 'zod';

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

/** Shared Zod schema for period query param validation (default: '7d'). */
export const PeriodSchema = z.enum(PERIOD_KEYS).default('7d');

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
