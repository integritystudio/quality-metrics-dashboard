import type { ReactNode } from 'react';
import { useComplianceSLA, useComplianceVerifications } from '../hooks/useCompliance.js';
import { ComplianceFrameworkMap } from '../components/ComplianceFrameworkMap.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { SLATable } from '../components/SLATable.js';
import { TimestampCell } from '../components/TimestampCell.js';
import type { Period } from '../types.js';
import { MonoTableHead, type TableColumn } from '../components/MonoTableHead.js';

const VERIFICATION_COLUMNS: readonly TableColumn[] = [
  { label: 'Timestamp', align: 'left' },
  { label: 'Type', align: 'left' },
  { label: 'Session', align: 'left' },
  { label: 'Verifier', align: 'left' },
];

type SLAData = ReturnType<typeof useComplianceSLA>['data'];
type VerificationData = ReturnType<typeof useComplianceVerifications>['data'];

/** Nothing configured, nothing breached and a table of breaches are three distinct states. */
function SLACompliance({ data }: { data: SLAData }): ReactNode {
  if (!data) return null;
  if (data.noSLAsConfigured) {
    return (
      <div className="card card--empty">
        No SLAs configured. Define SLAs in your quality metrics configuration.
      </div>
    );
  }
  if (data.results.length === 0) {
    return (
      <div className="card card--empty">
        All SLAs are compliant for the selected period.
      </div>
    );
  }
  return <SLATable slas={data.results} />;
}

function VerificationEvents({ data }: { data: VerificationData }): ReactNode {
  if (!data) return null;
  if (data.verifications.length === 0) {
    return (
      <div className="card card--empty">
        No verification events for the selected period.
      </div>
    );
  }
  return (
    <div className="card">
      <table className="data-table eval-table w-full">
        <MonoTableHead variant="plain" columns={VERIFICATION_COLUMNS} />
        <tbody>
          {data.verifications.map((v) => (
            <tr key={`${v.sessionId}-${v.timestamp}`}>
              <td><TimestampCell timestamp={v.timestamp} className="text-xs" /></td>
              <td className="text-xs">{v.verificationType}</td>
              <td className="mono-xs">{v.sessionId}</td>
              <td className="text-secondary text-xs">{v.verifierId ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CompliancePage({ period }: { period: Period }) {
  const { data: slaData, isLoading: slaLoading, error: slaError } = useComplianceSLA(period);
  const { data: verData, isLoading: verLoading, error: verError } = useComplianceVerifications(period);

  return (
    <PageShell isLoading={slaLoading || verLoading} error={slaError ?? verError}>
      <ViewSection title="SLA Compliance">
        <SLACompliance data={slaData} />
      </ViewSection>

      <ViewSection title="Regulatory Framework Mapping">
        <ComplianceFrameworkMap />
      </ViewSection>

      <ViewSection title="Human Verification Events">
        <VerificationEvents data={verData} />
      </ViewSection>
    </PageShell>
  );
}
