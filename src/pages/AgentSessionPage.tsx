import { useAgentSession } from '../hooks/useAgentSession.js';
import { TurnTimeline } from '../components/TurnTimeline.js';
import { HandoffCard } from '../components/HandoffCard.js';
import { AgentScoreSummary } from '../components/AgentScoreSummary.js';
import { PageShell } from '../components/PageShell.js';

export function AgentSessionPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);

  if (!isLoading && !error && !data) return null;

  const evaluation = data?.evaluation;
  const turns = evaluation?.turns ?? [];
  const handoffs = evaluation?.handoffs ?? [];
  const agentNames = [...new Set(turns.map(t => t.agentName ?? 'unknown'))];

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={300}>
      {data && evaluation && (
        <>
          <div className="eval-detail-header">
            <h2 className="page-heading">Agent Session</h2>
            <div className="eval-detail-meta">
              <span className="id-chip">{sessionId}</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {evaluation.totalTurns} turn{evaluation.totalTurns !== 1 ? 's' : ''} &middot; {agentNames.length} agent{agentNames.length !== 1 ? 's' : ''}
              </span>
            </div>
          </div>

          {/* Summary scores */}
          <div className="card" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: 16, marginBottom: 16, alignItems: 'flex-start' }}>
            <AgentScoreSummary handoffScore={evaluation.handoffScore ?? 0} avgRelevance={evaluation.avgTurnRelevance ?? 0} completeness={evaluation.conversationCompleteness ?? 0} />
            {evaluation.errorPropagationTurns > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Error Propagation</div>
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
              <TurnTimeline turns={turns} agentNames={agentNames} />
            </div>
          </div>

          {/* Handoffs */}
          {handoffs.length > 0 && (
            <div className="view-section">
              <h3 className="section-heading">Handoffs</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {handoffs.map((h, i) => (
                  <HandoffCard key={`${h.sourceAgent}-${h.targetAgent}-${i}`} handoff={h} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
