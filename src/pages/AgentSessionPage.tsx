import { useAgentSession } from '../hooks/useAgentSession.js';
import { TurnTimeline } from '../components/TurnTimeline.js';
import { HandoffCard } from '../components/HandoffCard.js';
import { AgentScoreSummary } from '../components/AgentScoreSummary.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
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
          <DetailPageHeader title="Agent Session" id={sessionId}>
            <span className="text-secondary text-xs">
              {plural(evaluation.totalTurns, 'turn')} &middot; {plural(agentNames.length, 'agent')}
            </span>
          </DetailPageHeader>

          {/* Summary scores */}
          <div className="card flex-wrap gap-6" style={{ padding: 16, marginBottom: 16, alignItems: 'flex-start' }}>
            <AgentScoreSummary handoffScore={evaluation.handoffScore ?? 0} avgRelevance={evaluation.avgTurnRelevance ?? 0} completeness={evaluation.conversationCompleteness ?? 0} />
            {evaluation.errorPropagationTurns > 0 && (
              <div className="text-center">
                <div className="mono-xs text-muted mb-1 uppercase">Error Propagation</div>
                <span className="mono text-md text-critical">
                  {plural(evaluation.errorPropagationTurns, 'turn')}
                </span>
              </div>
            )}
          </div>

          {/* Turn timeline */}
          <ViewSection title="Turn Timeline">
            <div className="card">
              <TurnTimeline turns={turns} agentNames={agentNames} />
            </div>
          </ViewSection>

          {/* Handoffs */}
          {handoffs.length > 0 && (
            <ViewSection title="Handoffs">
              <div className="flex-col gap-2">
                {handoffs.map((h, i) => (
                  <HandoffCard key={`${h.sourceAgent}-${h.targetAgent}-${i}`} handoff={h} />
                ))}
              </div>
            </ViewSection>
          )}
        </>
      )}
    </PageShell>
  );
}
