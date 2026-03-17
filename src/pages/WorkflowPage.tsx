import { useCallback } from 'react';
import { useLocation } from 'wouter';
import { useAgentSession } from '../hooks/useAgentSession.js';
import { WorkflowGraphView } from '../components/WorkflowGraph.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

export function WorkflowPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useAgentSession(sessionId);
  const [, navigate] = useLocation();

  const handleNodeClick = useCallback((nodeId: string) => {
    navigate(`/agents/${encodeURIComponent(sessionId)}?agent=${encodeURIComponent(nodeId)}`);
  }, [sessionId, navigate]);

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
              onNodeClick={handleNodeClick}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}
