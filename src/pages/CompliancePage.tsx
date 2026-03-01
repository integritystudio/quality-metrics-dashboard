import { Link } from 'wouter';
import { useComplianceSLA, useComplianceVerifications } from '../hooks/useCompliance.js';
import { ComplianceFrameworkMap } from '../components/ComplianceFrameworkMap.js';
import { EmptyCard } from '../components/EmptyCard.js';
import { ViewSection } from '../components/Section.js';
import { SLATable } from '../components/SLATable.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import type { Period } from '../types.js';

export function CompliancePage({ period }: { period: Period }) {
  const { data: slaData, isLoading: slaLoading, error: slaError } = useComplianceSLA(period);
  const { data: verData, isLoading: verLoading, error: verError } = useComplianceVerifications(period);

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      <ViewSection title="SLA Compliance">
        {slaLoading && <div className="card skeleton" style={{ height: 120 }} />}
        {slaError && <div className="error-state"><p>{slaError.message}</p></div>}
        {slaData && !slaData.noSLAsConfigured && slaData.results.length > 0 && (
          <SLATable slas={slaData.results} />
        )}
        {slaData && slaData.noSLAsConfigured && (
          <EmptyCard>
            No SLAs configured. Define SLAs in your quality metrics configuration.
          </EmptyCard>
        )}
        {slaData && !slaData.noSLAsConfigured && slaData.results.length === 0 && (
          <EmptyCard>
            All SLAs are compliant for the selected period.
          </EmptyCard>
        )}
      </ViewSection>

      <ViewSection title="Regulatory Framework Mapping">
        <ComplianceFrameworkMap />
      </ViewSection>

      <ViewSection title="Human Verification Events">
        {verLoading && <div className="card skeleton" style={{ height: 120 }} />}
        {verError && <div className="error-state"><p>{verError.message}</p></div>}
        {verData && verData.verifications.length > 0 && (
          <div className="card">
            <table className="eval-table" style={{ width: '100%' }}>
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
                    <td className="text-xs" title={new Date(v.timestamp).toLocaleString()}>
                      {formatTimestamp(v.timestamp)}
                    </td>
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
          <EmptyCard>
            No verification events for the selected period.
          </EmptyCard>
        )}
      </ViewSection>
    </div>
  );
}
