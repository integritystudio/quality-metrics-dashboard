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

/** Alias of RoleViewType — unified single source of truth for view names. */
export type DashboardView = RoleViewType;

export interface AppSession {
  authUserId: string;
  appUserId: string;
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: DashboardView[];
}
