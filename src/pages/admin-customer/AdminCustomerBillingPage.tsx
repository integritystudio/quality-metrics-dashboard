/**
 * Billing Status (ADMIN-CV-BILLING): the Flutter `BillingStatusPage`
 * (lib/pages/billing_status_page.dart) for any org. The customer's call to action opens
 * Stripe; here it is a read-only label, since the admin view never mutates. The endpoint
 * sends no `plan_display_name`, `current_period_end` or `cancel_at_period_end` today, so
 * the card is titled "Plan" and renews on "—" for every org, as it does for the customer;
 * the fields are parsed so the page follows the gateway when it adds them.
 */
import { useAdminBillingStatus } from '../../hooks/useAdminCustomer.js';
import { billingStatusBadge, formatRenewalDate } from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { routes } from '../../lib/routes.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerCard, CustomerCardActions, CustomerErrorCard, CustomerRow, StatusPill } from '../../components/admin-customer/CustomerCard.js';

const { billing: text, common } = CUSTOMER_VIEW;

export function AdminCustomerBillingPage({ orgId }: { orgId: string }) {
  const billing = useAdminBillingStatus(orgId);
  const data = billing.data;
  const isContractBilled = data?.planKey === text.contractPlan;
  const ctaLabel = data === undefined || isContractBilled ? null : data.hasBillingAccount ? text.manageBilling : text.choosePlan;
  // `planDisplayName.isNotEmpty ? planDisplayName : 'Plan'`: the endpoint sends none today.
  const cardTitle = data !== undefined && data.planDisplayName.length > 0 ? data.planDisplayName : text.defaultCardTitle;

  return (
    <CustomerPageScaffold
      title={text.title}
      subtitle={text.subtitle}
      orgId={orgId}
      backHref={routes.adminCustomers(orgId)}
      backLabel={ADMIN_VIEW.backToHub}
    >
      {billing.isError ? (
        <CustomerErrorCard message={billing.error.message} onRetry={() => void billing.refetch()} />
      ) : (
        <CustomerCard
          title={cardTitle}
          isLoading={billing.isFetching}
          trailing={data && <StatusPill {...billingStatusBadge(data.billingStatus)} />}
        >
          {data && (
            <>
              <CustomerRow label={text.planRow} value={data.planKey || common.dash} />
              <CustomerRow
                label={data.cancelAtPeriodEnd ? text.cancelsRow : text.renewsRow}
                value={data.nextRenewalDate ? formatRenewalDate(data.nextRenewalDate) : common.dash}
              />
              {!data.hasBillingAccount && (
                <p className="text-xs text-muted">{isContractBilled ? text.contractNote : text.noAccountNote}</p>
              )}
            </>
          )}
          <CustomerCardActions onRefresh={() => void billing.refetch()} disabled={billing.isFetching}>
            {ctaLabel && <span className="customer-cta" aria-disabled="true">{ctaLabel}</span>}
          </CustomerCardActions>
        </CustomerCard>
      )}
    </CustomerPageScaffold>
  );
}
