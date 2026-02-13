import type { AuditorView as AuditorViewType } from '../../types.js';
import { MetricGrid } from '../MetricGrid.js';
import { AlertList } from '../AlertList.js';
import { SLATable } from '../SLATable.js';

export function AuditorView({ data }: { data: AuditorViewType }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        <div className="card" style={{ padding: 12, textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600 }}>
            {data.totalEvaluationCount}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Total Evaluations
          </div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600 }}>
            {data.metrics.length}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Metrics
          </div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 600 }}>
            {data.alerts.length}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
            Alerts
          </div>
        </div>
        <div className="card" style={{ padding: 12, textAlign: 'center', minWidth: 120 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {new Date(data.timestamp).toLocaleString()}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase', marginTop: 4 }}>
            Computed At
          </div>
        </div>
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
