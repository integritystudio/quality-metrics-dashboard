import type { ExecutiveView as ExecutiveViewType, CompositeQualityIndex } from '../../types.js';
import { StatusBadge } from '../Indicators.js';
import { CQIHero } from '../CQIHero.js';

interface ExtendedExecutiveView extends ExecutiveViewType {
  cqi?: CompositeQualityIndex;
}

export function ExecutiveView({ data }: { data: ExtendedExecutiveView }) {
  return (
    <div>
      <div className={`health-banner ${data.overallStatus}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusBadge status={data.overallStatus} />
          <span>Executive Summary</span>
        </div>
        <div className="summary-counts">
          <div className="summary-count">
            <div className="value">{data.summary.totalMetrics}</div>
            <div className="label">Total</div>
          </div>
          <div className="summary-count">
            <div className="value" style={{ color: 'var(--status-healthy)' }}>{data.summary.healthyMetrics}</div>
            <div className="label">Healthy</div>
          </div>
          {data.slaCompliantCount !== undefined && (
            <div className="summary-count">
              <div className="value">{data.slaCompliantCount}/{data.slaTotalCount}</div>
              <div className="label">SLAs Met</div>
            </div>
          )}
        </div>
      </div>

      {data.topIssues.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Top Issues</h3>
          <ul className="alert-list">
            {data.topIssues.map((issue: { name: string; displayName: string; status: string; alertCount: number }) => (
              <li key={issue.name} className={`alert-item ${issue.status}`}>
                <div className="alert-message">{issue.displayName}</div>
                <div className="alert-meta">
                  Status: {issue.status} &middot; {issue.alertCount} alert{issue.alertCount !== 1 ? 's' : ''}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.cqi && (
        <div className="view-section">
          <CQIHero cqi={data.cqi} />
        </div>
      )}

      <div className="view-section">
        <h3 className="section-heading">Metric Statuses</h3>
        <div className="metric-grid">
          {data.metricStatuses.map((m: { name: string; displayName: string; status: string }) => (
            <div key={m.name} className="card" style={{ padding: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{m.displayName}</span>
              <StatusBadge status={m.status} />
            </div>
          ))}
        </div>
      </div>

      <div className="view-section">
        <h3 className="section-heading">Alert Summary</h3>
        <div style={{ display: 'flex', gap: 16 }}>
          {Object.entries(data.alertCounts).map(([severity, count]) => (
            <div key={severity} className="card" style={{ padding: 12, textAlign: 'center', minWidth: 100 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600 }}>{String(count)}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{severity}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
