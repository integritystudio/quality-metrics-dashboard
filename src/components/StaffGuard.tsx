/**
 * The gate on the admin customer view (ADMIN-CV-STAFF-GATE). `dashboard.admin` will not
 * do: under org scoping every customer org owner and admin holds it, and reusing it would
 * show them every other customer's billing. The only cross-org identity is `isStaff`,
 * which the worker computes from STAFF_USER_IDS and serves on /api/me. A session without
 * the field (pre-cutover, legacy) is not staff.
 *
 * Presentation only: api-gateway enforces the same list on every admin route itself.
 */
import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { useAuth } from '../contexts/AuthContext.js';
import { routes } from '../lib/routes.js';
import { ADMIN_VIEW } from '../lib/admin-customer-strings.js';

export function AccessDenied() {
  return (
    <div className="empty-state">
      <h2>Access Denied</h2>
      <p>You do not have permission to access this page.</p>
      <p><Link href="/">Go to dashboard</Link></p>
    </div>
  );
}

export function StaffGuard({ children }: { children: ReactNode }) {
  const { session, isLoading } = useAuth();
  if (isLoading) return null;
  if (session?.isStaff !== true) return <AccessDenied />;
  return <>{children}</>;
}

/** The hub's entry point in the header, beside the Admin link; rendered for staff only. */
export function StaffCustomersLink() {
  const { session } = useAuth();
  if (session?.isStaff !== true) return null;
  return (
    <Link href={routes.adminCustomers()} className="admin-link text-xs text-muted">
      {ADMIN_VIEW.customersLink}
    </Link>
  );
}
