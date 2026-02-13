import type { OperatorView as OperatorViewType } from '../../types.js';
import { StatusBadge, TrendIndicator } from '../Indicators.js';
import { AlertList } from '../AlertList.js';
import { MetricGrid } from '../MetricGrid.js';

export function OperatorView({ data }: { data: OperatorViewType }) {
  return (
    <div>
      <div className={`health-banner ${data.overallStatus}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusBadge status={data.overallStatus} />
          <span>Operator View &middot; {data.prioritizedAlerts.length} active alert{data.prioritizedAlerts.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {data.prioritizedAlerts.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Prioritized Alerts</h3>
          <AlertList alerts={data.prioritizedAlerts} />
        </div>
      )}

      {data.degradingTrends.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Degrading Trends</h3>
          <ul className="alert-list">
            {data.degradingTrends.map((dt) => (
              <li key={dt.metricName} className="alert-item warning">
                <div className="alert-message">
                  {dt.metricName} <TrendIndicator trend={dt.trend} />
                </div>
                <div className="alert-meta">
                  {dt.trend.previousValue?.toFixed(4)} &rarr; {dt.trend.currentValue?.toFixed(4)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.alertingMetrics.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Alerting Metrics</h3>
          <MetricGrid metrics={data.alertingMetrics} />
        </div>
      )}

      {data.prioritizedAlerts.length === 0 && data.degradingTrends.length === 0 && (
        <div className="empty-state">
          <h2>All Clear</h2>
          <p>No active alerts or degrading trends.</p>
        </div>
      )}
    </div>
  );
}
