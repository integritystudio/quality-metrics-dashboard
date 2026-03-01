import { useState, useCallback } from 'react';
import { Route, Switch, Link, useLocation, Router } from 'wouter';
import { ErrorBoundary } from 'react-error-boundary';
import { Layout } from './components/Layout.js';
import { RoleSelector } from './components/RoleSelector.js';
import { KeyboardNavProvider, useShortcut } from './contexts/KeyboardNavContext.js';
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
import { CorrelationsPage } from './pages/CorrelationsPage.js';
import { CoveragePage } from './pages/CoveragePage.js';
import { PipelinePage } from './pages/PipelinePage.js';
import { EvaluationDetailPage } from './pages/EvaluationDetailPage.js';
import { CompliancePage } from './pages/CompliancePage.js';
import { TraceDetailPage } from './pages/TraceDetailPage.js';
import { AgentSessionPage } from './pages/AgentSessionPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { SessionDetailPage } from './pages/SessionDetailPage.js';
import { ExecutiveView } from './components/views/ExecutiveView.js';
import { OperatorView } from './components/views/OperatorView.js';
import { AuditorView } from './components/views/AuditorView.js';
import { useDashboard } from './hooks/useDashboard.js';
import { useMetricDetail } from './hooks/useMetricDetail.js';
import { useTrend } from './hooks/useTrend.js';
import { RoleProvider } from './contexts/RoleContext.js';
import type {
  Period,
  QualityDashboardSummary,
  RoleViewType,
  ExecutiveView as ExecutiveViewType,
  OperatorView as OperatorViewType,
  AuditorView as AuditorViewType,
  MetricDetailResult,
  MetricDynamics,
} from './types.js';

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
        <p style={{ marginTop: 8 }}>
          Run evaluations using the <code>obs_inject_evaluations</code> tool to see metrics here.
        </p>
      </div>
    );
  }

  return (
    <>
      {isFetching && data && <div className="refetch-indicator">Updating...</div>}
      <HealthOverview dashboard={dashboard} />
      <MetricGrid metrics={dashboard.metrics} sparklines={sparklines} />
      {dashboard.alerts.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Active Alerts</h3>
          <AlertList alerts={dashboard.alerts} />
        </div>
      )}
      {dashboard.slaCompliance && dashboard.slaCompliance.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">SLA Compliance</h3>
          <SLATable slas={dashboard.slaCompliance} />
        </div>
      )}
    </>
  );
}

function RolePage({ role, period }: { role: RoleViewType; period: Period }) {
  const { data, isLoading, error } = useDashboard(period, role);

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
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="card skeleton" style={{ height: 300 }} />
      </div>
    );
  }
  if (error) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      </div>
    );
  }

  if (!data) return null;
  const detail = data;

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      <div className="card" style={{ marginBottom: 24 }}>
        <div className="metric-card-header">
          <h2 className="text-lg">{detail.displayName}</h2>
          <StatusBadge status={detail.status} />
        </div>
        <div style={{ display: 'flex', gap: 32, marginTop: 12, flexWrap: 'wrap' }}>
          {(['avg', 'min', 'max', 'p50', 'p95', 'p99'] as const).map((key) => {
            const val = detail.values[key];
            return (
              <div key={key} style={{ textAlign: 'center' }}>
                <div className="mono-xl">
                  {val !== null && val !== undefined ? val.toFixed(4) : 'N/A'}
                </div>
                <div className="text-secondary text-xs uppercase">{key}</div>
              </div>
            );
          })}
          <div style={{ textAlign: 'center' }}>
            <div className="mono-xl">{detail.sampleCount}</div>
            <div className="text-secondary text-xs uppercase">samples</div>
          </div>
        </div>
        <div className="flex-center" style={{ gap: 16, marginTop: 12 }}>
          <TrendIndicator trend={detail.trend} />
          <ConfidenceBadge confidence={detail.confidence} />
        </div>
      </div>

      {detail.confidence && (
        <div className="view-section">
          <h3 className="section-heading">Confidence Analysis</h3>
          <div className="card">
            <ConfidencePanel confidence={detail.confidence} />
          </div>
        </div>
      )}

      <div className="view-section">
        <h3 className="section-heading">Trend</h3>
        <div className="card">
          <TrendChart
            trend={detail.trend}
            dynamics={(detail as MetricDetailResult & { dynamics?: MetricDynamics }).dynamics}
            warningThreshold={detail.alerts.find(a => a.severity === 'warning')?.threshold}
            criticalThreshold={detail.alerts.find(a => a.severity === 'critical')?.threshold}
            metricName={detail.displayName}
          />
        </div>
      </div>

      {trendData && trendData.trendData.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">
            Time Series ({trendData.totalEvaluations} evaluations)
            {trendData.narrowed && (
              <span className="text-muted text-xs" style={{
                fontWeight: 400,
                marginLeft: 8,
              }}>auto-narrowed to data range</span>
            )}
          </h3>
          <div className="card">
            <TrendSeries data={trendData.trendData} metricName={detail.displayName} />
          </div>
        </div>
      )}

      {detail.alerts.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Alerts</h3>
          <AlertList alerts={detail.alerts} />
        </div>
      )}

      <div className="view-section">
        <h3 className="section-heading">Score Distribution</h3>
        <div className="card">
          <ScoreHistogram distribution={detail.scoreDistribution} />
        </div>
      </div>

      <div className="view-section">
        <h3 className="section-heading">Evaluations</h3>
        <div className="card">
          <EvaluationDetail worst={detail.worstEvaluations} best={detail.bestEvaluations} metricName={name} period={period} />
        </div>
      </div>
    </div>
  );
}

function RouteErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
  return (
    <div className="error-state">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
      <div className="error-actions">
        <button onClick={resetErrorBoundary}>Try again</button>
        <Link href="/">Back to dashboard</Link>
      </div>
    </div>
  );
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
  return null;
}

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '') || '';

export function App() {
  const [period, setPeriod] = useState<Period>('30d');
  const [location, navigate] = useLocation();

  return (
    <Router base={BASE_PATH}>
    <KeyboardNavProvider>
    <RoleProvider>
    <GlobalShortcuts setPeriod={setPeriod} navigate={navigate} />
    <Layout period={period} onPeriodChange={setPeriod}>
      <RoleSelector />
      <Switch>
        <Route path="/">
          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
            <DashboardPage period={period} />
          </ErrorBoundary>
        </Route>
        <Route path="/role/:roleName">
          {(params) => (
            <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
              <RolePage role={params.roleName as RoleViewType} period={period} />
            </ErrorBoundary>
          )}
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
        <Route path="/coverage">
          <ErrorBoundary FallbackComponent={RouteErrorFallback} resetKeys={[location]}>
            <CoveragePage period={period} />
          </ErrorBoundary>
        </Route>
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
        <Route>
          <div className="empty-state">
            <h2>Page Not Found</h2>
            <p><Link href="/">Go to dashboard</Link></p>
          </div>
        </Route>
      </Switch>
    </Layout>
    </RoleProvider>
    </KeyboardNavProvider>
    </Router>
  );
}
