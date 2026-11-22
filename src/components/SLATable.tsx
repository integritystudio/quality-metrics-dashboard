import { formatScore } from '../lib/quality-utils.js';
import type { SLAComplianceResult } from '../types.js';
import { StatusBadge } from './Indicators.js';
import { MonoTableHead, type TableColumn } from './MonoTableHead.js';

const SLA_COLUMNS: readonly TableColumn[] = [
  { label: 'Metric' },
  { label: 'Target' },
  { label: 'Actual' },
  { label: 'Gap' },
  { label: 'Status' },
];

export function SLATable({ slas }: { slas: SLAComplianceResult[] }) {
  if (slas.length === 0) return null;

  return (
    <table className="data-table sla-table">
      <MonoTableHead variant="plain" columns={SLA_COLUMNS} />
      <tbody>
        {slas.map((sla) => (
          <tr key={`${sla.sla.metric}-${sla.sla.aggregation}`}>
            <td>{sla.sla.metric} ({sla.sla.aggregation})</td>
            <td className="mono">
              {sla.sla.direction === 'above' ? '>=' : '<='} {formatScore(sla.sla.target)}
            </td>
            <td className="mono">
              {formatScore(sla.actualValue)}
            </td>
            <td className="mono sla-gap-cell" data-status={sla.gap !== null && !sla.compliant ? 'critical' : 'healthy'}>
              {sla.gap !== null ? (sla.gap >= 0 ? '+' : '') + formatScore(sla.gap) : '-'}
            </td>
            <td><StatusBadge status={sla.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
