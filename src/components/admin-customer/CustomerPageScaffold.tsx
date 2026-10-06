/**
 * The admin customer view's page frame: the Flutter `DashboardScaffold`'s single centred
 * column (lib/widgets/common/dashboard_scaffold.dart, max width 600) inside `PageShell`,
 * whose back link returns to the hub with the org still selected (ADMIN-CV-LAYOUT-NAV).
 *
 * One deliberate deviation from the customer app: every screen names the org and its id
 * under the title, since an admin can be looking at any of them.
 */
import type { ReactNode } from 'react';
import { PageShell } from '../PageShell.js';
import { useAdminOrgDirectory } from '../../hooks/useAdminCustomer.js';
import { ADMIN_VIEW } from '../../lib/admin-customer-strings.js';

interface CustomerPageScaffoldProps {
  title: string;
  /** The Flutter page's fixed subtitle; absent on the hub. */
  subtitle?: string;
  /** Usage, Quota and Entitlements show the org name as the subtitle when it is known. */
  orgNameAsSubtitle?: boolean;
  orgId?: string;
  backHref: string;
  backLabel: string;
  children: ReactNode;
}

export function CustomerPageScaffold({
  title,
  subtitle,
  orgNameAsSubtitle = false,
  orgId,
  backHref,
  backLabel,
  children,
}: CustomerPageScaffoldProps) {
  const directory = useAdminOrgDirectory();
  const org = orgId === undefined ? undefined : directory.data?.find((o) => o.id === orgId);
  const shownSubtitle = orgNameAsSubtitle && org?.name ? org.name : subtitle;

  return (
    <PageShell isLoading={false} error={null} backHref={backHref} backLabel={backLabel}>
      <div className="customer-view">
        <header className="customer-view__header">
          <h2 className="customer-view__title">{title}</h2>
          {shownSubtitle && <p className="customer-view__subtitle">{shownSubtitle}</p>}
          {orgId !== undefined && (
            <p className="customer-view__org">
              <span className="customer-view__org-name">{org?.name ?? ADMIN_VIEW.unknownOrg}</span>
              <span className="customer-view__org-id">{ADMIN_VIEW.orgIdLabel}: {orgId}</span>
            </p>
          )}
        </header>
        {children}
      </div>
    </PageShell>
  );
}
