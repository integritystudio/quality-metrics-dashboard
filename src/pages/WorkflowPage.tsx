import { useAgentSession } from '../hooks/useAgentSession.js';
import { WorkflowGraphView } from '../components/WorkflowGraph.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

export function WorkflowPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data?.graph && (
        <>
          <DetailPageHeader title="Workflow" id={sessionId}>
            <span className="text-secondary text-xs">
              {data.graph.workflowShape} &middot; {data.graph.nodes.length} agents
            </span>
          </DetailPageHeader>
          <div className="card">
            <WorkflowGraphView
              graph={data.graph}
              onNodeClick={(nodeId) => {
                window.location.hash = `/agents/${sessionId}?agent=${nodeId}`;
              }}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}
