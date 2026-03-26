import { useState } from 'react';
import { WorkflowGraphView } from './WorkflowGraph.js';
import { WorkflowTimeline } from './WorkflowTimeline.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkflowTab = 'dag' | 'timeline';

interface AgentWorkflowViewProps {
  graph: WorkflowGraph;
  evaluation?: MultiAgentEvaluation;
  onNodeClick?: (nodeId: string) => void;
  height?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_LABELS: Record<WorkflowTab, string> = {
  dag: 'DAG',
  timeline: 'Timeline',
};

const TABS: WorkflowTab[] = ['dag', 'timeline'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
      {/* ARIA tablist */}
      <div
        role="tablist"
        aria-label="Workflow view"
        className="flex-center gap-0"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          marginBottom: 'var(--space-3)',
        }}
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
            className="text-xs font-semibold cursor-pointer btn-reset"
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderBottom: activeTab === tab
                ? '2px solid var(--accent)'
                : '2px solid transparent',
              color: activeTab === tab ? 'var(--accent)' : 'var(--text-muted)',
              transition: 'color var(--transition-fast), border-color var(--transition-fast)',
            }}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* DAG panel */}
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

      {/* Timeline panel */}
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
