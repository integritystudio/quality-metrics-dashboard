const ADMIN_PATH = '/admin';
const ADMIN_CUSTOMERS_PATH = `${ADMIN_PATH}/customers` as const;
const ADMIN_JUDGE_PATH = `${ADMIN_PATH}/judge` as const;
/** The hub's query key for the org to reselect on return (Flutter's `DashboardArgs.initialOrgId`). */
export const ADMIN_CUSTOMERS_ORG_PARAM = 'org';
/** The agent session page's query key for the agent to focus (a workflow graph node click). */
export const AGENT_SESSION_AGENT_PARAM = 'agent';

/** Paths with no parameter: the route pattern and the link are the same string. */
export const ROUTE_PATHS = {
  home: '/',
  login: '/login',
  callback: '/callback',
  correlations: '/correlations',
  coverage: '/coverage',
  pipeline: '/pipeline',
  qualityLive: '/quality-live',
  compliance: '/compliance',
  agents: '/agents',
  routingTelemetry: '/routing-telemetry',
  degradationSignals: '/degradation-signals',
  admin: ADMIN_PATH,
  adminCustomers: ADMIN_CUSTOMERS_PATH,
  adminJudge: ADMIN_JUDGE_PATH,
} as const;

/** Route patterns whose parameters the `routes` builders below fill in. */
export const ROUTE_PATTERNS = {
  role: '/role/:roleName',
  metric: '/metrics/:metricName',
  evaluationDetail: '/evaluations/trace/:traceId',
  trace: '/traces/:traceId',
  agentSession: '/agents/:sessionId',
  session: '/sessions/:sessionId',
  workflow: '/workflows/:sessionId',
  adminCustomerBilling: `${ADMIN_CUSTOMERS_PATH}/:orgId/billing`,
  adminCustomerUsage: `${ADMIN_CUSTOMERS_PATH}/:orgId/usage`,
  adminCustomerQuota: `${ADMIN_CUSTOMERS_PATH}/:orgId/quota`,
  adminCustomerEntitlements: `${ADMIN_CUSTOMERS_PATH}/:orgId/entitlements`,
} as const;

export const routes = {
  role: (role: string) => `/role/${role}`,
  metric: (name: string) => `/metrics/${name}`,
  agentSession: (sessionId: string, agentId?: string) =>
    agentId
      ? `/agents/${encodeURIComponent(sessionId)}?${AGENT_SESSION_AGENT_PARAM}=${encodeURIComponent(agentId)}`
      : `/agents/${encodeURIComponent(sessionId)}`,
  evaluationDetail: (traceId: string, metric?: string) =>
    metric
      ? `/evaluations/trace/${traceId}?metric=${encodeURIComponent(metric)}`
      : `/evaluations/trace/${traceId}`,
  session: (sessionId: string) => `/sessions/${sessionId}`,
  trace: (traceId: string) => `/traces/${traceId}`,
  workflow: (sessionId: string) => `/workflows/${encodeURIComponent(sessionId)}`,
  admin: () => ADMIN_PATH,
  adminJudge: () => ADMIN_JUDGE_PATH,
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
