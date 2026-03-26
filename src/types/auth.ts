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

export interface AppSession {
  /** Server-side only. Not populated on the client — /api/me never returns internal IDs. */
  authUserId?: string;
  /** Server-side only. Not populated on the client — /api/me never returns internal IDs. */
  appUserId?: string;
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: DashboardView[];
}
