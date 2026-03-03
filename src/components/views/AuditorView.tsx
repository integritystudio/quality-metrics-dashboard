import type { AuditorView as AuditorViewType } from '../../types.js';
import { MetricGrid } from '../MetricGrid.js';
import { AlertList } from '../AlertList.js';
import { SLATable } from '../SLATable.js';
import { StatDisplay } from '../StatDisplay.js';
import { ViewSection } from '../Section.js';

export function AuditorView({ data }: { data: AuditorViewType }) {
  return (
    <div>
      <div className="d-flex gap-4 mb-6">
        <StatDisplay variant="card" value={data.totalEvaluationCount} label="Total Evaluations" />
        <StatDisplay variant="card" value={data.metrics.length} label="Metrics" />
        <StatDisplay variant="card" value={data.alerts.length} label="Alerts" />
        <StatDisplay variant="card"
          value={new Date(data.timestamp).toLocaleString()}
          label="Computed At"
          valueColor="var(--text-secondary)"
        />
      </div>

      <ViewSection title="All Metrics">
        <MetricGrid metrics={data.metrics} />
      </ViewSection>

      {data.alerts.length > 0 && (
        <ViewSection title="All Alerts">
          <AlertList alerts={data.alerts} />
        </ViewSection>
      )}

      {data.slaCompliance && data.slaCompliance.length > 0 && (
        <ViewSection title="SLA Compliance">
          <SLATable slas={data.slaCompliance} />
        </ViewSection>
      )}
    </div>
  );
}
