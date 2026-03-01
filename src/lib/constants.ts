/** Percentage of events sampled for T2 LLM evaluation. */
export const LLM_SAMPLE_RATE = 10;

/** Score band thresholds for quality indicator color coding. */
export const SCORE_THRESHOLD_GREEN = 0.8;
export const SCORE_THRESHOLD_YELLOW = 0.5;

/** Error rate fraction above which agent activity is flagged as critical. */
export const ERROR_RATE_WARNING_THRESHOLD = 0.1;

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
