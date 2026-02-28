import { Link } from 'wouter';
import { useAgentStats } from '../hooks/useAgentStats.js';
import { AgentActivityPanel, AgentActivitySummary } from '../components/AgentActivityPanel.js';
import type { Period } from '../types.js';

export function AgentsPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useAgentStats(period);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="card skeleton" style={{ height: 300 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="error-state">
          <h2>Failed to load</h2>
          <p>{error.message}</p>
        </div>
      </div>
    );
  }

  const agents = data?.agents ?? [];

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      <div className="eval-detail-header">
        <h2 style={{ fontSize: 18 }}>Agent Activity</h2>
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
    </div>
  );
}
