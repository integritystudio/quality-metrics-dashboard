import { useComplianceSLA, useComplianceVerifications } from '../hooks/useCompliance.js';
import { ComplianceFrameworkMap } from '../components/ComplianceFrameworkMap.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { SLATable } from '../components/SLATable.js';
import { TimestampCell } from '../components/TimestampCell.js';
import type { Period } from '../types.js';

export function CompliancePage({ period }: { period: Period }) {
  const { data: slaData, isLoading: slaLoading, error: slaError } = useComplianceSLA(period);
  const { data: verData, isLoading: verLoading, error: verError } = useComplianceVerifications(period);

  return (
    <PageShell isLoading={slaLoading || verLoading} error={slaError ?? verError}>
      <ViewSection title="SLA Compliance">
        {slaData && !slaData.noSLAsConfigured && slaData.results.length > 0 && (
          <SLATable slas={slaData.results} />
        )}
        {slaData?.noSLAsConfigured && (
          <div className="card card--empty">
            No SLAs configured. Define SLAs in your quality metrics configuration.
          </div>
        )}
        {slaData && !slaData.noSLAsConfigured && slaData.results.length === 0 && (
          <div className="card card--empty">
            All SLAs are compliant for the selected period.
          </div>
        )}
      </ViewSection>

      <ViewSection title="Regulatory Framework Mapping">
        <ComplianceFrameworkMap />
      </ViewSection>

      <ViewSection title="Human Verification Events">
        {verData && verData.verifications.length > 0 && (
          <div className="card">
            <table className="eval-table w-full">
              <thead>
                <tr>
                  <th className="text-left">Timestamp</th>
                  <th className="text-left">Type</th>
                  <th className="text-left">Session</th>
                  <th className="text-left">Verifier</th>
                </tr>
              </thead>
              <tbody>
                {verData.verifications.map((v, i) => (
                  <tr key={`${v.sessionId}-${v.timestamp}-${i}`}>
                    <td><TimestampCell timestamp={v.timestamp} className="text-xs" /></td>
                    <td className="text-xs">{v.verificationType}</td>
                    <td className="mono-xs">{v.sessionId}</td>
                    <td className="text-secondary text-xs">{v.verifierId ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {verData && verData.verifications.length === 0 && (
          <div className="card card--empty">
            No verification events for the selected period.
          </div>
        )}
      </ViewSection>
    </PageShell>
  );
}
