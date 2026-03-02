import type { OperatorView as OperatorViewType } from '../../types.js';
import { TrendIndicator } from '../Indicators.js';
import { AlertList } from '../AlertList.js';
import { MetricGrid } from '../MetricGrid.js';
import { SimpleAlertList } from '../SimpleAlertList.js';
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
          <SimpleAlertList items={data.degradingTrends.map((dt) => ({
            key: dt.metricName,
            status: 'warning',
            message: <>{dt.metricName} <TrendIndicator trend={dt.trend} /></>,
            meta: <>{formatScore(dt.trend.previousValue)} &rarr; {formatScore(dt.trend.currentValue)}</>,
          }))} />
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
