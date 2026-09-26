import { useLocation } from 'wouter';
import { useAgentSession } from '../hooks/useAgentSession.js';
import { AgentWorkflowView } from '../components/AgentWorkflowView.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { plural } from '../lib/quality-utils.js';
import { routes } from '../lib/routes.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

export function WorkflowPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);
  const [, navigate] = useLocation();

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data && (
        <>
          <DetailPageHeader title="Workflow" id={sessionId}>
            <span className="text-secondary text-xs">
              {data.graph.workflowShape} &middot; {plural(data.graph.nodes.length, 'agent')}
            </span>
          </DetailPageHeader>
          <div className="card">
            <AgentWorkflowView
              graph={data.graph}
              evaluation={data.evaluation}
              onNodeClick={nodeId => navigate(routes.agentSession(sessionId, nodeId))}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}
