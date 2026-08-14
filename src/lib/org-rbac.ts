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

export const PERMISSIONS_BY_DASHBOARD_ROLE: Record<DashboardRole, readonly DashboardPermission[]> = {
  owner: [
    'dashboard.read',
    'dashboard.executive',
    'dashboard.operator',
    'dashboard.auditor',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
    'dashboard.admin',
  ],
  // Deliberately NO executive/operator/auditor: org admin gets the admin panel
  // plus all data reads, but no exec/operator/auditor tabs (spec-intentional —
  // the `dashboard.admin ? all views` shortcut does not apply on the org path).
  admin: [
    'dashboard.read',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
    'dashboard.admin',
  ],
  read: ['dashboard.read'],
  'e2e-dashboard-reader': [
    'dashboard.read',
    'dashboard.executive',
    'dashboard.operator',
    'dashboard.auditor',
    'dashboard.traces.read',
    'dashboard.sessions.read',
    'dashboard.agents.read',
    'dashboard.pipeline.read',
    'dashboard.compliance.read',
  ],
};

/** View-permission pairs — mirrors the worker's VIEW_PERMISSION_MAP. */
const VIEW_PERMISSIONS: ReadonlyArray<readonly [DashboardPermission, DashboardView]> = [
  ['dashboard.executive', 'executive'],
  ['dashboard.operator', 'operator'],
  ['dashboard.auditor', 'auditor'],
];

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
