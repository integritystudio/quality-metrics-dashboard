const ADMIN_PATH = '/admin';
const ADMIN_CUSTOMERS_PATH = `${ADMIN_PATH}/customers`;
/** The hub's query key for the org to reselect on return (Flutter's `DashboardArgs.initialOrgId`). */
export const ADMIN_CUSTOMERS_ORG_PARAM = 'org';

export const routes = {
  agentSession: (sessionId: string, agentId?: string) =>
    agentId
      ? `/agents/${encodeURIComponent(sessionId)}?agent=${encodeURIComponent(agentId)}`
      : `/agents/${encodeURIComponent(sessionId)}`,
  evaluationDetail: (traceId: string, metric?: string) =>
    metric
      ? `/evaluations/trace/${traceId}?metric=${encodeURIComponent(metric)}`
      : `/evaluations/trace/${traceId}`,
  session: (sessionId: string) => `/sessions/${sessionId}`,
  trace: (traceId: string) => `/traces/${traceId}`,
  workflow: (sessionId: string) => `/workflows/${encodeURIComponent(sessionId)}`,
  admin: () => ADMIN_PATH,
  /** The admin customer hub; with an org id, the hub selects that org once the directory loads. */
  adminCustomers: (orgId?: string) =>
    orgId
      ? `${ADMIN_CUSTOMERS_PATH}?${ADMIN_CUSTOMERS_ORG_PARAM}=${encodeURIComponent(orgId)}`
      : ADMIN_CUSTOMERS_PATH,
  adminCustomerBilling: (orgId: string) => `${ADMIN_CUSTOMERS_PATH}/${encodeURIComponent(orgId)}/billing`,
  adminCustomerUsage: (orgId: string) => `${ADMIN_CUSTOMERS_PATH}/${encodeURIComponent(orgId)}/usage`,
  adminCustomerQuota: (orgId: string) => `${ADMIN_CUSTOMERS_PATH}/${encodeURIComponent(orgId)}/quota`,
  adminCustomerEntitlements: (orgId: string) => `${ADMIN_CUSTOMERS_PATH}/${encodeURIComponent(orgId)}/entitlements`,
} as const;
