import { useDegradationSignals, type DegradationReport, type DegradationSignal } from '../hooks/useDegradationSignals.js';
import { PageShell } from '../components/PageShell.js';
import { StatusBadge } from '../components/Indicators.js';
import { SKELETON_HEIGHT_MD, SCORE_DISPLAY_PRECISION, PERCENT_MULTIPLIER } from '../lib/constants.js';
import type { Period } from '../types.js';
import { MonoTableHead, type TableColumn } from '../components/MonoTableHead.js';

const SIGNAL_COLUMNS: readonly TableColumn[] = [
  { label: 'Metric' },
  { label: 'Status' },
  { label: 'EWMA Drift' },
  { label: 'Variance Trend' },
  { label: 'Variance Ratio' },
  { label: 'Consecutive Breaches' },
  { label: 'Confirmed' },
  { label: 'Coverage Dropout' },
  { label: 'Latency Skew' },
];

const COVERAGE_DROPOUT_PRECISION = 1;

/** Digits for a p-value, which needs more resolution than a 0-1 score. */
const P_VALUE_PRECISION = 4;

/**
 * The drift cell reports the raw test and, when a family-level FDR correction
 * overruled it, says so. Without this the table shows "Yes" next to a healthy
 * status with nothing explaining the gap.
 */
function formatDrift(signal: DegradationSignal): string {
  if (!signal.ewmaDriftDetected) return 'No';
  // Nullish, not null: a pre-FDR payload from KV omits the field entirely.
  const p = signal.ewmaDriftPValue;
  const pLabel = p == null ? '' : ` (p=${p.toFixed(P_VALUE_PRECISION)})`;
  if (signal.ewmaDriftFdrSignificant === false) return `Not significant${pLabel}`;
  return `Yes${pLabel}`;
}

const VARIANCE_TREND_LABEL = {
  increasing: 'Increasing',
  stable: 'Stable',
  decreasing: 'Decreasing',
} as const;

function ReportRow({ report }: { report: DegradationReport }) {
  const { signal } = report;
  return (
    <tr>
      <td className="mono">{report.metricName}</td>
      <td>
        <StatusBadge status={signal.predictedStatus} />
      </td>
      <td className="mono">{formatDrift(signal)}</td>
      <td className="mono">{VARIANCE_TREND_LABEL[signal.varianceTrend]}</td>
      <td className="mono">{signal.varianceRatio.toFixed(SCORE_DISPLAY_PRECISION)}</td>
      <td className="mono">{signal.consecutiveBreaches}</td>
      <td className="mono">{signal.confirmed ? 'Yes' : 'No'}</td>
      <td className="mono">{(signal.coverageDropoutRate * PERCENT_MULTIPLIER).toFixed(COVERAGE_DROPOUT_PRECISION)}%</td>
      <td className="mono">{signal.latencySkewRatio.toFixed(SCORE_DISPLAY_PRECISION)}</td>
    </tr>
  );
}

export function DegradationSignalsPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useDegradationSignals(period);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data?.reports.length === 0 ? (
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
              <MonoTableHead variant="plain" columns={SIGNAL_COLUMNS} />
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
