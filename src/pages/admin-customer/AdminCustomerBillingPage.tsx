/**
 * Billing Status (ADMIN-CV-BILLING): the Flutter `BillingStatusPage`
 * (lib/pages/billing_status_page.dart) for any org. The customer's call to action opens
 * Stripe; here it is a read-only label, since the admin view never mutates. The endpoint
 * sends no `plan_display_name`, `current_period_end` or `cancel_at_period_end` today, so
 * the card is titled "Plan" and renews on "—" for every org, as it does for the customer;
 * the fields are parsed so the page follows the gateway when it adds them.
 */
import type { ReactNode } from 'react';
import { useAdminBillingStatus } from '../../hooks/useAdminCustomer.js';
import { billingStatusBadge, formatRenewalDate } from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { routes } from '../../lib/routes.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerCard, CustomerCardActions, CustomerErrorCard, CustomerRow, StatusPill } from '../../components/admin-customer/CustomerCard.js';

const { billing: text, common } = CUSTOMER_VIEW;

type BillingData = ReturnType<typeof useAdminBillingStatus>['data'];

/** The read-only stand-in for the customer's Stripe CTA; a contract-billed org gets none. */
function billingCtaLabel(data: BillingData, isContractBilled: boolean): string | null {
  if (data === undefined || isContractBilled) return null;
  return data.hasBillingAccount ? text.manageBilling : text.choosePlan;
}

/** `planDisplayName.isNotEmpty ? planDisplayName : 'Plan'`: the endpoint sends none today. */
function billingCardTitle(data: BillingData): string {
  if (data !== undefined && data.planDisplayName.length > 0) return data.planDisplayName;
  return text.defaultCardTitle;
}

/** Plan, renewal and the note that stands in for a missing billing account. */
function BillingDetails({ data, isContractBilled }: {
  data: NonNullable<BillingData>;
  isContractBilled: boolean;
}): ReactNode {
  return (
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
  );
}

export function AdminCustomerBillingPage({ orgId }: { orgId: string }) {
  const billing = useAdminBillingStatus(orgId);
  const data = billing.data;
  const isContractBilled = data?.planKey === text.contractPlan;
  const ctaLabel = billingCtaLabel(data, isContractBilled);
  const cardTitle = billingCardTitle(data);

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
          {data && <BillingDetails data={data} isContractBilled={isContractBilled} />}
          <CustomerCardActions onRefresh={() => void billing.refetch()} disabled={billing.isFetching}>
            {ctaLabel && <span className="customer-cta" aria-disabled="true">{ctaLabel}</span>}
          </CustomerCardActions>
        </CustomerCard>
      )}
    </CustomerPageScaffold>
  );
}
