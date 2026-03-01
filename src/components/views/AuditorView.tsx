import type { AuditorView as AuditorViewType } from '../../types.js';
import { MetricGrid } from '../MetricGrid.js';
import { AlertList } from '../AlertList.js';
import { SLATable } from '../SLATable.js';
import { StatCard } from '../StatCard.js';

export function AuditorView({ data }: { data: AuditorViewType }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <StatCard value={data.totalEvaluationCount} label="Total Evaluations" />
        <StatCard value={data.metrics.length} label="Metrics" />
        <StatCard value={data.alerts.length} label="Alerts" />
        <StatCard
          value={new Date(data.timestamp).toLocaleString()}
          label="Computed At"
          valueColor="var(--text-secondary)"
        />
      </div>

      <div className="view-section">
        <h3 className="section-heading">All Metrics</h3>
        <MetricGrid metrics={data.metrics} />
      </div>

      {data.alerts.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">All Alerts</h3>
          <AlertList alerts={data.alerts} />
        </div>
      )}

      {data.slaCompliance && data.slaCompliance.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">SLA Compliance</h3>
          <SLATable slas={data.slaCompliance} />
        </div>
      )}
    </div>
  );
}
