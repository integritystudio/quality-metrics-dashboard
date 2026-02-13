import type { SLAComplianceResult } from '../types.js';
import { StatusBadge } from './Indicators.js';

export function SLATable({ slas }: { slas: SLAComplianceResult[] }) {
  if (slas.length === 0) return null;

  return (
    <table className="sla-table">
      <thead>
        <tr>
          <th>Metric</th>
          <th>Target</th>
          <th>Actual</th>
          <th>Gap</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {slas.map((sla, i) => (
          <tr key={i}>
            <td>{sla.sla.metric} ({sla.sla.aggregation})</td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>
              {sla.sla.direction === 'above' ? '>=' : '<='} {sla.sla.target.toFixed(4)}
            </td>
            <td style={{ fontFamily: 'var(--font-mono)' }}>
              {sla.actualValue !== null ? sla.actualValue.toFixed(4) : 'N/A'}
            </td>
            <td style={{
              fontFamily: 'var(--font-mono)',
              color: sla.gap !== null && !sla.compliant ? 'var(--status-critical)' : 'var(--status-healthy)',
            }}>
              {sla.gap !== null ? (sla.gap >= 0 ? '+' : '') + sla.gap.toFixed(4) : '-'}
            </td>
            <td><StatusBadge status={sla.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
