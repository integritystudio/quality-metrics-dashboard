/**
 * The admin customer view's pure logic, each function a port of the Flutter one it is
 * named after (IntegrityLandingPage lib/pages/*.dart), so the parity tests can check the
 * port against the original case by case.
 */
import { format } from 'date-fns';
import {
  DAYS_PER_MONTH_FOR_DAILY_QUOTA,
  PERCENT_MAX,
  QUOTA_DANGER_RATIO,
  QUOTA_WARNING_RATIO,
  USAGE_DAY_LABEL_INTERVAL,
} from './admin-customer-constants.js';
import { CUSTOMER_VIEW } from './admin-customer-strings.js';
import type { UsageBucket } from './validation/admin-customer-schemas.js';

/** `pickActiveOrg` (dashboard_page.dart): the preferred org while it is listed, else the first, else null. */
export function pickActiveOrg<T extends { id: string }>(orgs: readonly T[], preferredId: string | null | undefined): T | null {
  if (orgs.length === 0) return null;
  return orgs.find((org) => org.id === preferredId) ?? orgs[0] ?? null;
}

export interface DailyUsage {
  date: string;
  total: number;
}

/** `aggregateUsageByDate` + the chart's `sortedDates`: one total per date, ascending. */
export function aggregateUsageByDate(buckets: readonly UsageBucket[]): DailyUsage[] {
  const daily = new Map<string, number>();
  for (const bucket of buckets) {
    daily.set(bucket.bucketDate, (daily.get(bucket.bucketDate) ?? 0) + bucket.totalQuantity);
  }
  return [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, total]) => ({ date, total }));
}

export interface MetricTotal {
  metricKey: string;
  totalQuantity: number;
  requestCount: number;
}

/** `_aggregateBuckets` + `_MetricTable`'s sort: per-metric totals, most units first. */
export function aggregateUsageByMetric(buckets: readonly UsageBucket[]): MetricTotal[] {
  const totals = new Map<string, MetricTotal>();
  for (const bucket of buckets) {
    const existing = totals.get(bucket.metricKey);
    totals.set(bucket.metricKey, {
      metricKey: bucket.metricKey,
      totalQuantity: (existing?.totalQuantity ?? 0) + bucket.totalQuantity,
      requestCount: (existing?.requestCount ?? 0) + bucket.requestCount,
    });
  }
  return [...totals.values()].sort((a, b) => b.totalQuantity - a.totalQuantity);
}

/** `_grandTotalQuantity`. */
export function grandTotalQuantity(totals: readonly MetricTotal[]): number {
  return totals.reduce((sum, t) => sum + t.totalQuantity, 0);
}

const DAY_OF_MONTH = /^\d+$/;

/** `_DailyBarChart._dayLabel`: "2026-03-15" → "15"; malformed or day 0 → "" so nothing renders. */
export function dayLabel(isoDate: string): string {
  const parts = isoDate.split('-');
  const dayPart = parts[2];
  if (parts.length < 3 || dayPart === undefined || !DAY_OF_MONTH.test(dayPart)) return '';
  const day = Number.parseInt(dayPart, 10);
  return day === 0 ? '' : String(day);
}

/** The painter's x-label rule: day 1 and every `USAGE_DAY_LABEL_INTERVAL`th day; other days get no label. */
export function usageTickLabel(isoDate: string): string {
  const label = dayLabel(isoDate);
  const day = Number.parseInt(label, 10) || 0;
  return day === 1 || day % USAGE_DAY_LABEL_INTERVAL === 0 ? label : '';
}

/** `_formatMetricKey` / `_formatPlanKey` / `_formatKey`: snake_case → Title Case, each word's first letter only. */
export function titleCaseKey(key: string): string {
  return key
    .split('_')
    .map((word) => (word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`))
    .join(' ');
}

/** `formatRenewalDate` (billing_status_page.dart): "October 15, 2026", in local time. */
export function formatRenewalDate(date: Date): string {
  return format(date, 'MMMM d, yyyy');
}

const UTC_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** `monthlyResetLabel` (usage_summary_page.dart): the first of the next UTC month. */
export function monthlyResetLabel(now: Date): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return CUSTOMER_VIEW.usage.resets(UTC_MONTH_NAMES[reset.getUTCMonth()]!, reset.getUTCDate());
}

/** `_QuotaLevel` on the usage page. */
export type QuotaLevel = 'normal' | 'warning' | 'danger' | 'reached';
/** The three bar colours; `reached` draws as `danger`. */
export type QuotaTone = 'normal' | 'warning' | 'danger';

/** `_QuotaRow` / `_UsageBar` ratio: 0 without a positive limit, else used/limit clamped to 0–1. */
export function quotaRatio(used: number, limit: number | null): number {
  if (limit == null || limit <= 0) return 0;
  return Math.min(Math.max(used / limit, 0), 1);
}

/** `_UsageBar._percent`: rounded down, capped at 100. */
export function quotaPercent(used: number, limit: number | null): number {
  if (limit == null || limit <= 0) return 0;
  return Math.min(Math.floor((used * PERCENT_MAX) / limit), PERCENT_MAX);
}

/** `_UsageBar._level`. */
export function quotaLevel(used: number, limit: number | null): QuotaLevel {
  if (limit == null || limit <= 0) return 'normal';
  if (used >= limit) return 'reached';
  const ratio = quotaRatio(used, limit);
  if (ratio >= QUOTA_DANGER_RATIO) return 'danger';
  if (ratio >= QUOTA_WARNING_RATIO) return 'warning';
  return 'normal';
}

/** `_QuotaRow`'s bar colour and `_UsageBar._levelColor`: danger at 0.90, warning at 0.75, else the accent. */
export function quotaTone(ratio: number): QuotaTone {
  if (ratio >= QUOTA_DANGER_RATIO) return 'danger';
  if (ratio >= QUOTA_WARNING_RATIO) return 'warning';
  return 'normal';
}

/** `_DailyBarChartPainter._barColor`: a bar's ratio to the daily share of the monthly limit. */
export function dailyBarTone(value: number, monthlyLimit: number): QuotaTone {
  if (monthlyLimit <= 0) return 'normal';
  const dailyQuota = monthlyLimit / DAYS_PER_MONTH_FOR_DAILY_QUOTA;
  return quotaTone(dailyQuota > 0 ? value / dailyQuota : 0);
}

/** `_DailyBarChartPainter`'s dashed reference line: the daily share of the monthly limit, or null without one. */
export function dailyQuotaLine(monthlyLimit: number): number | null {
  return monthlyLimit > 0 ? monthlyLimit / DAYS_PER_MONTH_FOR_DAILY_QUOTA : null;
}

export type BillingTone = 'success' | 'warning' | 'error';

/** `_statusLabel` + `_statusColor` (billing_status_page.dart): active, past_due, and everything else as Inactive. */
export function billingStatusBadge(status: string): { label: string; tone: BillingTone } {
  switch (status) {
    case 'active':
      return { label: CUSTOMER_VIEW.billing.status.active, tone: 'success' };
    case 'past_due':
      return { label: CUSTOMER_VIEW.billing.status.pastDue, tone: 'warning' };
    default:
      return { label: CUSTOMER_VIEW.billing.status.other, tone: 'error' };
  }
}

/** `_EntitlementsGrid._formatValue`: booleans as Enabled/Disabled, null as N/A, anything else as text. */
export function formatEntitlementValue(value: unknown): string {
  if (value == null) return CUSTOMER_VIEW.entitlements.notAvailable;
  if (typeof value === 'boolean') return value ? CUSTOMER_VIEW.entitlements.enabled : CUSTOMER_VIEW.entitlements.disabled;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  // The gateway sends booleans, numbers and nulls; anything else is shown as its JSON.
  return typeof value === 'object' ? JSON.stringify(value) : typeof value;
}

/** `_EntitlementsGrid`'s rows: sorted by key, ascending. */
export function sortedEntitlements(entitlements: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(entitlements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
