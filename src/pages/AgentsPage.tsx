import { useAgentStats } from '../hooks/useAgentStats.js';
import { AgentActivityPanel, AgentActivitySummary } from '../components/AgentActivityPanel.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import type { Period } from '../types.js';

export function AgentsPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useAgentStats(period);

  const agents = data?.agents ?? [];

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={300}>
      <DetailPageHeader title="Agent Activity">
        <span className="text-secondary text-xs">
          {data?.startDate} &ndash; {data?.endDate}
        </span>
      </DetailPageHeader>

      {agents.length > 0 && <AgentActivitySummary agents={agents} />}

      <div className="card">
        <AgentActivityPanel agents={agents} />
      </div>
    </PageShell>
  );
}
