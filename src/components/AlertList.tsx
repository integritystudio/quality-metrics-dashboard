import type { TriggeredAlert } from '../types.js';

export function AlertList({ alerts }: { alerts: TriggeredAlert[] }) {
  if (alerts.length === 0) return null;

  const sorted = [...alerts].sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity as keyof typeof order] ?? 2) - (order[b.severity as keyof typeof order] ?? 2);
  });

  return (
    <ul className="alert-list">
      {sorted.map((alert, i) => (
        <li key={i} className={`alert-item ${alert.severity}`}>
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
      ))}
    </ul>
  );
}
