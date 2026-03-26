import { Link } from 'wouter';
import { useAgentSession } from '../hooks/useAgentSession.js';
import { TurnTimeline } from '../components/TurnTimeline.js';
import { HandoffCard } from '../components/HandoffCard.js';
import { AgentScoreSummary } from '../components/AgentScoreSummary.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { plural } from '../lib/quality-utils.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

export function AgentSessionPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);

  if (!isLoading && !error && !data) return null;

  const evaluation = data?.evaluation;
  const turns = evaluation?.turns ?? [];
  const handoffs = evaluation?.handoffs ?? [];
  const agentNames = [...new Set(turns.map(t => t.agentName ?? 'unknown'))];

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data && evaluation && (
        <>
          <DetailPageHeader title="Agent Session" id={sessionId}>
            <span className="text-secondary text-xs">
              {plural(evaluation.totalTurns, 'turn')} &middot; {plural(agentNames.length, 'agent')}
            </span>
            <Link href={`/workflows/${sessionId}`} className="text-xs text-link">View Workflow</Link>
          </DetailPageHeader>

          <div className="card flex-wrap gap-6 p-4 mb-4 align-start">
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

          <ViewSection title="Turn Timeline">
            <div className="card">
              <TurnTimeline turns={turns} agentNames={agentNames} />
            </div>
          </ViewSection>

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
