import { useState, useCallback, useEffect, Suspense, type ReactNode } from 'react';
import { Route, Switch, Link, useLocation, Router } from 'wouter';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Layout } from './components/Layout.js';
import { RoleSelector } from './components/RoleSelector.js';
import { KeyboardNavProvider, useShortcut } from './contexts/KeyboardNavContext.js';
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
import { TrendChart } from './components/TrendChart.js';
import { TrendSeries } from './components/TrendSeries.js';
import { ConfidencePanel } from './components/ConfidencePanel.js';
import { ViewSection } from './components/Section.js';
import { CorrelationsPage } from './pages/CorrelationsPage.js';
import { CoveragePage } from './pages/CoveragePage.js';
import { PipelinePage } from './pages/PipelinePage.js';
import { EvaluationDetailPage } from './pages/EvaluationDetailPage.js';
import { CompliancePage } from './pages/CompliancePage.js';
import { TraceDetailPage } from './pages/TraceDetailPage.js';
import { AgentSessionPage } from './pages/AgentSessionPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { StaffGuard, StaffCustomersLink } from './components/StaffGuard.js';
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
import { RoleProvider } from './contexts/RoleContext.js';
import { CalibrationProvider } from './contexts/CalibrationContext.js';
import { ROLES } from './lib/constants.js';
import { lazyWithReload } from './lib/lazy-with-reload.js';
import type {
  Period,
  QualityDashboardSummary,
  RoleViewType,
  MetricDetailResult,
  MetricDynamics,
} from './types.js';

const WorkflowPage = lazyWithReload(() => import('./pages/WorkflowPage.js').then(m => ({ default: m.WorkflowPage })));

// The admin customer view is staff-only, so its five screens load on demand.
const AdminCustomerHubPage = lazyWithReload(() => import('./pages/admin-customer/AdminCustomerHubPage.js').then(m => ({ default: m.AdminCustomerHubPage })));
const AdminCustomerBillingPage = lazyWithReload(() => import('./pages/admin-customer/AdminCustomerBillingPage.js').then(m => ({ default: m.AdminCustomerBillingPage })));
const AdminCustomerUsagePage = lazyWithReload(() => import('./pages/admin-customer/AdminCustomerUsagePage.js').then(m => ({ default: m.AdminCustomerUsagePage })));
const AdminCustomerQuotaPage = lazyWithReload(() => import('./pages/admin-customer/AdminCustomerQuotaPage.js').then(m => ({ default: m.AdminCustomerQuotaPage })));
const AdminCustomerEntitlementsPage = lazyWithReload(() => import('./pages/admin-customer/AdminCustomerEntitlementsPage.js').then(m => ({ default: m.AdminCustomerEntitlementsPage })));

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
  const sparklines = (data as QualityDashboardSummary & { sparklines?: Record<string, (number | null)[]> }).sparklines;

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

function snapshotToEvalRow(s: {
  // ISO string, not bigint: these arrive via JSON from KV, which cannot carry
  // a bigint at all. sync-to-kv now converts at write time (see
  // evaluationSnapshotSchema); this used to declare bigint and re-divide,
  // which could never have run against real KV data.
  timestamp: string;
  scoreValue: number;
  scoreLabel?: string;
  labelDerived?: boolean;
  evaluator?: string;
  sessionId?: string;
  traceId?: string;
  explanation?: string;
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
  const { data: trendData } = useTrend(name, period, 10);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>
        <div className="card skeleton skeleton-md" />
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
          <TrendChart
            trend={detail.trend}
            dynamics={(detail as MetricDetailResult & { dynamics?: MetricDynamics }).dynamics}
            warningThreshold={detail.alerts.find(a => a.severity === 'warning')?.threshold}
            criticalThreshold={detail.alerts.find(a => a.severity === 'critical')?.threshold}
            metricName={detail.displayName}
          />
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
            <TrendSeries data={trendData.trendData} metricName={detail.displayName} />
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
          <EvaluationDetail worst={detail.worstEvaluations.map(snapshotToEvalRow)} best={detail.bestEvaluations.map(snapshotToEvalRow)} metricName={name} period={period} />
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
  return <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>{children}</ErrorBoundary>;
}

/** The admin customer screens: staff only, loaded on demand. */
function StaffRoute({ children }: { children: ReactNode }) {
  return (
    <RouteBoundary>
      <StaffGuard>
        <Suspense fallback={<div className="card skeleton skeleton-md" />}>{children}</Suspense>
      </StaffGuard>
    </RouteBoundary>
  );
}

function AdminLink() {
  const { session } = useAuth();
  if (!session?.permissions.includes('dashboard.admin')) return null;
  return <Link href="/admin" className="admin-link text-xs text-muted">Admin</Link>;
}

function AdminGuard({ children }: { children: ReactNode }) {
  const { session, isLoading } = useAuth();
  if (isLoading) return null;
  if (!session?.permissions.includes('dashboard.admin')) {
    return (
      <div className="empty-state">
        <h2>Access Denied</h2>
        <p>You do not have permission to access this page.</p>
        <p><Link href="/">Go to dashboard</Link></p>
      </div>
    );
  }
  return <>{children}</>;
}

function GlobalShortcuts({ setPeriod, navigate }: {
  setPeriod: (p: Period) => void;
  navigate: (path: string) => void;
}) {
  useShortcut('1', 'Switch to 24h', 'Period', useCallback(() => setPeriod('24h'), [setPeriod]));
  useShortcut('2', 'Switch to 7d', 'Period', useCallback(() => setPeriod('7d'), [setPeriod]));
  useShortcut('3', 'Switch to 30d', 'Period', useCallback(() => setPeriod('30d'), [setPeriod]));
  useShortcut('g h', 'Go to home', 'Navigation', useCallback(() => navigate('/'), [navigate]));
  useShortcut('g c', 'Go to correlations', 'Navigation', useCallback(() => navigate('/correlations'), [navigate]));
  useShortcut('g p', 'Go to pipeline', 'Navigation', useCallback(() => navigate('/pipeline'), [navigate]));
  useShortcut('g v', 'Go to coverage', 'Navigation', useCallback(() => navigate('/coverage'), [navigate]));
  useShortcut('g a', 'Go to agents', 'Navigation', useCallback(() => navigate('/agents'), [navigate]));
  useShortcut('g r', 'Go to routing telemetry', 'Navigation', useCallback(() => navigate('/routing-telemetry'), [navigate]));
  useShortcut('g d', 'Go to degradation signals', 'Navigation', useCallback(() => navigate('/degradation-signals'), [navigate]));
  useShortcut('g q', 'Go to code quality', 'Navigation', useCallback(() => navigate('/code-quality'), [navigate]));
  return null;
}

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
  const [period, setPeriod] = useState<Period>('30d');
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
          <RoleProvider>
            <CalibrationProvider>
              <GlobalShortcuts setPeriod={setPeriod} navigate={navigate} />
              <Switch>
                <Route path="/login">
                  <LoginPage />
                </Route>
                <Route path="/callback">
                  <CallbackHandler />
                </Route>
                <RequireAuth>
                  <Layout period={period} onPeriodChange={setPeriod}>
                    <RoleSelector />
                    <OrgSwitcher />
                    <AdminLink />
                    <StaffCustomersLink />
                    <Switch>
                      <Route path="/">
                        <RouteBoundary>
                          <DashboardPage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/role/:roleName">
                        {(params) => {
                          const role = VALID_ROLES.find(r => r === params.roleName);
                          if (!role) return <div className="empty-state"><h2>Unknown Role</h2><p><Link href="/">Go to dashboard</Link></p></div>;
                          return (
                            <RouteBoundary>
                              <RolePage role={role} period={period} />
                            </RouteBoundary>
                          );
                        }}
                      </Route>
                      <Route path="/metrics/:metricName">
                        {(params) => (
                          <RouteBoundary>
                            <MetricDetailPage name={params.metricName} period={period} />
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/evaluations/trace/:traceId">
                        {(params) => (
                          <RouteBoundary>
                            <EvaluationDetailPage traceId={params.traceId} />
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/correlations">
                        <RouteBoundary>
                          <CorrelationsPage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/coverage">
                        <RouteBoundary>
                          <CoveragePage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/pipeline">
                        <RouteBoundary>
                          <PipelinePage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/compliance">
                        <RouteBoundary>
                          <CompliancePage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/agents">
                        <RouteBoundary>
                          <AgentsPage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/traces/:traceId">
                        {(params) => (
                          <RouteBoundary>
                            <TraceDetailPage traceId={params.traceId} />
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/agents/:sessionId">
                        {(params) => (
                          <RouteBoundary>
                            <AgentSessionPage sessionId={params.sessionId} />
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/sessions/:sessionId">
                        {(params) => (
                          <RouteBoundary>
                            <SessionDetailPage sessionId={params.sessionId} />
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/workflows/:sessionId">
                        {(params) => (
                          <RouteBoundary>
                            <Suspense fallback={<div className="card skeleton skeleton-xl" />}>
                              <WorkflowPage sessionId={params.sessionId} />
                            </Suspense>
                          </RouteBoundary>
                        )}
                      </Route>
                      <Route path="/routing-telemetry">
                        <RouteBoundary>
                          <RoutingTelemetryPage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/degradation-signals">
                        <RouteBoundary>
                          <DegradationSignalsPage period={period} />
                        </RouteBoundary>
                      </Route>
                      <Route path="/code-quality">
                        <RouteBoundary>
                          <AgentCodeQualityPage />
                        </RouteBoundary>
                      </Route>
                      <Route path="/admin">
                        <RouteBoundary>
                          <AdminGuard>
                            <AdminPage />
                          </AdminGuard>
                        </RouteBoundary>
                      </Route>
                      {/* The admin customer view: staff only, org id in the path (ADMIN-CV-LAYOUT-NAV). */}
                      <Route path="/admin/customers">
                        <StaffRoute><AdminCustomerHubPage /></StaffRoute>
                      </Route>
                      <Route path="/admin/customers/:orgId/billing">
                        {(params) => <StaffRoute><AdminCustomerBillingPage orgId={params.orgId} /></StaffRoute>}
                      </Route>
                      <Route path="/admin/customers/:orgId/usage">
                        {(params) => <StaffRoute><AdminCustomerUsagePage orgId={params.orgId} /></StaffRoute>}
                      </Route>
                      <Route path="/admin/customers/:orgId/quota">
                        {(params) => <StaffRoute><AdminCustomerQuotaPage orgId={params.orgId} /></StaffRoute>}
                      </Route>
                      <Route path="/admin/customers/:orgId/entitlements">
                        {(params) => <StaffRoute><AdminCustomerEntitlementsPage orgId={params.orgId} /></StaffRoute>}
                      </Route>
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
          </RoleProvider>
        </KeyboardNavProvider>
        </OrgProvider>
      </AuthProvider>
      </Auth0Provider>
    </Router>
  );
}
