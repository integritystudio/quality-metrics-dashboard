import { useCodeQuality } from '../hooks/useCodeQuality.js';
import { PageShell } from '../components/PageShell.js';
import { CODE_QUALITY_WARN_THRESHOLD, SKELETON_HEIGHT_MD } from '../lib/constants.js';
import type { AgentWindowStats, AgentVersionStats } from '../api/routes/code-quality.js';

const RATE_PRECISION = 1;

function fmtPct(rate: number): string {
  return (rate * 100).toFixed(RATE_PRECISION) + '%';
}

function SurvivalTable({ rows }: { rows: AgentWindowStats[] }) {
  const rows21d = rows.filter(r => r.window === '21d');
  if (rows21d.length === 0) return null;
  return (
    <div className="card mb-4">
      <h3 className="text-base mb-2">Survival by Agent (21-day window)</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Version</th>
            <th>Survival</th>
            <th>Churn</th>
            <th>Deletion</th>
            <th>Checkpoints</th>
          </tr>
        </thead>
        <tbody>
          {rows21d.map(r => (
            <tr key={`${r.agentName}-${r.agentVersion}`}>
              <td className="mono">
                {r.avgSurvivalRate < CODE_QUALITY_WARN_THRESHOLD && (
                  <span className="warn-indicator" aria-label="Below survival threshold">&#9888; </span>
                )}
                {r.agentName}
              </td>
              <td className="mono text-secondary">{r.agentVersion}</td>
              <td className="mono">{fmtPct(r.avgSurvivalRate)}</td>
              <td className="mono">{fmtPct(r.avgChurnRate)}</td>
              <td className="mono">{fmtPct(r.avgDeletionRate)}</td>
              <td className="mono">{r.checkpointCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VersionRolloutTable({ rows }: { rows: AgentVersionStats[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="card">
      <h3 className="text-base mb-2">Candidate Versions (last 90 days)</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Version</th>
            <th>Invocations</th>
            <th>Last Seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={`${r.agentName}-${r.agentVersion}`}>
              <td className="mono">{r.agentName}</td>
              <td className="mono text-secondary">{r.agentVersion}</td>
              <td className="mono">{r.invocationCount}</td>
              <td className="mono text-secondary">
                {r.latestTimestamp ? new Date(r.latestTimestamp).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentCodeQualityPage() {
  const { data, isLoading, error } = useCodeQuality();

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      <h2 className="text-lg mb-1">Agent Code Quality</h2>
      <p className="text-secondary text-xs mb-4">
        Post-merge survival of agent-produced code, measured at 3d / 7d / 21d windows
        per Popescu et al. §3.2. Data accumulates as checkpoints arrive.
      </p>

      {!data?.hasData ? (
        <div className="empty-state">
          <h2>No Code Quality Data</h2>
          <p>
            Survival checkpoints accumulate over 21 days after each seed commit.
            The first checkpoint is due around 2026-10-16.
          </p>
          <p className="mt-2 text-secondary text-xs">
            Checkpoints are emitted by <code>ai.integritystudio.code-survival</code> every 6 hours.
            Run <code>launchctl print gui/$(id -u)/ai.integritystudio.code-survival</code> to verify the job is active.
          </p>
        </div>
      ) : (
        <>
          <SurvivalTable rows={data.survivalByAgentWindow} />
          <VersionRolloutTable rows={data.versionRollout} />
        </>
      )}
    </PageShell>
  );
}
