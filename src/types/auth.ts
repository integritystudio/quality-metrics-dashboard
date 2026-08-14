import type { RoleViewType } from '../types.js';

export type DashboardPermission =
  | 'dashboard.read'
  | 'dashboard.executive'
  | 'dashboard.operator'
  | 'dashboard.auditor'
  | 'dashboard.traces.read'
  | 'dashboard.sessions.read'
  | 'dashboard.agents.read'
  | 'dashboard.pipeline.read'
  | 'dashboard.compliance.read'
  | 'dashboard.admin';

/** Type alias for RoleViewType — avoids duplicating the union in auth-specific code. */
export type DashboardView = RoleViewType;

/**
 * organization_memberships.role — CHECK-constrained enum in Supabase.
 * The runtime source of dashboard permissions under org scoping (P5);
 * legacy user_roles names play no part in the mapping.
 */
export type OrgMembershipRole = 'owner' | 'admin' | 'member' | 'billing_admin' | 'viewer';

/** The four dashboard roles derived from a membership role (org-rbac.ts). */
export type DashboardRole = 'owner' | 'admin' | 'read' | 'e2e-dashboard-reader';

export interface OrgMembershipSummary {
  orgId: string;
  slug: string;
  name: string;
  membershipRole: OrgMembershipRole;
  dashboardRole: DashboardRole;
}

export interface AppSession {
  /** Server-side only. Not populated on the client — /api/me never returns internal IDs. */
  authUserId?: string;
  /** Server-side only. Not populated on the client — /api/me never returns internal IDs. */
  appUserId?: string;
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: DashboardView[];
  // Org-scoping fields (P5) — present only when ORG_SCOPING_ENABLED resolves the
  // session through organization_memberships; absent on the legacy global path.
  /** The server-verified active org. permissions/allowedViews/role reflect this org only. */
  activeOrgId?: string;
  memberships?: OrgMembershipSummary[];
  /** Dashboard role for the active org (or 'owner' for staff). */
  role?: DashboardRole;
  /** Cross-org superuser from the STAFF_USER_IDS allowlist — never derived from permissions. */
  isStaff?: boolean;
}
