import type { QualityDashboardSummary } from '../types.js';
import { StatusBadge } from './Indicators.js';

export function HealthOverview({ dashboard }: { dashboard: QualityDashboardSummary }) {
  const { overallStatus, summary } = dashboard;

  return (
    <div className={`health-banner ${overallStatus}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusBadge status={overallStatus} />
        <span style={{ fontSize: 14 }}>
          {overallStatus === 'healthy' && 'All metrics within thresholds'}
          {overallStatus === 'warning' && 'Some metrics need attention'}
          {overallStatus === 'critical' && 'Critical issues detected'}
          {overallStatus === 'no_data' && 'No evaluation data available'}
        </span>
      </div>
      <div className="summary-counts">
        <div className="summary-count">
          <div className="value">{summary.totalMetrics}</div>
          <div className="label">Total</div>
        </div>
        <div className="summary-count">
          <div className="value" style={{ color: 'var(--status-healthy)' }}>{summary.healthyMetrics}</div>
          <div className="label">Healthy</div>
        </div>
        <div className="summary-count">
          <div className="value" style={{ color: 'var(--status-warning)' }}>{summary.warningMetrics}</div>
          <div className="label">Warning</div>
        </div>
        <div className="summary-count">
          <div className="value" style={{ color: 'var(--status-critical)' }}>{summary.criticalMetrics}</div>
          <div className="label">Critical</div>
        </div>
      </div>
    </div>
  );
}
