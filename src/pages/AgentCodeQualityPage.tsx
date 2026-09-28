import { useCodeQuality } from '../hooks/useCodeQuality.js';
import { PageShell } from '../components/PageShell.js';
import { CODE_QUALITY_WARN_THRESHOLD, CONTENT_KIND, SKELETON_HEIGHT_MD, SURVIVAL_COHORT, type SurvivalCohort } from '../lib/constants.js';
import type { AgentWindowStats, AgentVersionStats } from '../api/routes/code-quality.js';

const RATE_PRECISION = 1;
/** The window D7 and Tier 3 fitness read; earlier windows are progress only. */
const SCORED_WINDOW = '21d';

function fmtPct(rate: number): string {
  return (rate * 100).toFixed(RATE_PRECISION) + '%';
}

function CohortBadge({ cohort }: { cohort: SurvivalCohort }) {
  if (cohort !== SURVIVAL_COHORT.BASELINE) return null;
  return (
    <span className="status-badge inline-flex-center text-xs ml-1" data-status="info" aria-label="Baseline cohort: not scored">
      baseline
    </span>
  );
}

interface SurvivalTableProps {
  title: string;
  note: string;
  rows: AgentWindowStats[];
  /** Flag rows below the survival threshold — only meaningful for scored code. */
  warnBelowThreshold: boolean;
}

function SurvivalTable({ title, note, rows, warnBelowThreshold }: SurvivalTableProps) {
  if (rows.length === 0) return null;
  return (
    <div className="card mb-4">
      <h3 className="text-base mb-1">{title}</h3>
      <p className="text-secondary text-xs mb-2">{note}</p>
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
          {rows.map(r => (
            <tr key={`${r.agentName}-${r.agentVersion}-${r.cohort}-${r.contentKind}`}>
              <td className="mono">
                {warnBelowThreshold && r.avgSurvivalRate < CODE_QUALITY_WARN_THRESHOLD && (
                  <span className="warn-indicator" aria-label="Below survival threshold">&#9888; </span>
                )}
                {r.agentName}
                <CohortBadge cohort={r.cohort} />
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

function SurvivalSections({ rows }: { rows: AgentWindowStats[] }) {
  const scoredWindow = rows.filter(r => r.window === SCORED_WINDOW);
  const earlyCheckpoints = rows
    .filter(r => r.window !== SCORED_WINDOW)
    .reduce((sum, r) => sum + r.checkpointCount, 0);
  const code = scoredWindow.filter(r => r.contentKind === CONTENT_KIND.CODE);

  return (
    <>
      {scoredWindow.length === 0 && (
        <div className="card mb-4">
          <p className="text-secondary text-xs">
            {earlyCheckpoints} earlier-window (3d / 7d) checkpoint{earlyCheckpoints === 1 ? '' : 's'} so far.
            The tables below fill as {SCORED_WINDOW} checkpoints arrive.
          </p>
        </div>
      )}
      <SurvivalTable
        title={`Survival by Agent (${SCORED_WINDOW}, code)`}
        note="Agent and skill manifests. This is the signal agent-auditor's D7 scores."
        rows={code.filter(r => r.cohort === SURVIVAL_COHORT.SCORED)}
        warnBelowThreshold
      />
      <SurvivalTable
        title={`Baseline Agents (${SCORED_WINDOW}, code)`}
        note="Agents with no manifest to tune (general-purpose, claude, self-forks). The comparison group — never scored."
        rows={code.filter(r => r.cohort === SURVIVAL_COHORT.BASELINE)}
        warnBelowThreshold={false}
      />
      <SurvivalTable
        title={`Documentation (${SCORED_WINDOW})`}
        note="Doc-file survival, with status lines untracked and number-only edits counted as survived. Reported, never scored."
        rows={scoredWindow.filter(r => r.contentKind === CONTENT_KIND.DOC)}
        warnBelowThreshold={false}
      />
    </>
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
            <tr key={`${r.agentName}-${r.agentVersion}-${r.cohort}`}>
              <td className="mono">
                {r.agentName}
                <CohortBadge cohort={r.cohort} />
              </td>
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
            Survival checkpoints arrive 3, 7 and 21 days after each seed commit.
          </p>
          <p className="mt-2 text-secondary text-xs">
            Checkpoints are emitted by <code>ai.integritystudio.code-survival</code> every 6 hours.
            Run <code>launchctl print gui/$(id -u)/ai.integritystudio.code-survival</code> to verify the job is active.
          </p>
        </div>
      ) : (
        <>
          <SurvivalSections rows={data.survivalByAgentWindow} />
          <VersionRolloutTable rows={data.versionRollout} />
        </>
      )}
    </PageShell>
  );
}
