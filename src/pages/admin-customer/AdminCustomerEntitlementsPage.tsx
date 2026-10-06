/**
 * Entitlements (ADMIN-CV-ENTITLEMENTS): the Flutter `EntitlementsPage`
 * (lib/pages/entitlements_page.dart) for any org. "N/A" is what the customer sees for an
 * unlimited limit (`null` in the map); kept for parity.
 */
import { useAdminEntitlements } from '../../hooks/useAdminCustomer.js';
import { formatEntitlementValue, sortedEntitlements, titleCaseKey } from '../../lib/admin-customer.js';
import { ADMIN_VIEW, CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import { routes } from '../../lib/routes.js';
import { CustomerPageScaffold } from '../../components/admin-customer/CustomerPageScaffold.js';
import { CustomerCard, CustomerCardActions, CustomerErrorCard, StatusPill } from '../../components/admin-customer/CustomerCard.js';

const { entitlements: text } = CUSTOMER_VIEW;

/** `_EntitlementRow`: booleans as a success or grey badge, everything else as text. */
function EntitlementValue({ value }: { value: unknown }) {
  const display = formatEntitlementValue(value);
  if (typeof value === 'boolean') return <StatusPill label={display} tone={value ? 'success' : 'muted'} />;
  return <span>{display}</span>;
}

export function AdminCustomerEntitlementsPage({ orgId }: { orgId: string }) {
  const entitlements = useAdminEntitlements(orgId);
  const rows = entitlements.data ? sortedEntitlements(entitlements.data.entitlements) : [];

  return (
    <CustomerPageScaffold
      title={text.title}
      subtitle={text.subtitle}
      orgNameAsSubtitle
      orgId={orgId}
      backHref={routes.adminCustomers(orgId)}
      backLabel={ADMIN_VIEW.backToHub}
    >
      {entitlements.isError ? (
        <CustomerErrorCard message={entitlements.error.message} onRetry={() => void entitlements.refetch()} />
      ) : (
        <CustomerCard title={text.cardTitle} isLoading={entitlements.isFetching}>
          {rows.length > 0 ? (
            <table className="customer-table">
              <thead>
                <tr>
                  <th scope="col">{text.columns.feature}</th>
                  <th scope="col" className="text-right">{text.columns.value}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, value]) => (
                  <tr key={key}>
                    <td>{titleCaseKey(key)}</td>
                    <td className="text-right"><EntitlementValue value={value} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !entitlements.isFetching && <p className="text-xs text-secondary">{text.empty}</p>
          )}
          <CustomerCardActions onRefresh={() => void entitlements.refetch()} disabled={entitlements.isFetching} />
        </CustomerCard>
      )}
    </CustomerPageScaffold>
  );
}
