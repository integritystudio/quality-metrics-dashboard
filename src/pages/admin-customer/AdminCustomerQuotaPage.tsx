/**
 * Quota Status (ADMIN-CV-QUOTA): the Flutter `QuotaStatusPage`
 * (lib/pages/quota_status_page.dart) for any org. When the Durable Object is
 * uninitialized the customer sees "Minute: 0 / 0" and "Monthly: 0 (Unlimited)" with no
 * plan badge; that renders the same here, with one admin-only line saying why.
 */
import { useAdminQuotaStatus } from '../../hooks/useAdminCustomer.js';
import { quotaPercent, quotaRatio, quotaTone, titleCaseKey } from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { routes } from '../../lib/routes.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerCard, CustomerCardActions, CustomerErrorCard, CustomerRow, StatusPill } from '../../components/admin-customer/CustomerCard.js';
import { QuotaBar } from '../../components/admin-customer/QuotaBar.js';

const { quota: text } = CUSTOMER_VIEW;

/** `_QuotaRow`: "label: used / limit", or "used (Unlimited)" with no bar when the limit is null. */
function QuotaRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const ratio = quotaRatio(used, limit);
  return (
    <CustomerRow label={label} value={limit === null ? text.unlimited(used) : text.usedOfLimit(used, limit)}>
      {limit !== null && (
        <QuotaBar ratio={ratio} tone={quotaTone(ratio)} label={`${label} usage, ${used} of ${limit}`} percent={quotaPercent(used, limit)} />
      )}
    </CustomerRow>
  );
}

export function AdminCustomerQuotaPage({ orgId }: { orgId: string }) {
  const quota = useAdminQuotaStatus(orgId);
  const data = quota.data;

  return (
    <CustomerPageScaffold
      title={text.title}
      subtitle={text.subtitle}
      orgNameAsSubtitle
      orgId={orgId}
      backHref={routes.adminCustomers(orgId)}
      backLabel={ADMIN_VIEW.backToHub}
    >
      {quota.isError ? (
        <CustomerErrorCard message={quota.error.message} onRetry={() => void quota.refetch()} />
      ) : (
        <CustomerCard title={text.cardTitle} isLoading={quota.isFetching}>
          {data ? (
            <>
              {data.planKey !== null && <div><StatusPill label={titleCaseKey(data.planKey)} tone="info" /></div>}
              <QuotaRow label={text.minute} used={data.minuteUsed} limit={data.minuteLimit} />
              <QuotaRow label={text.monthly} used={data.monthlyUsed} limit={data.monthlyLimit} />
              {data.uninitialized && <p className="text-xs text-muted">{ADMIN_VIEW.quotaUninitialized}</p>}
            </>
          ) : (
            // `_data == null && !_isLoading`: nothing loaded and nothing loading.
            !quota.isFetching && <p className="text-xs text-secondary">{text.empty}</p>
          )}
          <CustomerCardActions onRefresh={() => void quota.refetch()} disabled={quota.isFetching} />
        </CustomerCard>
      )}
    </CustomerPageScaffold>
  );
}
