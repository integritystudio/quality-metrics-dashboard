import { Link } from 'wouter';
import type { CSSProperties } from 'react';
import { formatScore } from '../lib/quality-utils.js';
import type { TriggeredAlert } from '../types.js';

type AlertWithMeta = TriggeredAlert & { metricName?: string };

function SimpleAlertItem({ alert }: { alert: AlertWithMeta }) {
  return (
    <li className="alert-item" data-status={alert.severity}>
      <div className="alert-message">{alert.message}</div>
      <div className="alert-meta text-secondary text-xs">
        {alert.aggregation} = {formatScore(alert.actualValue)} (threshold: {formatScore(alert.threshold)})
      </div>
      {alert.remediationHints && alert.remediationHints.length > 0 && (
        <div className="remediation text-xs">
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
  const actualPct = Math.max(0, Math.min((actual / max) * 100, 100));
  const thresholdPct = Math.max(0, Math.min((threshold / max) * 100, 100));
  const isViolating = direction === 'below' ? actual < threshold : actual > threshold;

  return (
    <div className="threshold-bar" aria-label={`Actual: ${formatScore(actual)}, Threshold: ${formatScore(threshold)}`}>
      <div
        className="threshold-bar-fill"
        data-violating={isViolating || undefined}
        style={{ '--bar-fill-width': `${actualPct}%` } as CSSProperties}
      />
      <div
        className="threshold-bar-marker"
        style={{ '--bar-marker-left': `${thresholdPct}%` } as CSSProperties}
        title={`Threshold: ${formatScore(threshold)}`}
      />
    </div>
  );
}

function CompoundAlertCard({ alert }: { alert: AlertWithMeta }) {
  return (
    <li className="alert-item alert-compound" data-status={alert.severity}>
      <div className="alert-message">{alert.message}</div>
      <div className="alert-meta text-secondary text-xs">
        {alert.aggregation} = {formatScore(alert.actualValue)} (threshold: {formatScore(alert.threshold)})
      </div>

      <ThresholdBar
        actual={alert.actualValue}
        threshold={alert.threshold}
        direction={alert.direction}
      />

      {alert.remediationHints && alert.remediationHints.length > 0 && (
        <ol className="remediation-list text-xs">
          {alert.remediationHints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ol>
      )}

      {alert.relatedMetrics && alert.relatedMetrics.length > 0 && (
        <div className="alert-related flex-center">
          <span className="text-secondary text-xs">Related:</span>
          {alert.relatedMetrics.map((m) => (
            <Link key={m} href={`/metrics/${m}`} className="alert-metric-link text-xs">
              {m}
            </Link>
          ))}
        </div>
      )}
    </li>
  );
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function AlertList({ alerts }: { alerts: AlertWithMeta[] }) {
  if (alerts.length === 0) return null;

  const sorted = [...alerts].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  return (
    <ul className="alert-list">
      {sorted.map((alert) =>
        alert.isCompound
          ? <CompoundAlertCard key={alert.message} alert={alert} />
          : <SimpleAlertItem key={alert.message} alert={alert} />
      )}
    </ul>
  );
}
