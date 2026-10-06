/**
 * The admin customer hub (ADMIN-CV-HUB): the Flutter `DashboardPage`
 * (lib/pages/dashboard_page.dart) over the staff directory instead of the caller's own
 * memberships. The chosen org is the URL's `?org=`, so returning from a screen (which
 * links back with it) and reloading both land on the same org; choosing one here is a
 * local navigation, never `POST /api/org/switch`, which would persist the admin's own
 * default org and drop the whole query cache.
 */
import { useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { useAdminOrgDirectory } from '../../hooks/useAdminCustomer.js';
import { useOrgOptional } from '../../contexts/OrgContext.js';
import { pickActiveOrg } from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { ADMIN_CUSTOMERS_ORG_PARAM, routes } from '../../lib/routes.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerErrorCard } from '../../components/admin-customer/CustomerCard.js';
import { NavCard } from '../../components/admin-customer/NavCard.js';

const ORG_SELECT_ID = 'admin-customer-org';

export function AdminCustomerHubPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const org = useOrgOptional();
  const directory = useAdminOrgDirectory();
  const [observabilityError, setObservabilityError] = useState<string | null>(null);

  const preferredOrgId = new URLSearchParams(search).get(ADMIN_CUSTOMERS_ORG_PARAM);
  const orgs = directory.data ?? [];
  const activeOrg = pickActiveOrg(orgs, preferredOrgId);

  function chooseOrg(orgId: string) {
    navigate(routes.adminCustomers(orgId), { replace: true });
  }

  /**
   * The Flutter card opens this app signed in as the customer. For staff the equivalent is
   * this app in the viewed org: the worker lets staff choose any org, and the switch is the
   * same one the header's org switcher makes, so it persists as the admin's default org
   * until they switch again. That is the point — it is how a staff member reaches a
   * non-member org's observability at all, since the switcher lists memberships only.
   */
  async function openObservability() {
    if (!activeOrg) return;
    setObservabilityError(null);
    const switched = org ? await org.switchOrg(activeOrg.id) : true;
    if (!switched) {
      setObservabilityError(ADMIN_VIEW.openObservabilityFailed);
      return;
    }
    navigate('/');
  }

  return (
    <CustomerPageScaffold title={CUSTOMER_VIEW.hub.title} backHref={routes.admin()} backLabel={ADMIN_VIEW.backToAdmin}>
      {directory.isPending ? (
        <div className="customer-spinner customer-spinner--centered" role="status" aria-label="Loading" />
      ) : directory.isError ? (
        <CustomerErrorCard message={directory.error.message} onRetry={() => void directory.refetch()} />
      ) : orgs.length === 0 ? (
        <p className="text-secondary">{CUSTOMER_VIEW.hub.empty}</p>
      ) : (
        <>
          {orgs.length > 1 ? (
            <div className="customer-org-picker">
              <label htmlFor={ORG_SELECT_ID} className="customer-org-picker__label">{CUSTOMER_VIEW.hub.orgLabel}</label>
              <select
                id={ORG_SELECT_ID}
                className="select-sm"
                value={activeOrg?.id ?? ''}
                onChange={(e) => chooseOrg(e.target.value)}
              >
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <p className="text-secondary customer-org-picker__single">{activeOrg?.name ?? ''}</p>
          )}
          {activeOrg && (
            <nav className="customer-nav" aria-label="Customer screens">
              <NavCard {...CUSTOMER_VIEW.hub.cards.billing} href={routes.adminCustomerBilling(activeOrg.id)} />
              <NavCard {...CUSTOMER_VIEW.hub.cards.usage} href={routes.adminCustomerUsage(activeOrg.id)} />
              <NavCard {...CUSTOMER_VIEW.hub.cards.quota} href={routes.adminCustomerQuota(activeOrg.id)} />
              <NavCard {...CUSTOMER_VIEW.hub.cards.entitlements} href={routes.adminCustomerEntitlements(activeOrg.id)} />
              <NavCard {...CUSTOMER_VIEW.hub.cards.observability} onClick={() => void openObservability()} />
              {observabilityError && <p className="text-xs text-critical" role="alert">{observabilityError}</p>}
            </nav>
          )}
        </>
      )}
    </CustomerPageScaffold>
  );
}
