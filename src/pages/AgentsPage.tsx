import { useAgentStats } from '../hooks/useAgentStats.js';
import { AgentActivityPanel, AgentActivitySummary } from '../components/AgentActivityPanel.js';
import { PageShell } from '../components/PageShell.js';
import type { Period } from '../types.js';

export function AgentsPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useAgentStats(period);

  const agents = data?.agents ?? [];

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={300}>
      <div className="eval-detail-header">
        <h2 className="page-heading">Agent Activity</h2>
        <div className="eval-detail-meta">
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {data?.startDate} &ndash; {data?.endDate}
          </span>
        </div>
      </div>

      {agents.length > 0 && <AgentActivitySummary agents={agents} />}

      <div className="card">
        <AgentActivityPanel agents={agents} />
      </div>
    </PageShell>
  );
}
