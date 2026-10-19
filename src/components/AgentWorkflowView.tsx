import React, { useState, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { max } from 'd3-array';
import { WorkflowGraphView } from './WorkflowGraph.js';
import { WorkflowTimeline } from './WorkflowTimeline.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { MultiAgentEvaluation } from '../types.js';
import { agentColorScale, fmtDuration } from '../lib/quality-utils.js';
import { criticalPath } from '../lib/critical-path.js';
import { WORKFLOW_FILTER_MIN_AGENTS, WORKFLOW_GRAPH_HEIGHT } from '../lib/constants.js';

type WorkflowTab = 'dag' | 'timeline';

/** Positions the duration filter slider offers across its range. */
const DURATION_SLIDER_STEPS = 200;

type AgentWorkflowViewProps = {
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

/** One chip per agent, plus the reset that clears the selection. */
function WorkflowAgentFilter({ agentNames, colorOf, selected, filterActive, onToggle, onSelectAll }: {
  agentNames: readonly string[];
  colorOf: (name: string) => string;
  selected: ReadonlySet<string>;
  filterActive: boolean;
  onToggle: (name: string) => void;
  onSelectAll: () => void;
}): ReactNode {
  return (
    <div className="workflow-filter" role="group" aria-label="Filter agents">
      {agentNames.map(name => {
        const color = colorOf(name);
        const active = selected.has(name);
        return (
          <button
            key={name}
            type="button"
            className="btn-reset eval-filter-chip workflow-filter__chip mono-xs"
            // Agent palette is data-driven; cannot be expressed as static CSS classes
            style={{ '--chip-color': color } as React.CSSProperties}
            data-active={active || undefined}
            aria-pressed={active}
            onClick={() => onToggle(name)}
          >
            {name}
          </button>
        );
      })}
      {filterActive && (
        <button
          type="button"
          className="btn-reset workflow-filter__reset text-xs text-muted"
          onClick={onSelectAll}
        >
          All
        </button>
      )}
    </div>
  );
}

/** Duration threshold, the two dimming toggles, and the PNG export. */
function WorkflowGraphControls({
  maxDurationMs,
  minDurationMs,
  onMinDurationChange,
  errorsOnly,
  onErrorsOnlyToggle,
  showCriticalPath,
  onCriticalPathToggle,
  onExport,
}: {
  maxDurationMs: number;
  minDurationMs: number;
  onMinDurationChange: (ms: number) => void;
  errorsOnly: boolean;
  onErrorsOnlyToggle: () => void;
  showCriticalPath: boolean;
  onCriticalPathToggle: () => void;
  onExport: () => void;
}): ReactNode {
  const sliderStep = Math.max(1, Math.round(maxDurationMs / DURATION_SLIDER_STEPS));
  return (
    <div className="workflow-filter__controls" role="group" aria-label="Graph controls">
      <label className="workflow-filter__label">
        Min duration
        <input
          type="range"
          min={0}
          max={maxDurationMs}
          step={sliderStep}
          value={minDurationMs}
          onChange={e => onMinDurationChange(Number(e.target.value))}
          className="workflow-filter__slider"
          aria-label={`Minimum agent duration: ${fmtDuration(minDurationMs)}`}
        />
        <span className="workflow-filter__slider-value mono-xs">
          {minDurationMs > 0 ? `≥ ${fmtDuration(minDurationMs)}` : 'any'}
        </span>
      </label>
      <button
        type="button"
        className="btn-reset eval-filter-chip workflow-filter__chip eval-filter-chip--error"
        data-active={errorsOnly || undefined}
        aria-pressed={errorsOnly}
        onClick={onErrorsOnlyToggle}
      >
        Errors only
      </button>
      <button
        type="button"
        className="btn-reset eval-filter-chip workflow-filter__chip eval-filter-chip--accent"
        data-active={showCriticalPath || undefined}
        aria-pressed={showCriticalPath}
        onClick={onCriticalPathToggle}
      >
        Critical path
      </button>
      <button
        type="button"
        className="btn-reset workflow-filter__export mono-xs"
        onClick={onExport}
        aria-label="Export graph as PNG"
      >
        Export PNG
      </button>
    </div>
  );
}

export function AgentWorkflowView({
  graph,
  evaluation,
  onNodeClick,
  height = WORKFLOW_GRAPH_HEIGHT,
}: AgentWorkflowViewProps) {
  const [activeTab, setActiveTab] = useState<WorkflowTab>('dag');

  const agentNames = useMemo(
    () => [...new Set((evaluation?.turns ?? []).map(t => t.agentName ?? 'unknown'))],
    [evaluation?.turns],
  );

  // Filter state: all agents selected by default (null = all selected, avoids Set churn on load)
  const [selectedAgents, setSelectedAgents] = useState<ReadonlySet<string> | null>(null);

  const [minDurationMs, setMinDurationMs] = useState(0);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [showCriticalPath, setShowCriticalPath] = useState(false);

  const graphContainerRef = useRef<HTMLDivElement>(null);

  const effectiveSelected: ReadonlySet<string> = useMemo(
    () => selectedAgents ?? new Set(agentNames),
    [selectedAgents, agentNames],
  );

  const maxDurationMs = useMemo(
    () => Math.max(0, max(graph.nodes, n => n.durationMs) ?? 0),
    [graph.nodes],
  );

  // Critical path: longest chain from root to leaf by cumulative durationMs
  const criticalPathSet = useMemo((): ReadonlySet<string> | undefined => {
    if (!showCriticalPath || graph.nodes.length === 0 || graph.rootNodeId === null) return undefined;
    return new Set(criticalPath(graph));
  }, [showCriticalPath, graph]);

  // Unified filter set passed to the graph: combines agent name, duration, and error filters.
  // Returns undefined when no filters are active (no dimming).
  const filteredNodeIds = useMemo((): ReadonlySet<string> | undefined => {
    const hasAgentFilter = selectedAgents !== null;
    const hasDurFilter = minDurationMs > 0;
    const hasErrFilter = errorsOnly;
    if (!hasAgentFilter && !hasDurFilter && !hasErrFilter) return undefined;

    let result = new Set(graph.nodes.map(n => n.id));
    if (hasAgentFilter) {
      result = new Set([...result].filter(id => selectedAgents.has(id)));
    }
    if (hasDurFilter) {
      const durPass = new Set(graph.nodes.filter(n => n.durationMs >= minDurationMs).map(n => n.id));
      result = new Set([...result].filter(id => durPass.has(id)));
    }
    if (hasErrFilter) {
      const errPass = new Set(graph.nodes.filter(n => n.hasError).map(n => n.id));
      result = new Set([...result].filter(id => errPass.has(id)));
    }
    return result;
  }, [selectedAgents, minDurationMs, errorsOnly, graph.nodes]);

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
  const toggleErrorsOnly = useCallback(() => setErrorsOnly(v => !v), []);
  const toggleCriticalPath = useCallback(() => setShowCriticalPath(v => !v), []);

  const handleExport = useCallback(async () => {
    const el = graphContainerRef.current;
    if (!el) return;
    const { toPng } = await import('html-to-image');
    const dataUrl = await toPng(el, { cacheBust: true });
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = 'workflow-graph.png';
    link.click();
  }, []);

  const exportPng = useCallback(() => void handleExport(), [handleExport]);

  const colorOf = useMemo(() => agentColorScale(agentNames), [agentNames]);
  const showFilter = agentNames.length >= WORKFLOW_FILTER_MIN_AGENTS;
  const showControls = graph.nodes.length > 0;

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
        <WorkflowAgentFilter
          agentNames={agentNames}
          colorOf={colorOf}
          selected={effectiveSelected}
          filterActive={selectedAgents !== null}
          onToggle={toggleAgent}
          onSelectAll={selectAll}
        />
      )}

      {showControls && (
        <WorkflowGraphControls
          maxDurationMs={maxDurationMs}
          minDurationMs={minDurationMs}
          onMinDurationChange={setMinDurationMs}
          errorsOnly={errorsOnly}
          onErrorsOnlyToggle={toggleErrorsOnly}
          showCriticalPath={showCriticalPath}
          onCriticalPathToggle={toggleCriticalPath}
          onExport={exportPng}
        />
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
          selectedAgents={filteredNodeIds}
          criticalPath={criticalPathSet}
          containerRef={graphContainerRef}
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
