/**
 * Org-scoped RBAC mapping — the single runtime source of truth for deriving
 * dashboard permissions from an organization_memberships.role
 * (docs/roadmap/org-scoped-multi-tenancy.md § Auth model, P5).
 *
 * Worker-safe: no import.meta.env, no Vite constants — importable by
 * worker/index.ts, the API server, and the frontend alike (like roles.ts).
 *
 * Permissions derive ONLY from the membership role of the ACTIVE org — never
 * from a legacy user_roles role name — so the retired
 * `provisioned-dashboard-viewer` grant is inert under org scoping.
 */

import type {
  DashboardPermission,
  DashboardRole,
  DashboardView,
  OrgMembershipRole,
} from '../types/auth.js';

export const DASHBOARD_ROLE_BY_MEMBERSHIP: Record<OrgMembershipRole, DashboardRole> = {
  owner: 'owner',
  admin: 'admin',
  billing_admin: 'admin',
  member: 'read',
  viewer: 'e2e-dashboard-reader',
};

/**
 * The permission strings, named once. Every route guard and every role list
 * below reaches them through this map rather than respelling the literal.
 */
export const PERMISSION = {
  read: 'dashboard.read',
  executive: 'dashboard.executive',
  operator: 'dashboard.operator',
  auditor: 'dashboard.auditor',
  traces: 'dashboard.traces.read',
  sessions: 'dashboard.sessions.read',
  agents: 'dashboard.agents.read',
  pipeline: 'dashboard.pipeline.read',
  compliance: 'dashboard.compliance.read',
  admin: 'dashboard.admin',
} as const satisfies Record<string, DashboardPermission>;

/** The permission that grants each view. */
const VIEW_PERMISSIONS: ReadonlyArray<readonly [DashboardPermission, DashboardView]> = [
  [PERMISSION.executive, 'executive'],
  [PERMISSION.operator, 'operator'],
  [PERMISSION.auditor, 'auditor'],
];

/**
 * The view-tab permissions, taken from the view map rather than respelled, so a
 * role granting a tab and `viewsForPermissions` resolving it cannot drift apart.
 */
const VIEW_TAB_READS: readonly DashboardPermission[] = VIEW_PERMISSIONS.map(([permission]) => permission);

/** The per-route data reads every role above `read` holds. */
const DATA_READS: readonly DashboardPermission[] = [
  PERMISSION.traces,
  PERMISSION.sessions,
  PERMISSION.agents,
  PERMISSION.pipeline,
  PERMISSION.compliance,
];

export const PERMISSIONS_BY_DASHBOARD_ROLE: Record<DashboardRole, readonly DashboardPermission[]> = {
  owner: [PERMISSION.read, ...VIEW_TAB_READS, ...DATA_READS, PERMISSION.admin],
  // Deliberately NO executive/operator/auditor: org admin gets the admin panel
  // plus all data reads, but no exec/operator/auditor tabs (spec-intentional —
  // the `dashboard.admin ? all views` shortcut does not apply on the org path).
  admin: [PERMISSION.read, ...DATA_READS, PERMISSION.admin],
  read: [PERMISSION.read],
  'e2e-dashboard-reader': [PERMISSION.read, ...VIEW_TAB_READS, ...DATA_READS],
};

/**
 * Derive allowedViews strictly by filtering the view map against the permission
 * set — no dashboard.admin shortcut. Under org scoping an org `admin` therefore
 * gets `[]` views while retaining data-route access via hasPermission.
 */
export function viewsForPermissions(permissions: readonly DashboardPermission[]): DashboardView[] {
  const set = new Set(permissions);
  return VIEW_PERMISSIONS.filter(([perm]) => set.has(perm)).map(([, view]) => view);
}

export function isOrgMembershipRole(value: string): value is OrgMembershipRole {
  return value in DASHBOARD_ROLE_BY_MEMBERSHIP;
}
