import React, { useState, useCallback } from 'react';
import { WorkflowGraphView } from './WorkflowGraph.js';
import { WorkflowTimeline } from './WorkflowTimeline.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation } from '../types.js';
import { agentColor } from '../lib/quality-utils.js';
import { WORKFLOW_FILTER_MIN_AGENTS } from '../lib/constants.js';

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

  // Filter state: all agents selected by default (null = all selected, avoids Set churn on load)
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string> | null>(null);

  const effectiveSelected: ReadonlySet<string> = selectedAgents ?? new Set(agentNames);

  const toggleAgent = useCallback((name: string) => {
    setSelectedAgents(prev => {
      const base = prev ?? new Set(agentNames);
      const next = new Set(base);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      // If all agents re-selected, reset to null (all-on)
      if (next.size === agentNames.length) return null;
      return next;
    });
  }, [agentNames]);

  const selectAll = useCallback(() => setSelectedAgents(null), []);

  const showFilter = agentNames.length >= WORKFLOW_FILTER_MIN_AGENTS;

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

      {showFilter && (
        <div className="workflow-filter" role="group" aria-label="Filter agents">
          {agentNames.map(name => {
            const color = agentColor(name, agentNames);
            const active = effectiveSelected.has(name);
            return (
              <button
                key={name}
                type="button"
                className="btn-reset eval-filter-chip workflow-filter__chip mono-xs"
                style={{ '--chip-color': color } as React.CSSProperties}
                data-active={active || undefined}
                aria-pressed={active}
                onClick={() => toggleAgent(name)}
              >
                {name}
              </button>
            );
          })}
          {selectedAgents !== null && (
            <button
              type="button"
              className="btn-reset workflow-filter__reset text-xs text-muted"
              onClick={selectAll}
            >
              All
            </button>
          )}
        </div>
      )}

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
          selectedAgents={showFilter ? effectiveSelected : undefined}
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
          selectedAgents={showFilter ? effectiveSelected : undefined}
        />
      </div>
    </div>
  );
}
