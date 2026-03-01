import type { AuditorView as AuditorViewType } from '../../types.js';
import { MetricGrid } from '../MetricGrid.js';
import { AlertList } from '../AlertList.js';
import { SLATable } from '../SLATable.js';
import { StatCard } from '../StatCard.js';
import { ViewSection } from '../Section.js';

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
