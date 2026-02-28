import { Link } from 'wouter';
import { useComplianceSLA, useComplianceVerifications } from '../hooks/useCompliance.js';
import { ComplianceFrameworkMap } from '../components/ComplianceFrameworkMap.js';
import { SLATable } from '../components/SLATable.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import type { Period } from '../types.js';

export function CompliancePage({ period }: { period: Period }) {
  const { data: slaData, isLoading: slaLoading, error: slaError } = useComplianceSLA(period);
  const { data: verData, isLoading: verLoading, error: verError } = useComplianceVerifications(period);

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      <div className="view-section">
        <h3 className="section-heading">SLA Compliance</h3>
        {slaLoading && <div className="card skeleton" style={{ height: 120 }} />}
        {slaError && <div className="error-state"><p>{slaError.message}</p></div>}
        {slaData && !slaData.noSLAsConfigured && slaData.results.length > 0 && (
          <SLATable slas={slaData.results} />
        )}
        {slaData && slaData.noSLAsConfigured && (
          <div className="card card--empty">
            No SLAs configured. Define SLAs in your quality metrics configuration.
          </div>
        )}
        {slaData && !slaData.noSLAsConfigured && slaData.results.length === 0 && (
          <div className="card card--empty">
            All SLAs are compliant for the selected period.
          </div>
        )}
      </div>

      <div className="view-section">
        <h3 className="section-heading">Regulatory Framework Mapping</h3>
        <ComplianceFrameworkMap />
      </div>

      <div className="view-section">
        <h3 className="section-heading">Human Verification Events</h3>
        {verLoading && <div className="card skeleton" style={{ height: 120 }} />}
        {verError && <div className="error-state"><p>{verError.message}</p></div>}
        {verData && verData.verifications.length > 0 && (
          <div className="card">
            <table className="eval-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Timestamp</th>
                  <th style={{ textAlign: 'left' }}>Type</th>
                  <th style={{ textAlign: 'left' }}>Session</th>
                  <th style={{ textAlign: 'left' }}>Verifier</th>
                </tr>
              </thead>
              <tbody>
                {verData.verifications.map((v, i) => (
                  <tr key={`${v.sessionId}-${v.timestamp}-${i}`}>
                    <td style={{ fontSize: 13 }} title={new Date(v.timestamp).toLocaleString()}>
                      {formatTimestamp(v.timestamp)}
                    </td>
                    <td style={{ fontSize: 13 }}>{v.verificationType}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{v.sessionId}</td>
                    <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{v.verifierId ?? '-'}</td>
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
      </div>
    </div>
  );
}
