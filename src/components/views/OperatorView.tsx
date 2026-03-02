import type { OperatorView as OperatorViewType } from '../../types.js';
import { TrendIndicator } from '../Indicators.js';
import { AlertList } from '../AlertList.js';
import { MetricGrid } from '../MetricGrid.js';
import { ViewSection } from '../Section.js';
import { HealthBanner } from '../HealthBanner.js';
import { plural, formatScore } from '../../lib/quality-utils.js';

export function OperatorView({ data }: { data: OperatorViewType }) {
  return (
    <div>
      <HealthBanner
        status={data.overallStatus}
        message={<>Operator View &middot; {plural(data.prioritizedAlerts.length, 'active alert')}</>}
      />

      {data.prioritizedAlerts.length > 0 && (
        <ViewSection title="Prioritized Alerts">
          <AlertList alerts={data.prioritizedAlerts} />
        </ViewSection>
      )}

      {data.degradingTrends.length > 0 && (
        <ViewSection title="Degrading Trends">
          <ul className="alert-list">
            {data.degradingTrends.map((dt) => (
              <li key={dt.metricName} className="alert-item" data-status="warning">
                <div className="alert-message">
                  {dt.metricName} <TrendIndicator trend={dt.trend} />
                </div>
                <div className="alert-meta text-secondary text-xs">
                  {formatScore(dt.trend.previousValue)} &rarr; {formatScore(dt.trend.currentValue)}
                </div>
              </li>
            ))}
          </ul>
        </ViewSection>
      )}

      {data.alertingMetrics.length > 0 && (
        <ViewSection title="Alerting Metrics">
          <MetricGrid metrics={data.alertingMetrics} />
        </ViewSection>
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
