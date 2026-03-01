import { useAgentSession } from '../hooks/useAgentSession.js';
import { TurnTimeline } from '../components/TurnTimeline.js';
import { HandoffCard } from '../components/HandoffCard.js';
import { AgentScoreSummary } from '../components/AgentScoreSummary.js';
import { PageShell } from '../components/PageShell.js';
import { plural } from '../lib/quality-utils.js';

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
            <h2 className="text-lg">Agent Session</h2>
            <div className="eval-detail-meta">
              <span className="mono-xs text-secondary">{sessionId}</span>
              <span className="text-secondary text-xs">
                {plural(evaluation.totalTurns, 'turn')} &middot; {plural(agentNames.length, 'agent')}
              </span>
            </div>
          </div>

          {/* Summary scores */}
          <div className="card gap-6" style={{ display: 'flex', flexWrap: 'wrap', padding: 16, marginBottom: 16, alignItems: 'flex-start' }}>
            <AgentScoreSummary handoffScore={evaluation.handoffScore ?? 0} avgRelevance={evaluation.avgTurnRelevance ?? 0} completeness={evaluation.conversationCompleteness ?? 0} />
            {evaluation.errorPropagationTurns > 0 && (
              <div style={{ textAlign: 'center' }}>
                <div className="mono-xs text-muted mb-1 uppercase">Error Propagation</div>
                <span className="mono text-md" style={{ color: 'var(--status-critical)' }}>
                  {plural(evaluation.errorPropagationTurns, 'turn')}
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
              <div className="gap-2" style={{ display: 'flex', flexDirection: 'column' }}>
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
