import { Link } from 'wouter';
import { useAgentSession } from '../hooks/useAgentSession.js';
import { TurnTimeline } from '../components/TurnTimeline.js';
import { HandoffCard } from '../components/HandoffCard.js';
import { ScoreBadge } from '../components/ScoreBadge.js';

export function AgentSessionPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);

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
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      </div>
    );
  }

  if (!data) return null;

  const { evaluation } = data;
  const agentNames = [...new Set(evaluation.turns.map(t => t.agentName ?? 'unknown'))];

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      <div className="eval-detail-header">
        <h2 style={{ fontSize: 18 }}>Agent Session</h2>
        <div className="eval-detail-meta">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {sessionId}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {evaluation.totalTurns} turn{evaluation.totalTurns !== 1 ? 's' : ''} &middot; {agentNames.length} agent{agentNames.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Summary scores */}
      <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: 16, marginBottom: 16 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Handoff Score</div>
          <ScoreBadge score={evaluation.handoffScore} metricName="handoff" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Avg Relevance</div>
          <ScoreBadge score={evaluation.avgTurnRelevance} metricName="relevance" />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Completeness</div>
          <ScoreBadge score={evaluation.conversationCompleteness} metricName="completeness" />
        </div>
        {evaluation.errorPropagationTurns > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>Error Propagation</div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 16, color: 'var(--status-critical)' }}>
              {evaluation.errorPropagationTurns} turn{evaluation.errorPropagationTurns !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Turn timeline */}
      <div className="view-section">
        <h3 className="section-heading">Turn Timeline</h3>
        <div className="card">
          <TurnTimeline turns={evaluation.turns} agentNames={agentNames} />
        </div>
      </div>

      {/* Handoffs */}
      {evaluation.handoffs.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Handoffs</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {evaluation.handoffs.map((h, i) => (
              <HandoffCard key={`${h.sourceAgent}-${h.targetAgent}-${i}`} handoff={h} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
