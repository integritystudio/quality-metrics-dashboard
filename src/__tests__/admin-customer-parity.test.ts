/**
 * The parity table (ADMIN-CV-PARITY-TESTS): every label, empty-state string, threshold and
 * formatter the admin customer view shares with the Flutter customer app, with the value
 * copied from the Dart source and a citation to the file and member. Changing either side
 * alone fails a row here.
 *
 * Source paths are in IntegrityLandingPage.
 */
import { describe, it, expect } from 'vitest';
import { CUSTOMER_VIEW } from '../lib/admin-customer-strings.js';
import {
  DAYS_PER_MONTH_FOR_DAILY_QUOTA,
  GATEWAY_MAX_RETRIES,
  QUOTA_BAR_HEIGHT,
  QUOTA_DANGER_RATIO,
  QUOTA_WARNING_RATIO,
  USAGE_CHART_GRID_LINES,
  USAGE_DAY_LABEL_INTERVAL,
  USAGE_POLL_INTERVAL_MS,
} from '../lib/admin-customer-constants.js';
import { DEFAULT_API_GATEWAY_URL } from '../lib/gateway.js';

type Row = [citation: string, actual: unknown, dartValue: unknown];

const HUB: Row[] = [
  ['dashboard_page.dart DashboardScaffold(title:)', CUSTOMER_VIEW.hub.title, 'Dashboard'],
  ['dashboard_page.dart build: "Organization" label above the switcher', CUSTOMER_VIEW.hub.orgLabel, 'Organization'],
  ['dashboard_page.dart build: empty list', CUSTOMER_VIEW.hub.empty, 'No organizations found.'],
  ['dashboard_page.dart _buildNavCard Billing', CUSTOMER_VIEW.hub.cards.billing, { label: 'Billing', description: 'Plan, billing status, renewal date' }],
  ['dashboard_page.dart _buildNavCard Usage', CUSTOMER_VIEW.hub.cards.usage, { label: 'Usage', description: 'Monthly usage summary by metric' }],
  ['dashboard_page.dart _buildNavCard Quota', CUSTOMER_VIEW.hub.cards.quota, { label: 'Quota', description: 'Minute burst and monthly quota limits' }],
  ['dashboard_page.dart _buildNavCard Entitlements', CUSTOMER_VIEW.hub.cards.entitlements, { label: 'Entitlements', description: 'Feature flags for your plan' }],
  ['dashboard_page.dart _buildNavCard Observability', CUSTOMER_VIEW.hub.cards.observability, { label: 'Observability', description: 'View your traces, logs, metrics, and evaluations' }],
];

const BILLING: Row[] = [
  ['billing_status_page.dart DashboardScaffold(title:)', CUSTOMER_VIEW.billing.title, 'Billing Status'],
  ['billing_status_page.dart DashboardScaffold(subtitle:)', CUSTOMER_VIEW.billing.subtitle, 'Current plan and renewal information'],
  ['billing_status_page.dart _BillingCard title fallback', CUSTOMER_VIEW.billing.defaultCardTitle, 'Plan'],
  ['billing_status_page.dart _InfoRow(label: "Plan")', CUSTOMER_VIEW.billing.planRow, 'Plan'],
  ['billing_status_page.dart _InfoRow renews label', CUSTOMER_VIEW.billing.renewsRow, 'Renews on'],
  ['billing_status_page.dart _InfoRow cancels label', CUSTOMER_VIEW.billing.cancelsRow, 'Cancels on'],
  ['billing_status_page.dart _BillingCard contract note', CUSTOMER_VIEW.billing.contractNote, 'This organization is billed by contract. Contact support to make changes.'],
  ['billing_status_page.dart _BillingCard no-account note', CUSTOMER_VIEW.billing.noAccountNote, 'No billing account yet. Choose a plan to set one up.'],
  ['billing_status_page.dart GradientButton text, has account', CUSTOMER_VIEW.billing.manageBilling, 'Manage Billing'],
  ['billing_status_page.dart GradientButton text, no account', CUSTOMER_VIEW.billing.choosePlan, 'Choose a plan'],
  ['billing_status_page.dart _statusLabel active', CUSTOMER_VIEW.billing.status.active, 'Active'],
  ['billing_status_page.dart _statusLabel past_due', CUSTOMER_VIEW.billing.status.pastDue, 'Past Due'],
  ['billing_status_page.dart _statusLabel default', CUSTOMER_VIEW.billing.status.other, 'Inactive'],
  ['constants.dart SignupTiers.enterprise (_isContractBilled)', CUSTOMER_VIEW.billing.contractPlan, 'enterprise'],
];

const USAGE: Row[] = [
  ['usage_summary_page.dart DashboardScaffold(title:)', CUSTOMER_VIEW.usage.title, 'Usage Summary'],
  ['usage_summary_page.dart DashboardScaffold(subtitle:) fallback', CUSTOMER_VIEW.usage.subtitle, 'Current month usage breakdown'],
  ['usage_summary_page.dart DashboardCard(title:)', CUSTOMER_VIEW.usage.cardTitle, 'Monthly Usage'],
  ['usage_summary_page.dart periodLabel with period_start', CUSTOMER_VIEW.usage.since('2026-10-01'), 'Since 2026-10-01'],
  ['usage_summary_page.dart periodLabel fallback', CUSTOMER_VIEW.usage.currentPeriod, 'Current period'],
  ['usage_summary_page.dart _UsageBar._usageLabel with limit', CUSTOMER_VIEW.usage.unitsOfLimit(12345, 500000), '12345 / 500000 units'],
  ['usage_summary_page.dart _UsageBar._usageLabel without limit', CUSTOMER_VIEW.usage.units(450), '450 units'],
  ['usage_summary_page.dart _UsageBar._statusLabel unlimited', CUSTOMER_VIEW.usage.unlimitedPlan, 'Unlimited plan'],
  ['usage_summary_page.dart _UsageBar._statusLabel reached', CUSTOMER_VIEW.usage.limitReached, 'Monthly limit reached'],
  ['usage_summary_page.dart _UsageBar._statusLabel percent', CUSTOMER_VIEW.usage.percentUsed(42), '42% used'],
  ['usage_summary_page.dart monthlyResetLabel', CUSTOMER_VIEW.usage.resets('November', 1), 'Resets November 1, 00:00 UTC'],
  ['usage_summary_page.dart _UsageBar._alert reached title', CUSTOMER_VIEW.usage.reachedAlertTitle, 'Monthly limit reached'],
  ['usage_summary_page.dart _UsageBar._alert reached message', CUSTOMER_VIEW.usage.reachedAlertMessage('Resets November 1, 00:00 UTC'), 'New requests are refused until the quota resets. Resets November 1, 00:00 UTC.'],
  ['usage_summary_page.dart _UsageBar._alert approaching title', CUSTOMER_VIEW.usage.approachingAlertTitle, 'Approaching your monthly limit'],
  ['usage_summary_page.dart _UsageBar._alert approaching message', CUSTOMER_VIEW.usage.approachingAlertMessage(80, 500000, 'Resets November 1, 00:00 UTC'), "You have used 80% of this month's 500000 units. Resets November 1, 00:00 UTC."],
  ['usage_summary_page.dart _DailyBarChart heading', CUSTOMER_VIEW.usage.dailyUsage, 'Daily usage'],
  ['usage_summary_page.dart _MetricTable heading', CUSTOMER_VIEW.usage.breakdown, 'Breakdown by metric'],
  ['usage_summary_page.dart _MetricTable header row', CUSTOMER_VIEW.usage.columns, { metric: 'Metric', units: 'Units', requests: 'Requests' }],
  ['usage_summary_page.dart _UsageSummaryCard empty', CUSTOMER_VIEW.usage.empty, 'No usage data for this period.'],
];

const QUOTA: Row[] = [
  ['quota_status_page.dart DashboardScaffold(title:)', CUSTOMER_VIEW.quota.title, 'Quota Status'],
  ['quota_status_page.dart DashboardScaffold(subtitle:) fallback', CUSTOMER_VIEW.quota.subtitle, 'Minute burst and monthly usage limits'],
  ['quota_status_page.dart DashboardCard(title:)', CUSTOMER_VIEW.quota.cardTitle, 'Quota Usage'],
  ['quota_status_page.dart _QuotaRow(label: "Minute")', CUSTOMER_VIEW.quota.minute, 'Minute'],
  ['quota_status_page.dart _QuotaRow(label: "Monthly")', CUSTOMER_VIEW.quota.monthly, 'Monthly'],
  ['quota_status_page.dart _QuotaRow._limitLabel with limit', CUSTOMER_VIEW.quota.usedOfLimit(5, 60), '5 / 60'],
  ['quota_status_page.dart _QuotaRow._limitLabel unlimited', CUSTOMER_VIEW.quota.unlimited(12345), '12345 (Unlimited)'],
  ['quota_status_page.dart _QuotaCard empty', CUSTOMER_VIEW.quota.empty, 'No quota data available.'],
];

const ENTITLEMENTS: Row[] = [
  ['entitlements_page.dart DashboardScaffold(title:)', CUSTOMER_VIEW.entitlements.title, 'Entitlements'],
  ['entitlements_page.dart DashboardScaffold(subtitle:) fallback', CUSTOMER_VIEW.entitlements.subtitle, 'Feature flags and limits for your plan'],
  ['entitlements_page.dart DashboardCard(title:)', CUSTOMER_VIEW.entitlements.cardTitle, 'Feature Entitlements'],
  ['entitlements_page.dart _EntitlementRow header', CUSTOMER_VIEW.entitlements.columns, { feature: 'Feature', value: 'Value' }],
  ['entitlements_page.dart _formatValue true', CUSTOMER_VIEW.entitlements.enabled, 'Enabled'],
  ['entitlements_page.dart _formatValue false', CUSTOMER_VIEW.entitlements.disabled, 'Disabled'],
  ['entitlements_page.dart _formatValue null', CUSTOMER_VIEW.entitlements.notAvailable, 'N/A'],
  ['entitlements_page.dart _EntitlementsCard empty', CUSTOMER_VIEW.entitlements.empty, 'No entitlements found for this organization.'],
];

const COMMON: Row[] = [
  ['buttons.dart OutlineButton(text: "Refresh") on every page', CUSTOMER_VIEW.common.refresh, 'Refresh'],
  ['error_card.dart retry button', CUSTOMER_VIEW.common.tryAgain, 'Try again'],
  ['billing_status_page.dart _InfoRow value fallback', CUSTOMER_VIEW.common.dash, '—'],
];

const ERRORS: Row[] = [
  ['dashboard_service.dart _errorBillingAuth (401)', CUSTOMER_VIEW.errors.auth, 'Authentication required. Please log in again.'],
  ['dashboard_service.dart _errorBillingForbidden (403)', CUSTOMER_VIEW.errors.forbidden, "You don't have permission to manage billing for this organization."],
  ['dashboard_service.dart _errorServer (500/504 after retries)', CUSTOMER_VIEW.errors.server, 'Server error. Please try again.'],
  ['dashboard_service.dart _errorTimeout', CUSTOMER_VIEW.errors.timeout, 'Connection timed out. Please try again.'],
  ['dashboard_service.dart _errorNetwork', CUSTOMER_VIEW.errors.network, 'Network error. Please try again.'],
  ['dashboard_service.dart _errorUnexpected', CUSTOMER_VIEW.errors.unexpected, 'An unexpected error occurred.'],
  ['dashboard_service.dart _maxRetries', GATEWAY_MAX_RETRIES, 2],
  ['dashboard_service.dart _apiGatewayUrl default', DEFAULT_API_GATEWAY_URL, 'https://api.integritystudio.dev'],
];

const THRESHOLDS: Row[] = [
  ['constants.dart QuotaThresholds.warning', QUOTA_WARNING_RATIO, 0.75],
  ['constants.dart QuotaThresholds.danger', QUOTA_DANGER_RATIO, 0.9],
  ['usage_summary_page.dart _DailyBarChartPainter._defaultDaysInMonth', DAYS_PER_MONTH_FOR_DAILY_QUOTA, 30],
  ['usage_summary_page.dart _DailyBarChartPainter._labelIntervalDays', USAGE_DAY_LABEL_INTERVAL, 5],
  ['usage_summary_page.dart _DailyBarChartPainter._gridLineCount', USAGE_CHART_GRID_LINES, 4],
  ['usage_summary_page.dart _UsageSummaryPageState._pollInterval', USAGE_POLL_INTERVAL_MS, 30_000],
  ['quota_status_page.dart / usage_summary_page.dart LinearProgressIndicator(minHeight:)', QUOTA_BAR_HEIGHT, 6],
];

describe.each([
  ['hub', HUB],
  ['billing', BILLING],
  ['usage', USAGE],
  ['quota', QUOTA],
  ['entitlements', ENTITLEMENTS],
  ['common', COMMON],
  ['errors', ERRORS],
  ['thresholds', THRESHOLDS],
])('parity: %s', (_group, rows) => {
  it.each(rows)('%s', (_citation, actual, dartValue) => {
    expect(actual).toEqual(dartValue);
  });
});
