/**
 * Admin customer view (ADMIN-CUSTOMER-VIEW): the numbers the Flutter customer app uses,
 * copied with their source so the clone can be checked against it line by line. Paths
 * are in IntegrityLandingPage.
 */

/** `QuotaThresholds.warning` — lib/config/content/constants.dart. */
export const QUOTA_WARNING_RATIO = 0.75;
/** `QuotaThresholds.danger` — lib/config/content/constants.dart. */
export const QUOTA_DANGER_RATIO = 0.9;
/** `_DailyBarChartPainter._defaultDaysInMonth` — the daily reference line is the monthly limit over this. */
export const DAYS_PER_MONTH_FOR_DAILY_QUOTA = 30;
/** `_DailyBarChartPainter._labelIntervalDays` — an x label on day 1 and every 5th day. */
export const USAGE_DAY_LABEL_INTERVAL = 5;
/** `_DailyBarChartPainter._gridLineCount`. */
export const USAGE_CHART_GRID_LINES = 4;
/** `_DailyBarChart._chartAreaHeight + _xLabelAreaHeight`, 120 + 20. */
export const USAGE_CHART_HEIGHT = 140;
/** `_DailyBarChartPainter._barGapFraction`: the bar fills 70% of its slot. */
export const USAGE_BAR_CATEGORY_GAP = '30%';
/**
 * `_UsageSummaryPageState._pollInterval`, 30 s. The same value as the dashboard's own
 * POLL_INTERVAL_MS, kept apart so a change to one does not move the other.
 */
export const USAGE_POLL_INTERVAL_MS = 30_000;
/** `DashboardService._maxRetries`: 2 retries, 3 attempts. */
export const GATEWAY_MAX_RETRIES = 2;
/** `AppTimings.httpConnectTimeout` + `httpReceiveTimeout`, 10 s each — lib/theme/timings.dart; one bound covers both here. */
export const GATEWAY_TIMEOUT_MS = 20_000;
/** `LinearProgressIndicator(minHeight: 6)` on the quota and usage bars. */
export const QUOTA_BAR_HEIGHT = 6;
/** A usage percentage never reads above this, however far a downgrade put usage over the limit. */
export const PERCENT_MAX = 100;
