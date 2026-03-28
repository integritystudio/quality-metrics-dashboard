import { useState, useCallback, useEffect, lazy, Suspense, type ReactNode } from 'react';
import { Route, Switch, Link, useLocation, Router } from 'wouter';
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary';
import { Layout } from './components/Layout.js';
import { RoleSelector } from './components/RoleSelector.js';
import { KeyboardNavProvider, useShortcut } from './contexts/KeyboardNavContext.js';
import { AuthProvider, useAuth } from './contexts/AuthContext.js';
import { Auth0Provider, useAuth0, AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE } from './lib/auth0.js';
import { RequireAuth } from './components/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { HealthOverview } from './components/HealthOverview.js';
import { MetricGrid, MetricGridSkeleton } from './components/MetricGrid.js';
import { AlertList } from './components/AlertList.js';
import { SLATable } from './components/SLATable.js';
import { ScoreHistogram } from './components/ScoreHistogram.js';
import { EvaluationDetail } from './components/EvaluationDetail.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './components/Indicators.js';
import { TrendChart } from './components/TrendChart.js';
import { TrendSeries } from './components/TrendSeries.js';
import { ConfidencePanel } from './components/ConfidencePanel.js';
import { ViewSection } from './components/Section.js';
import { CorrelationsPage } from './pages/CorrelationsPage.js';
import { PipelinePage } from './pages/PipelinePage.js';
import { EvaluationDetailPage } from './pages/EvaluationDetailPage.js';
import { CompliancePage } from './pages/CompliancePage.js';
import { TraceDetailPage } from './pages/TraceDetailPage.js';
import { AgentSessionPage } from './pages/AgentSessionPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { RoutingTelemetryPage } from './pages/RoutingTelemetryPage.js';
import { DegradationSignalsPage } from './pages/DegradationSignalsPage.js';
import { ExecutiveView } from './components/views/ExecutiveView.js';
import { OperatorView } from './components/views/OperatorView.js';
import { AuditorView } from './components/views/AuditorView.js';
import { formatScore } from './lib/quality-utils.js';
import { useDashboard } from './hooks/useDashboard.js';
import { useMetricDetail } from './hooks/useMetricDetail.js';
import { useTrend } from './hooks/useTrend.js';
import { RoleProvider } from './contexts/RoleContext.js';
import { CalibrationProvider } from './context/CalibrationContext.js';
import { ROLES } from './lib/constants.js';
import type {
  Period,
  QualityDashboardSummary,
  RoleViewType,
  MetricDetailResult,
  MetricDynamics,
} from './types.js';

const WorkflowPage = lazy(() => import('./pages/WorkflowPage.js').then(m => ({ default: m.WorkflowPage })));

const VALID_ROLES: readonly RoleViewType[] = ROLES;

function DashboardPage({ period }: { period: Period }) {
  const { data, isLoading, isFetching, error } = useDashboard(period);

  if (isLoading && !data) return <MetricGridSkeleton />;
  if (error && !data) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;

  if (!data || ('role' in data)) return <MetricGridSkeleton />;
  const dashboard = data;
  const sparklines = (data as QualityDashboardSummary & { sparklines?: Record<string, (number | null)[]> }).sparklines;

  if (dashboard.overallStatus === 'no_data') {
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

  return (
    <>
      {isFetching && data && <div className="refetch-indicator surface-elevated">Updating...</div>}
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

function RolePage({ role, period }: { role: RoleViewType; period: Period }) {
  const { session, isLoading: authLoading } = useAuth();
  const { data, isLoading, error } = useDashboard(period, role);

  if (authLoading) return <MetricGridSkeleton />;
  if (!session || !session.allowedViews.includes(role)) {
    return (
      <div className="empty-state">
        <h2>Access Denied</h2>
        <p>You do not have permission to view the {role} dashboard.</p>
        <p><Link href="/">Go to dashboard</Link></p>
      </div>
    );
  }

  if (isLoading && !data) return <MetricGridSkeleton />;
  if (error && !data) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;
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
          <EvaluationDetail worst={detail.worstEvaluations} best={detail.bestEvaluations} metricName={name} period={period} />
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
  // useShortcut('g v', 'Go to coverage', 'Navigation', useCallback(() => navigate('/coverage'), [navigate]));  // hidden until data compression
  useShortcut('g a', 'Go to agents', 'Navigation', useCallback(() => navigate('/agents'), [navigate]));
  useShortcut('g r', 'Go to routing telemetry', 'Navigation', useCallback(() => navigate('/routing-telemetry'), [navigate]));
  useShortcut('g d', 'Go to degradation signals', 'Navigation', useCallback(() => navigate('/degradation-signals'), [navigate]));
  return null;
}

function CallbackHandler() {
  const { isLoading, isAuthenticated, loginWithRedirect } = useAuth0();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) {
      navigate('/');
    } else {
      loginWithRedirect({
        authorizationParams: {
          audience: AUTH0_AUDIENCE,
          redirect_uri: `${window.location.origin}/callback`,
        },
      });
    }
  }, [isLoading, isAuthenticated, loginWithRedirect, navigate]);

  return <div className="auth-loading" role="status" aria-label="Loading" />;
}

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') || '';

export function App() {
  const [period, setPeriod] = useState<Period>('30d');
  const [location, navigate] = useLocation();

  return (
    <Router base={BASE_PATH}>
      <Auth0Provider
        domain={AUTH0_DOMAIN}
        clientId={AUTH0_CLIENT_ID}
        authorizationParams={{
          redirect_uri: window.location.origin,
          audience: AUTH0_AUDIENCE,
        }}
      >
      <AuthProvider>
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
                    <AdminLink />
                    <Switch>
                      <Route path="/">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <DashboardPage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/role/:roleName">
                        {(params) => {
                          const role = VALID_ROLES.find(r => r === params.roleName);
                          if (!role) return <div className="empty-state"><h2>Unknown Role</h2><p><Link href="/">Go to dashboard</Link></p></div>;
                          return (
                            <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                              <RolePage role={role} period={period} />
                            </ErrorBoundary>
                          );
                        }}
                      </Route>
                      <Route path="/metrics/:metricName">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <MetricDetailPage name={params.metricName} period={period} />
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/evaluations/trace/:traceId">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <EvaluationDetailPage traceId={params.traceId} />
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/correlations">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <CorrelationsPage period={period} />
                        </ErrorBoundary>
                      </Route>
                      {/* Coverage route hidden until data compression (see BACKLOG.md) */}
                      <Route path="/pipeline">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <PipelinePage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/compliance">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <CompliancePage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/agents">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <AgentsPage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/traces/:traceId">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <TraceDetailPage traceId={params.traceId} />
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/agents/:sessionId">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <AgentSessionPage sessionId={params.sessionId} />
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/sessions/:sessionId">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <SessionDetailPage sessionId={params.sessionId} />
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/workflows/:sessionId">
                        {(params) => (
                          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                            <Suspense fallback={<div className="card skeleton skeleton-xl" />}>
                              <WorkflowPage sessionId={params.sessionId} />
                            </Suspense>
                          </ErrorBoundary>
                        )}
                      </Route>
                      <Route path="/routing-telemetry">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <RoutingTelemetryPage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/degradation-signals">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <DegradationSignalsPage period={period} />
                        </ErrorBoundary>
                      </Route>
                      <Route path="/admin">
                        <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
                          <AdminGuard>
                            <AdminPage />
                          </AdminGuard>
                        </ErrorBoundary>
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
      </AuthProvider>
      </Auth0Provider>
    </Router>
  );
}
