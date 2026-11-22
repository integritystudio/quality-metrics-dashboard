import { useState, useCallback, useEffect, Suspense, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Route, Switch, Link, useLocation, Router, type StringRouteParams } from 'wouter';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Layout } from './components/Layout.js';
import { RoleSelector } from './components/RoleSelector.js';
import { KeyboardNavProvider, Shortcut, SHORTCUT_SCOPE } from './contexts/KeyboardNavContext.js';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { OrgProvider } from './contexts/OrgContext.js';
import { OrgSwitcher } from './components/OrgSwitcher.js';
import { Auth0Provider, useAuth0, AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE, AUTH0_CALLBACK_URI, AUTH0_LOGIN_PARAMS, safeReturnTo } from './lib/auth0.js';
import { RequireAuth } from './components/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { HealthOverview } from './components/HealthOverview.js';
import { MetricGrid, MetricGridSkeleton } from './components/MetricGrid.js';
import { AlertList } from './components/AlertList.js';
import { SLATable } from './components/SLATable.js';
import { ScoreHistogram } from './components/ScoreHistogram.js';
import { EvaluationDetail } from './components/EvaluationDetail.js';
import type { EvalRow } from './components/EvaluationTable.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './components/Indicators.js';
import { ConfidencePanel } from './components/ConfidencePanel.js';
import { ViewSection } from './components/Section.js';
import { CoveragePage } from './pages/CoveragePage.js';
import { PipelinePage } from './pages/PipelinePage.js';
import { QualityLivePage } from './pages/QualityLivePage.js';
import { EvaluationDetailPage } from './pages/EvaluationDetailPage.js';
import { CompliancePage } from './pages/CompliancePage.js';
import { TraceDetailPage } from './pages/TraceDetailPage.js';
import { AgentSessionPage } from './pages/AgentSessionPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AccessDenied, StaffGuard, StaffCustomersLink } from './components/StaffGuard.js';
import { RoutingTelemetryPage } from './pages/RoutingTelemetryPage.js';
import { DegradationSignalsPage } from './pages/DegradationSignalsPage.js';
import { AgentCodeQualityPage } from './pages/AgentCodeQualityPage.js';
import { ExecutiveView } from './components/views/ExecutiveView.js';
import { OperatorView } from './components/views/OperatorView.js';
import { AuditorView } from './components/views/AuditorView.js';
import { formatScore } from './lib/quality-utils.js';
import { useDashboard, isNoDataSummary } from './hooks/useDashboard.js';
import { useMetricDetail } from './hooks/useMetricDetail.js';
import { useTrend } from './hooks/useTrend.js';
import { CalibrationProvider } from './contexts/CalibrationContext.js';
import { INITIAL_PERIOD } from './lib/periods.js';
import { ROUTE_PATHS, ROUTE_PATTERNS, routes } from './lib/routes.js';
import { ROLES } from './lib/roles.js';
import { lazyWithReload, retryFailedLazyLoads } from './lib/lazy-with-reload.js';
import type {
  Period,
  QualityDashboardSummary,
  RoleView,
  RoleViewType,
  MetricDetailResult,
  MetricDynamics,
} from './types.js';

// recharts is the entry chunk's largest dependency, so everything that draws a chart loads on demand.
const TrendChart = lazyWithReload(async () => import('./components/TrendChart.js').then(m => ({ default: m.TrendChart })));
const TrendSeries = lazyWithReload(async () => import('./components/TrendSeries.js').then(m => ({ default: m.TrendSeries })));
const CorrelationsPage = lazyWithReload(async () => import('./pages/CorrelationsPage.js').then(m => ({ default: m.CorrelationsPage })));

const WorkflowPage = lazyWithReload(async () => import('./pages/WorkflowPage.js').then(m => ({ default: m.WorkflowPage })));

// The admin customer view is staff-only, so its five screens load on demand.
const AdminCustomerHubPage = lazyWithReload(async () => import('./pages/admin-customer/AdminCustomerHubPage.js').then(m => ({ default: m.AdminCustomerHubPage })));
const AdminCustomerBillingPage = lazyWithReload(async () => import('./pages/admin-customer/AdminCustomerBillingPage.js').then(m => ({ default: m.AdminCustomerBillingPage })));
const AdminCustomerUsagePage = lazyWithReload(async () => import('./pages/admin-customer/AdminCustomerUsagePage.js').then(m => ({ default: m.AdminCustomerUsagePage })));
const AdminCustomerQuotaPage = lazyWithReload(async () => import('./pages/admin-customer/AdminCustomerQuotaPage.js').then(m => ({ default: m.AdminCustomerQuotaPage })));
const AdminCustomerEntitlementsPage = lazyWithReload(async () => import('./pages/admin-customer/AdminCustomerEntitlementsPage.js').then(m => ({ default: m.AdminCustomerEntitlementsPage })));

type SkeletonSize = 'chart' | 'md' | 'xl';

/** Loading placeholder; `card` gives it a card's frame when nothing encloses it. */
function Skeleton({ size, card = false }: { size: SkeletonSize; card?: boolean }) {
  return <div className={`${card ? 'card ' : ''}skeleton skeleton-${size}`} />;
}

const VALID_ROLES: readonly RoleViewType[] = ROLES;

/** What an org with nothing synced yet sees, on the summary and on every role view. */
function NoEvaluationData() {
  return (
    <div className="empty-state">
      <h2>No Evaluation Data</h2>
      <p>No evaluations found for the selected period.</p>
      <p className="mt-2">
        Run evaluations using the <code>obs_inject_evaluations</code> tool to see metrics here.
      </p>
    </div>
  );
}

function DashboardPage({ period }: { period: Period }) {
  const { data, isLoading, isFetching, error } = useDashboard(period);

  if (isLoading) return <MetricGridSkeleton />;
  if (error && !data) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;

  if (!data || ('role' in data)) return <MetricGridSkeleton />;
  const dashboard = data;
  const sparklines = (data as QualityDashboardSummary & { sparklines?: Record<string, Array<number | null>> }).sparklines;

  if (dashboard.overallStatus === 'no_data') return <NoEvaluationData />;

  return (
    <>
      {isFetching && <div className="refetch-indicator surface-elevated">Updating...</div>}
      <HealthOverview dashboard={dashboard} />
      <MetricGrid metrics={dashboard.metrics} sparklines={sparklines} />
      {dashboard.alerts.length > 0 && (
        <ViewSection title="Active Alerts">
          <AlertList alerts={dashboard.alerts} />
        </ViewSection>
      )}
      {dashboard.slaCompliance && dashboard.slaCompliance.length > 0 && (
        <ViewSection title="SLA Compliance">
          <SLATable slas={dashboard.slaCompliance} />
        </ViewSection>
      )}
    </>
  );
}

/** Dispatch on the role discriminant; a role with no view renders nothing. */
function RoleDashboard({ data }: { data: RoleView }): ReactNode {
  switch (data.role) {
    case 'executive':
      return <ExecutiveView data={data} />;
    case 'operator':
      return <OperatorView data={data} />;
    case 'auditor':
      return <AuditorView data={data} />;
    default:
      return null;
  }
}

export function RolePage({ role, period }: { role: RoleViewType; period: Period }) {
  const { session, isLoading: authLoading } = useAuth();
  const { data, isLoading, error } = useDashboard(period, role);

  if (authLoading) return <MetricGridSkeleton />;
  if (!session?.allowedViews.includes(role)) {
    return (
      <div className="empty-state">
        <h2>Access Denied</h2>
        <p>You do not have permission to view the {role} dashboard.</p>
        <p><Link href="/">Go to dashboard</Link></p>
      </div>
    );
  }

  if (isLoading) return <MetricGridSkeleton />;
  if (error && !data) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;
  // A new org's no-data answer is summary-shaped; without this it fell through to
  // the skeleton below and loaded forever.
  if (data && isNoDataSummary(data)) return <NoEvaluationData />;
  if (!data || !('role' in data)) return <MetricGridSkeleton />;

  return <RoleDashboard data={data} />;
}

function snapshotToEvalRow(s: {
  // ISO string, not bigint: these arrive via JSON from KV, which cannot carry
  // a bigint at all. the KV sync Workflow now converts at write time (see
  // evaluationSnapshotSchema); this used to declare bigint and re-divide,
  // which could never have run against real KV data.
  timestamp: string;
  scoreValue: number;
  scoreLabel?: string | undefined;
  labelDerived?: boolean | undefined;
  evaluator?: string | undefined;
  sessionId?: string | undefined;
  traceId?: string | undefined;
  explanation?: string | undefined;
}): EvalRow {
  return {
    score: s.scoreValue,
    timestamp: s.timestamp,
    label: s.scoreLabel,
    labelDerived: s.labelDerived,
    evaluator: s.evaluator,
    sessionId: s.sessionId,
    traceId: s.traceId,
    explanation: s.explanation,
  };
}

function MetricDetailPage({ name, period }: { name: string; period: Period }) {
  const { data, isLoading, error } = useMetricDetail(name, period);
  const { data: trendData } = useTrend(name, period);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>
        <Skeleton card size="md" />
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      </div>
    );
  }

  if (!data) return null;
  const detail = data;

  return (
    <div>
      <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>
      <div className="card mb-6">
        <div className="metric-card-header flex-center">
          <h2 className="text-lg">{detail.displayName}</h2>
          <StatusBadge status={detail.status} />
        </div>
        <div className="flex-wrap gap-8 mt-3">
          {(['avg', 'min', 'max', 'p50', 'p95', 'p99'] as const)
            .filter((key) => detail.values[key] != null)
            .map((key) => (
              <div key={key} className="text-center">
                <div className="mono-xl font-semibold">
                  {formatScore(detail.values[key])}
                </div>
                <div className="text-secondary text-xs uppercase">{key}</div>
              </div>
            ))}
          <div className="text-center">
            <div className="mono-xl font-semibold">{detail.sampleCount}</div>
            <div className="text-secondary text-xs uppercase">samples</div>
          </div>
        </div>
        <div className="flex-center gap-4 mt-3">
          <TrendIndicator trend={detail.trend} />
          <ConfidenceBadge confidence={detail.confidence} />
        </div>
      </div>

      {detail.confidence && (
        <ViewSection title="Confidence Analysis">
          <div className="card">
            <ConfidencePanel confidence={detail.confidence} />
          </div>
        </ViewSection>
      )}

      <ViewSection title="Trend">
        <div className="card">
          <Suspense fallback={<Skeleton size="chart" />}>
            <TrendChart
              trend={detail.trend}
              dynamics={(detail as MetricDetailResult & { dynamics?: MetricDynamics }).dynamics}
              warningThreshold={detail.alerts.find(a => a.severity === 'warning')?.threshold}
              criticalThreshold={detail.alerts.find(a => a.severity === 'critical')?.threshold}
              metricName={detail.displayName}
            />
          </Suspense>
        </div>
      </ViewSection>

      {trendData && trendData.trendData.length > 0 && (
        <ViewSection title={<>
          Time Series ({trendData.totalEvaluations} evaluations)
          {trendData.narrowed && (
            <span className="text-muted text-xs font-normal ml-2">auto-narrowed to data range</span>
          )}
        </>}>
          <div className="card">
            <Suspense fallback={<Skeleton size="chart" />}>
              <TrendSeries data={trendData.trendData} metricName={detail.displayName} />
            </Suspense>
          </div>
        </ViewSection>
      )}

      {detail.alerts.length > 0 && (
        <ViewSection title="Alerts">
          <AlertList alerts={detail.alerts} />
        </ViewSection>
      )}

      <ViewSection title="Score Distribution">
        <div className="card">
          <ScoreHistogram distribution={detail.scoreDistribution} />
        </div>
      </ViewSection>

      <ViewSection title="Evaluations">
        <div className="card">
          <EvaluationDetail worst={detail.worstEvaluations.map(s => snapshotToEvalRow(s))} best={detail.bestEvaluations.map(s => snapshotToEvalRow(s))} metricName={name} period={period} />
        </div>
      </ViewSection>
    </div>
  );
}

function RouteErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="error-state">
      <h2>Something went wrong</h2>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <div className="error-actions">
        <button onClick={resetErrorBoundary}>Try again</button>
        <Link href="/">Back to dashboard</Link>
      </div>
    </div>
  );
}

/** Per-route error boundary; resets when the location changes. */
function RouteBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]} onReset={retryFailedLazyLoads}>{children}</ErrorBoundary>;
}

/** The admin customer screens: staff only, loaded on demand. */
function StaffRoute({ children }: { children: ReactNode }) {
  return (
    <RouteBoundary>
      <StaffGuard>
        <Suspense fallback={<Skeleton card size="md" />}>{children}</Suspense>
      </StaffGuard>
    </RouteBoundary>
  );
}

function AdminLink() {
  const { session } = useAuth();
  if (!session?.permissions.includes('dashboard.admin')) return null;
  return <Link href={routes.admin()} className="admin-link text-xs text-muted">Admin</Link>;
}

function AdminGuard({ children }: { children: ReactNode }) {
  const { session, isLoading } = useAuth();
  if (isLoading) return null;
  if (!session?.permissions.includes('dashboard.admin')) return <AccessDenied />;
  return <>{children}</>;
}

const PERIOD_SHORTCUTS: ReadonlyArray<{ key: string; period: Period }> = [
  { key: '1', period: '24h' },
  { key: '2', period: '7d' },
  { key: '3', period: '30d' },
];

const NAVIGATION_SHORTCUTS: ReadonlyArray<{ key: string; destination: string; path: string }> = [
  { key: 'g h', destination: 'home', path: ROUTE_PATHS.home },
  { key: 'g c', destination: 'correlations', path: ROUTE_PATHS.correlations },
  { key: 'g p', destination: 'pipeline', path: ROUTE_PATHS.pipeline },
  { key: 'g v', destination: 'coverage', path: ROUTE_PATHS.coverage },
  { key: 'g a', destination: 'agents', path: ROUTE_PATHS.agents },
  { key: 'g r', destination: 'routing telemetry', path: ROUTE_PATHS.routingTelemetry },
  { key: 'g d', destination: 'degradation signals', path: ROUTE_PATHS.degradationSignals },
  { key: 'g q', destination: 'code quality', path: ROUTE_PATHS.codeQuality },
];

function GlobalShortcuts({ setPeriod, navigate }: {
  setPeriod: (p: Period) => void;
  navigate: (path: string) => void;
}) {
  return (
    <>
      {PERIOD_SHORTCUTS.map(({ key, period }) => (
        <Shortcut key={key} shortcutKey={key} description={`Switch to ${period}`} scope={SHORTCUT_SCOPE.PERIOD} action={() => setPeriod(period)} />
      ))}
      {NAVIGATION_SHORTCUTS.map(({ key, destination, path }) => (
        <Shortcut key={key} shortcutKey={key} description={`Go to ${destination}`} scope={SHORTCUT_SCOPE.NAVIGATION} action={() => navigate(path)} />
      ))}
    </>
  );
}

function UnknownRole() {
  return <div className="empty-state"><h2>Unknown Role</h2><p><Link href={ROUTE_PATHS.home}>Go to dashboard</Link></p></div>;
}

type RouteFrame = ComponentType<{ children: ReactNode }>;

/**
 * One authenticated route: its page inside `Frame`, and inside a Suspense when the page is
 * lazy. The pattern stays a literal type, so `render` receives that pattern's own params.
 */
function appRoute<P extends string>(
  path: P,
  render: (params: StringRouteParams<P>, period: Period) => ReactNode,
  { lazy, Frame = RouteBoundary }: { lazy?: SkeletonSize; Frame?: RouteFrame } = {},
): (period: Period) => ReactElement {
  return (period) => (
    <Route key={path} path={path}>
      {(params) => {
        // wouter types these params with a conditional on P that stays unresolved while P is generic.
        const page = render(params as StringRouteParams<P>, period);
        return <Frame>{lazy ? <Suspense fallback={<Skeleton card size={lazy} />}>{page}</Suspense> : page}</Frame>;
      }}
    </Route>
  );
}

/** Matched in order by the Switch in `App`. */
const APP_ROUTES = [
  appRoute(ROUTE_PATHS.home, (_params, period) => <DashboardPage period={period} />),
  appRoute(ROUTE_PATTERNS.role, (params, period) => {
    const role = VALID_ROLES.find(r => r === params.roleName);
    return role ? <RolePage role={role} period={period} /> : <UnknownRole />;
  }),
  appRoute(ROUTE_PATTERNS.metric, (params, period) => <MetricDetailPage name={params.metricName} period={period} />),
  appRoute(ROUTE_PATTERNS.evaluationDetail, (params) => <EvaluationDetailPage traceId={params.traceId} />),
  appRoute(ROUTE_PATHS.correlations, (_params, period) => <CorrelationsPage period={period} />, { lazy: 'md' }),
  appRoute(ROUTE_PATHS.coverage, (_params, period) => <CoveragePage period={period} />),
  appRoute(ROUTE_PATHS.pipeline, (_params, period) => <PipelinePage period={period} />),
  appRoute(ROUTE_PATHS.qualityLive, () => <QualityLivePage />),
  appRoute(ROUTE_PATHS.compliance, (_params, period) => <CompliancePage period={period} />),
  appRoute(ROUTE_PATHS.agents, (_params, period) => <AgentsPage period={period} />),
  appRoute(ROUTE_PATTERNS.trace, (params) => <TraceDetailPage traceId={params.traceId} />),
  appRoute(ROUTE_PATTERNS.agentSession, (params) => <AgentSessionPage sessionId={params.sessionId} />),
  appRoute(ROUTE_PATTERNS.session, (params) => <SessionDetailPage sessionId={params.sessionId} />),
  appRoute(ROUTE_PATTERNS.workflow, (params) => <WorkflowPage sessionId={params.sessionId} />, { lazy: 'xl' }),
  appRoute(ROUTE_PATHS.routingTelemetry, (_params, period) => <RoutingTelemetryPage period={period} />),
  appRoute(ROUTE_PATHS.degradationSignals, (_params, period) => <DegradationSignalsPage period={period} />),
  appRoute(ROUTE_PATHS.codeQuality, () => <AgentCodeQualityPage />),
  appRoute(ROUTE_PATHS.admin, () => <AdminGuard><AdminPage /></AdminGuard>),
  appRoute(ROUTE_PATHS.adminCustomers, () => <AdminCustomerHubPage />, { Frame: StaffRoute }),
  appRoute(ROUTE_PATTERNS.adminCustomerBilling, (params) => <AdminCustomerBillingPage orgId={params.orgId} />, { Frame: StaffRoute }),
  appRoute(ROUTE_PATTERNS.adminCustomerUsage, (params) => <AdminCustomerUsagePage orgId={params.orgId} />, { Frame: StaffRoute }),
  appRoute(ROUTE_PATTERNS.adminCustomerQuota, (params) => <AdminCustomerQuotaPage orgId={params.orgId} />, { Frame: StaffRoute }),
  appRoute(ROUTE_PATTERNS.adminCustomerEntitlements, (params) => <AdminCustomerEntitlementsPage orgId={params.orgId} />, { Frame: StaffRoute }),
];

function CallbackHandler() {
  const { isLoading, isAuthenticated, loginWithRedirect, error } = useAuth0();
  const [, navigate] = useLocation();

  useEffect(() => {
    // An Auth0 error (access_denied, user cancelled, …) leaves
    // isAuthenticated false; auto-retrying here bounced the browser between
    // /callback and Auth0 forever. Errors render the retry UI below instead.
    if (isLoading || error) return;
    if (isAuthenticated) {
      // Fallback for direct /callback visits; the post-login deep-link
      // restore happens in Auth0Provider's onRedirectCallback.
      navigate('/');
    } else {
      void loginWithRedirect({ authorizationParams: AUTH0_LOGIN_PARAMS });
    }
  }, [isLoading, isAuthenticated, error, loginWithRedirect, navigate]);

  if (error) {
    return (
      <div className="empty-state">
        <h2>Sign-in failed</h2>
        <p>{error.message}</p>
        <p>
          <button
            type="button"
            className="btn-xs"
            onClick={() => void loginWithRedirect({ authorizationParams: AUTH0_LOGIN_PARAMS })}
          >
            Try again
          </button>
        </p>
      </div>
    );
  }

  return <div className="auth-loading" role="status" aria-label="Loading" />;
}

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') || '';

export function App() {
  const [period, setPeriod] = useState<Period>(INITIAL_PERIOD);
  const [, navigate] = useLocation();

  // Restore the deep link LoginPage carried through Auth0 as
  // appState.returnTo; without this the code exchange always landed on '/'.
  const onRedirectCallback = useCallback(
    (appState?: { returnTo?: string }) => navigate(safeReturnTo(appState?.returnTo)),
    [navigate],
  );

  return (
    <Router base={BASE_PATH}>
      <Auth0Provider
        onRedirectCallback={onRedirectCallback}
        domain={AUTH0_DOMAIN}
        clientId={AUTH0_CLIENT_ID}
        authorizationParams={{
          redirect_uri: AUTH0_CALLBACK_URI,
          audience: AUTH0_AUDIENCE,
        }}
        // Rotating refresh tokens persisted across reloads. Without these the
        // SDK's memory cache is wiped on every hard reload and recovery is
        // iframe silent auth against the third-party Auth0 domain — which
        // fails wherever third-party cookies are blocked, forcing a full
        // login→callback redirect cycle per reload and per 2h token expiry.
        // Requires allow_offline_access on the Auth0 resource server (set on
        // both tenants 2026-08-22) and rotating refresh tokens on the SPA
        // client. Production had that; the dev client did not until
        // 2026-10-06, and the first browser sign-in there failed the code
        // exchange with "Failed to exchange a Rotating Refresh Token when
        // Refresh Token Rotation is not enabled" (surfaced as "Unknown or
        // invalid refresh token"). Auth0 issues no refresh token to a public
        // client without rotation, so this flag needs it on every tenant.
        useRefreshTokens
        cacheLocation="localstorage"
      >
        <AuthProvider>
          <OrgProvider>
            <KeyboardNavProvider>
              <CalibrationProvider>
                <GlobalShortcuts setPeriod={setPeriod} navigate={navigate} />
                <Switch>
                  <Route path={ROUTE_PATHS.login}>
                    <LoginPage />
                  </Route>
                  <Route path={ROUTE_PATHS.callback}>
                    <CallbackHandler />
                  </Route>
                  <RequireAuth>
                    <Layout period={period} onPeriodChange={setPeriod}>
                      <RoleSelector />
                      <OrgSwitcher />
                      <AdminLink />
                      <StaffCustomersLink />
                      <Switch>
                        {APP_ROUTES.map(route => route(period))}
                        <Route>
                          <div className="empty-state">
                            <h2>Page Not Found</h2>
                            <p><Link href="/">Go to dashboard</Link></p>
                          </div>
                        </Route>
                      </Switch>
                    </Layout>
                  </RequireAuth>
                </Switch>
              </CalibrationProvider>
            </KeyboardNavProvider>
          </OrgProvider>
        </AuthProvider>
      </Auth0Provider>
    </Router>
  );
}
