import { Link } from 'wouter';
import type { TriggeredAlert } from '../types.js';

type AlertWithMeta = TriggeredAlert & { metricName?: string };

function SimpleAlertItem({ alert }: { alert: AlertWithMeta }) {
  return (
    <li className={`alert-item ${alert.severity}`}>
      <div className="alert-message">{alert.message}</div>
      <div className="alert-meta">
        {alert.aggregation} = {alert.actualValue?.toFixed(4)} (threshold: {alert.threshold?.toFixed(4)})
      </div>
      {alert.remediationHints && alert.remediationHints.length > 0 && (
        <div className="remediation">
          Hint: {alert.remediationHints[0]}
        </div>
      )}
    </li>
  );
}

function ThresholdBar({ actual, threshold, direction }: {
  actual: number;
  threshold: number;
  direction: 'above' | 'below';
}) {
  const max = Math.max(actual, threshold) * 1.2 || 1;
  const actualPct = Math.min((actual / max) * 100, 100);
  const thresholdPct = Math.min((threshold / max) * 100, 100);
  const isViolating = direction === 'below' ? actual < threshold : actual > threshold;

  return (
    <div className="threshold-bar" aria-label={`Actual: ${actual.toFixed(4)}, Threshold: ${threshold.toFixed(4)}`}>
      <div
        className="threshold-bar-fill"
        style={{
          width: `${actualPct}%`,
          background: isViolating ? 'var(--status-critical)' : 'var(--status-healthy)',
        }}
      />
      <div
        className="threshold-bar-marker"
        style={{ left: `${thresholdPct}%` }}
        title={`Threshold: ${threshold.toFixed(4)}`}
      />
    </div>
  );
}

function CompoundAlertCard({ alert }: { alert: AlertWithMeta }) {
  return (
    <li className={`alert-item alert-compound ${alert.severity}`}>
      <div className="alert-message">{alert.message}</div>
      <div className="alert-meta">
        {alert.aggregation} = {alert.actualValue?.toFixed(4)} (threshold: {alert.threshold?.toFixed(4)})
      </div>

      <ThresholdBar
        actual={alert.actualValue}
        threshold={alert.threshold}
        direction={alert.direction}
      />

      {alert.remediationHints && alert.remediationHints.length > 0 && (
        <ol className="remediation-list">
          {alert.remediationHints.map((hint, i) => (
            <li key={i}>{hint}</li>
          ))}
        </ol>
      )}

      {alert.relatedMetrics && alert.relatedMetrics.length > 0 && (
        <div className="alert-related">
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Related:</span>
          {alert.relatedMetrics.map((m) => (
            <Link key={m} href={`/metrics/${m}`} className="alert-metric-link">
              {m}
            </Link>
          ))}
        </div>
      )}
    </li>
  );
}

export function AlertList({ alerts }: { alerts: AlertWithMeta[] }) {
  if (alerts.length === 0) return null;

  const sorted = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity as keyof typeof order] ?? 2) - (order[b.severity as keyof typeof order] ?? 2);
  });

  return (
    <ul className="alert-list">
      {sorted.map((alert, i) =>
        alert.isCompound
          ? <CompoundAlertCard key={i} alert={alert} />
          : <SimpleAlertItem key={i} alert={alert} />
      )}
    </ul>
  );
}
