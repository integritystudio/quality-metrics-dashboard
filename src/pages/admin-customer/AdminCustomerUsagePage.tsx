/**
 * Usage Summary (ADMIN-CV-USAGE): the Flutter `UsageSummaryPage`
 * (lib/pages/usage_summary_page.dart) for any org, as it stands after CR52: the usage bar
 * reads the quota the gateway enforces (`monthlyUsed` / `monthlyLimit`) when a quota with a
 * plan is available, the bucket total otherwise; the chart and the per-metric table keep
 * the bucket totals. Both reads poll every 30 s; a failed poll keeps what is on screen, and
 * only a first-load failure shows the error card.
 */
import { useAdminUsageQuota, useAdminUsageSummary } from '../../hooks/useAdminCustomer.js';
import {
  aggregateUsageByMetric,
  grandTotalQuantity,
  monthlyResetLabel,
  quotaLevel,
  quotaPercent,
  quotaRatio,
  titleCaseKey,
  type QuotaLevel,
  type QuotaTone,
} from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { routes } from '../../lib/routes.js';
import type { QuotaStatusData, UsageSummaryData } from '../../lib/validation/admin-customer-schemas.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerCard, CustomerCardActions, CustomerErrorCard } from '../../components/admin-customer/CustomerCard.js';
import { QuotaBar } from '../../components/admin-customer/QuotaBar.js';
import { DailyUsageChart } from '../../components/admin-customer/DailyUsageChart.js';

const { usage: text } = CUSTOMER_VIEW;

/** `_levelColor`: reached and danger draw as danger. */
const LEVEL_TONE: Record<QuotaLevel, QuotaTone> = { normal: 'normal', warning: 'warning', danger: 'danger', reached: 'danger' };
/** The alert and status line borrow the dashboard's status tokens. */
const LEVEL_STATUS: Record<Exclude<QuotaLevel, 'normal'>, 'warning' | 'critical'> = { warning: 'warning', danger: 'warning', reached: 'critical' };

/**
 * `_UsageBar`: usage against the monthly limit, in words as well as colour. Without a
 * quota it shows the bucket total alone.
 */
function UsageBar({ quota, bucketTotal, periodLabel, resetLabel }: {
  quota: QuotaStatusData | null;
  bucketTotal: number;
  periodLabel: string;
  resetLabel: string;
}) {
  const used = quota?.monthlyUsed ?? bucketTotal;
  const limit = quota?.monthlyLimit != null && quota.monthlyLimit > 0 ? quota.monthlyLimit : null;
  const isUnlimited = quota !== null && quota.monthlyLimit === null;
  const ratio = quotaRatio(used, limit);
  const percent = quotaPercent(used, limit);
  const level = quotaLevel(used, limit);
  const isRaised = level !== 'normal';

  const status = isUnlimited
    ? text.unlimitedPlan
    : limit === null
      ? null
      : level === 'reached'
        ? text.limitReached
        : text.percentUsed(percent);

  return (
    <div className="usage-bar">
      <div className="usage-bar__line">
        <span className="text-xs text-muted truncate">{periodLabel}</span>
        <span className="text-xs font-semibold">{limit !== null ? text.unitsOfLimit(used, limit) : text.units(used)}</span>
      </div>
      {limit !== null && (
        <QuotaBar ratio={ratio} tone={LEVEL_TONE[level]} label={`Monthly usage, ${used} of ${limit} units`} percent={percent} />
      )}
      {status !== null && (
        <div className="usage-bar__status">
          <span className="usage-bar__level" data-status={isRaised ? LEVEL_STATUS[level] : undefined}>{status}</span>
          <span className="text-xs text-muted">{resetLabel}</span>
        </div>
      )}
      {level === 'reached' && limit !== null && (
        <div className="customer-alert" data-status="critical" role="alert">
          <p className="customer-alert__title">{text.reachedAlertTitle}</p>
          <p>{text.reachedAlertMessage(resetLabel)}</p>
        </div>
      )}
      {(level === 'danger' || level === 'warning') && limit !== null && (
        <div className="customer-alert" data-status="warning" role="alert">
          <p className="customer-alert__title">{text.approachingAlertTitle}</p>
          <p>{text.approachingAlertMessage(percent, limit, resetLabel)}</p>
        </div>
      )}
    </div>
  );
}

/** `_MetricTable`: Metric / Units / Requests, most units first. */
function MetricTable({ summary }: { summary: UsageSummaryData }) {
  const totals = aggregateUsageByMetric(summary.buckets);
  if (totals.length === 0) return null;
  return (
    <div>
      <p className="customer-chart__title">{text.breakdown}</p>
      <table className="customer-table">
        <thead>
          <tr>
            <th scope="col">{text.columns.metric}</th>
            <th scope="col" className="text-right">{text.columns.units}</th>
            <th scope="col" className="text-right">{text.columns.requests}</th>
          </tr>
        </thead>
        <tbody>
          {totals.map((t) => (
            <tr key={t.metricKey}>
              <td>{titleCaseKey(t.metricKey)}</td>
              <td className="text-right mono-xs">{t.totalQuantity}</td>
              <td className="text-right mono-xs">{t.requestCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminCustomerUsagePage({ orgId }: { orgId: string }) {
  const summary = useAdminUsageSummary(orgId);
  // `data` is the last accepted quota: the hook refuses a plan-less answer, and a failed
  // poll never clears what the previous one returned.
  const quota = useAdminUsageQuota(orgId);
  const acceptedQuota = quota.data ?? null;

  const data = summary.data;
  const showError = summary.isError && data === undefined;
  const bucketTotal = data ? grandTotalQuantity(aggregateUsageByMetric(data.buckets)) : 0;
  const periodLabel = data?.periodStart ? text.since(data.periodStart) : text.currentPeriod;

  function refresh() {
    void summary.refetch();
    void quota.refetch();
  }

  return (
    <CustomerPageScaffold
      title={text.title}
      subtitle={text.subtitle}
      orgNameAsSubtitle
      orgId={orgId}
      backHref={routes.adminCustomers(orgId)}
      backLabel={ADMIN_VIEW.backToHub}
    >
      {showError ? (
        <CustomerErrorCard message={summary.error.message} onRetry={refresh} />
      ) : (
        <CustomerCard title={text.cardTitle} isLoading={summary.isPending}>
          {data ? (
            <>
              <UsageBar quota={acceptedQuota} bucketTotal={bucketTotal} periodLabel={periodLabel} resetLabel={monthlyResetLabel(new Date(summary.dataUpdatedAt))} />
              {data.buckets.length > 0 && (
                <DailyUsageChart buckets={data.buckets} monthlyLimit={acceptedQuota?.monthlyLimit ?? 0} />
              )}
              <MetricTable summary={data} />
            </>
          ) : (
            // `_summary == null && !_isLoading`: nothing loaded and nothing loading.
            !summary.isFetching && <p className="text-xs text-secondary">{text.empty}</p>
          )}
          <CustomerCardActions onRefresh={refresh} disabled={summary.isPending} />
        </CustomerCard>
      )}
    </CustomerPageScaffold>
  );
}
