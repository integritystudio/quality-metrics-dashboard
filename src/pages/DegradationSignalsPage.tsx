import { useDegradationSignals, type DegradationReport } from '../hooks/useDegradationSignals.js';
import { PageShell } from '../components/PageShell.js';
import { StatusBadge } from '../components/Indicators.js';
import { SKELETON_HEIGHT_MD, SCORE_DISPLAY_PRECISION } from '../lib/constants.js';
import type { Period } from '../types.js';

const VARIANCE_TREND_LABELS: Record<string, string> = {
  increasing: 'Increasing',
  stable: 'Stable',
  decreasing: 'Decreasing',
};

function ReportRow({ report }: { report: DegradationReport }) {
  const { signal } = report;
  return (
    <tr>
      <td className="mono">{report.metricName}</td>
      <td>
        <StatusBadge status={signal.predictedStatus} />
      </td>
      <td className="mono">{signal.ewmaDriftDetected ? 'Yes' : 'No'}</td>
      <td className="mono">{VARIANCE_TREND_LABELS[signal.varianceTrend] ?? signal.varianceTrend}</td>
      <td className="mono">{signal.varianceRatio.toFixed(SCORE_DISPLAY_PRECISION)}</td>
      <td className="mono">{signal.consecutiveBreaches}</td>
      <td className="mono">{signal.confirmed ? 'Yes' : 'No'}</td>
    </tr>
  );
}

export function DegradationSignalsPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useDegradationSignals(period);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data && data.reports.length === 0 ? (
        <div className="empty-state">
          <h2>No Degradation Data</h2>
          <p>No regression signals found for this period. Run the data pipeline to populate degradation signals.</p>
        </div>
      ) : data ? (
        <>
          <h2 className="text-lg mb-3">Regression Detection</h2>

          {data.computedAt && (
            <div className="text-secondary text-xs mb-3">
              Last computed: {new Date(data.computedAt).toLocaleString()}
            </div>
          )}

          <div className="card mb-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Status</th>
                  <th>EWMA Drift</th>
                  <th>Variance Trend</th>
                  <th>Variance Ratio</th>
                  <th>Consecutive Breaches</th>
                  <th>Confirmed</th>
                </tr>
              </thead>
              <tbody>
                {data.reports.map(r => (
                  <ReportRow key={r.metricName} report={r} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </PageShell>
  );
}
