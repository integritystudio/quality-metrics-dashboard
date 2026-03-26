import { useState } from 'react';
import { WorkflowGraphView } from './WorkflowGraph.js';
import { WorkflowTimeline } from './WorkflowTimeline.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation } from '../types.js';

type WorkflowTab = 'dag' | 'timeline';

interface AgentWorkflowViewProps {
  graph: WorkflowGraph;
  evaluation?: MultiAgentEvaluation;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

const TAB_LABELS: Record<WorkflowTab, string> = {
  dag: 'DAG',
  timeline: 'Timeline',
};

const TABS: WorkflowTab[] = ['dag', 'timeline'];

export function AgentWorkflowView({
  graph,
  evaluation,
  onNodeClick,
  height = 600,
}: AgentWorkflowViewProps) {
  const [activeTab, setActiveTab] = useState<WorkflowTab>('dag');

  const agentNames = [...new Set(
    (evaluation?.turns ?? []).map(t => t.agentName ?? 'unknown'),
  )];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Workflow view"
        className="flex-center gap-0 workflow-tabs"
      >
        {TABS.map(tab => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`workflow-tab-${tab}`}
            aria-selected={activeTab === tab}
            aria-controls={`workflow-panel-${tab}`}
            onClick={() => setActiveTab(tab)}
            className="btn-reset workflow-tab"
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="workflow-panel-dag"
        aria-labelledby="workflow-tab-dag"
        hidden={activeTab !== 'dag'}
      >
        <WorkflowGraphView
          graph={graph}
          onNodeClick={onNodeClick}
          height={height}
        />
      </div>

      <div
        role="tabpanel"
        id="workflow-panel-timeline"
        aria-labelledby="workflow-tab-timeline"
        hidden={activeTab !== 'timeline'}
      >
        <WorkflowTimeline
          turns={evaluation?.turns ?? []}
          handoffs={evaluation?.handoffs ?? []}
          agentNames={agentNames}
        />
      </div>
    </div>
  );
}
