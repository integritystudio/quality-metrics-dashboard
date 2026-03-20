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

export interface AppSession {
  authUserId: string;
  appUserId: string;
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
}

export type DashboardView = 'executive' | 'operator' | 'auditor';

export interface MeResponse {
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: DashboardView[];
}
