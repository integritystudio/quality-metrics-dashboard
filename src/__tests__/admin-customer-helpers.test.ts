/**
 * The admin customer view's pure helpers, each checked against the Flutter function it
 * ports (IntegrityLandingPage lib/pages/*.dart). The `pickActiveOrg` rows are the four
 * cases of test/pages/dashboard_page_test.dart.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateUsageByDate,
  aggregateUsageByMetric,
  billingStatusBadge,
  dailyBarTone,
  dailyQuotaLine,
  dayLabel,
  formatEntitlementValue,
  formatRenewalDate,
  grandTotalQuantity,
  monthlyResetLabel,
  pickActiveOrg,
  quotaLevel,
  quotaPercent,
  quotaRatio,
  quotaTone,
  sortedEntitlements,
  titleCaseKey,
  usageTickLabel,
} from '../lib/admin-customer.js';
import { UsageBucketSchema } from '../lib/validation/admin-customer-schemas.js';

const bucket = (bucketDate: string, metricKey: string, totalQuantity: number, requestCount: number) =>
  UsageBucketSchema.parse({ bucket_date: bucketDate, metric_key: metricKey, total_quantity: totalQuantity, request_count: requestCount });

describe('pickActiveOrg (dashboard_page_test.dart)', () => {
  const orgs = [{ id: 'org-1', name: 'One' }, { id: 'org-2', name: 'Two' }];

  it('selects the preferred org when the list contains it', () => {
    expect(pickActiveOrg(orgs, 'org-2')?.id).toBe('org-2');
  });

  it('falls back to the first org when the preferred one is gone', () => {
    expect(pickActiveOrg(orgs, 'org-9')?.id).toBe('org-1');
  });

  it('selects the first org when no preference is given', () => {
    expect(pickActiveOrg(orgs, null)?.id).toBe('org-1');
  });

  it('returns null for an empty list', () => {
    expect(pickActiveOrg([], 'org-1')).toBeNull();
  });
});

describe('usage aggregation (usage_summary_page.dart)', () => {
  const buckets = [
    bucket('2026-10-05', 'requests', 50, 5),
    bucket('2026-10-01', 'requests', 100, 10),
    bucket('2026-10-05', 'otel_spans', 300, 3),
  ];

  it('sums every metric per date, dates ascending (aggregateUsageByDate + sortedDates)', () => {
    expect(aggregateUsageByDate(buckets)).toEqual([
      { date: '2026-10-01', total: 100 },
      { date: '2026-10-05', total: 350 },
    ]);
  });

  it('sums units and requests per metric, most units first (_aggregateBuckets + _MetricTable)', () => {
    expect(aggregateUsageByMetric(buckets)).toEqual([
      { metricKey: 'otel_spans', totalQuantity: 300, requestCount: 3 },
      { metricKey: 'requests', totalQuantity: 150, requestCount: 15 },
    ]);
  });

  it('totals the metrics (_grandTotalQuantity)', () => {
    expect(grandTotalQuantity(aggregateUsageByMetric(buckets))).toBe(450);
  });

  it('is empty for no buckets', () => {
    expect(aggregateUsageByDate([])).toEqual([]);
    expect(aggregateUsageByMetric([])).toEqual([]);
  });
});

describe('dayLabel (_DailyBarChart._dayLabel)', () => {
  it.each([
    ['2026-03-15', '15'],
    ['2026-03-05', '5'],
    ['2026-03', ''],
    ['not-a-date', ''],
    ['2026-03-xx', ''],
    ['2026-03-00', ''],
    ['', ''],
  ])('%j → %j', (iso, expected) => {
    expect(dayLabel(iso)).toBe(expected);
  });
});

describe('usageTickLabel (the painter: day 1 and every 5th day)', () => {
  it.each([
    ['2026-03-01', '1'],
    ['2026-03-05', '5'],
    ['2026-03-10', '10'],
    ['2026-03-30', '30'],
    ['2026-03-02', ''],
    ['2026-03-31', ''],
    ['malformed', ''],
  ])('%s → %j', (iso, expected) => {
    expect(usageTickLabel(iso)).toBe(expected);
  });
});

describe('titleCaseKey (_formatMetricKey / _formatPlanKey / _formatKey)', () => {
  it.each([
    ['monthly_units', 'Monthly Units'],
    ['requests', 'Requests'],
    ['otel_spans', 'Otel Spans'],
    ['already_Capitalised', 'Already Capitalised'],
    ['double__underscore', 'Double  Underscore'],
    ['', ''],
  ])('%j → %j', (key, expected) => {
    expect(titleCaseKey(key)).toBe(expected);
  });
});

describe('dates', () => {
  it('formatRenewalDate: "Month D, YYYY" in local time (billing_status_page.dart)', () => {
    expect(formatRenewalDate(new Date(2026, 9, 15, 12))).toBe('October 15, 2026');
    expect(formatRenewalDate(new Date(2027, 0, 1))).toBe('January 1, 2027');
  });

  it('monthlyResetLabel: the first of the next UTC month (usage_summary_page.dart)', () => {
    expect(monthlyResetLabel(new Date('2026-10-06T12:00:00Z'))).toBe('Resets November 1, 00:00 UTC');
    expect(monthlyResetLabel(new Date('2026-12-31T23:59:59Z'))).toBe('Resets January 1, 00:00 UTC');
  });
});

describe('quota thresholds (QuotaThresholds 0.75 / 0.90)', () => {
  const LIMIT = 100;

  it.each([
    [74, 'normal'],
    [75, 'warning'],
    [89, 'warning'],
    [90, 'danger'],
    [99, 'danger'],
    [100, 'reached'],
    [150, 'reached'],
  ])('%i of 100 is %s (_UsageBar._level)', (used, level) => {
    expect(quotaLevel(used, LIMIT)).toBe(level);
  });

  it.each([
    [0.74, 'normal'],
    [0.75, 'warning'],
    [0.89, 'warning'],
    [0.9, 'danger'],
  ])('a ratio of %f draws %s (_QuotaRow bar colour)', (ratio, tone) => {
    expect(quotaTone(ratio)).toBe(tone);
  });

  it('is normal with no limit or a zero limit', () => {
    expect(quotaLevel(500, null)).toBe('normal');
    expect(quotaLevel(500, 0)).toBe('normal');
    expect(quotaRatio(500, null)).toBe(0);
    expect(quotaRatio(500, 0)).toBe(0);
  });

  it('clamps the ratio to 0–1 and the percent to 100, rounded down', () => {
    expect(quotaRatio(150, LIMIT)).toBe(1);
    expect(quotaRatio(-5, LIMIT)).toBe(0);
    expect(quotaPercent(150, LIMIT)).toBe(100);
    expect(quotaPercent(999, 1000)).toBe(99);
    expect(quotaPercent(1, 3)).toBe(33);
    expect(quotaPercent(5, null)).toBe(0);
  });

  it('colours a daily bar by its ratio to the monthly limit over 30 days (_barColor)', () => {
    const monthly = 3000; // daily share 100
    expect(dailyQuotaLine(monthly)).toBe(100);
    expect(dailyQuotaLine(0)).toBeNull();
    expect(dailyBarTone(74, monthly)).toBe('normal');
    expect(dailyBarTone(75, monthly)).toBe('warning');
    expect(dailyBarTone(90, monthly)).toBe('danger');
    expect(dailyBarTone(1000, 0)).toBe('normal');
  });
});

describe('billingStatusBadge (_statusLabel + _statusColor)', () => {
  it.each([
    ['active', 'Active', 'success'],
    ['past_due', 'Past Due', 'warning'],
    ['inactive', 'Inactive', 'error'],
    ['canceled', 'Inactive', 'error'],
    ['trialing', 'Inactive', 'error'],
    ['', 'Inactive', 'error'],
  ])('%j → %s / %s', (status, label, tone) => {
    expect(billingStatusBadge(status)).toEqual({ label, tone });
  });
});

describe('entitlement values (_EntitlementsGrid)', () => {
  it.each([
    [true, 'Enabled'],
    [false, 'Disabled'],
    [null, 'N/A'],
    [undefined, 'N/A'],
    [500000, '500000'],
    ['custom', 'custom'],
    [{ nested: 1 }, '{"nested":1}'],
  ])('%j renders as %j', (value, expected) => {
    expect(formatEntitlementValue(value)).toBe(expected);
  });

  it('sorts rows by key, ascending', () => {
    expect(sortedEntitlements({ usage_dashboard: true, alerts: false, monthly_units: 1 }).map(([key]) => key))
      .toEqual(['alerts', 'monthly_units', 'usage_dashboard']);
  });
});
