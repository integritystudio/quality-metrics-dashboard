import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// Mock WorkflowGraph — prevents ELK/ReactFlow instantiation in AgentWorkflowView tests

vi.mock('../components/WorkflowGraph.js', () => ({
  WorkflowGraphView: () => <div data-testid="workflow-graph-view" />,
}));

// Imports (after mocks)

import { WorkflowTimeline } from '../components/WorkflowTimeline.js';
import { AgentWorkflowView } from '../components/AgentWorkflowView.js';
import { makeNode, makeGraph, makeTurn, makeHandoff } from './workflow-fixtures.js';

// WorkflowTimeline tests

describe('WorkflowTimeline', () => {
  it('renders empty state when no turns', () => {
    render(<WorkflowTimeline turns={[]} agentNames={[]} />);
    expect(screen.getByText(/no turns to display/i)).toBeInTheDocument();
  });

  it('renders an SVG when turns are present', () => {
    const turns = [
      makeTurn({ turnIndex: 0, agentName: 'planner' }),
      makeTurn({ turnIndex: 1, agentName: 'executor' }),
    ];
    render(<WorkflowTimeline turns={turns} agentNames={['planner', 'executor']} />);
    expect(document.querySelector('svg')).toBeInTheDocument();
  });

  it('renders a lane per agent name in the SVG', () => {
    const turns = [
      makeTurn({ turnIndex: 0, agentName: 'planner' }),
      makeTurn({ turnIndex: 1, agentName: 'executor' }),
    ];
    const { container } = render(<WorkflowTimeline turns={turns} agentNames={['planner', 'executor']} />);
    // Each agent name appears as text in the SVG
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    const textContent = svg?.textContent ?? '';
    expect(textContent).toContain('planner');
    expect(textContent).toContain('executor');
  });

  it('renders aria-label with agent and turn count', () => {
    const turns = [
      makeTurn({ turnIndex: 0, agentName: 'planner' }),
      makeTurn({ turnIndex: 1, agentName: 'executor' }),
    ];
    render(
      <WorkflowTimeline
        turns={turns}
        agentNames={['planner', 'executor']}
      />,
    );
    const container = document.querySelector('[aria-label*="Workflow timeline"]');
    expect(container).not.toBeNull();
    expect(container?.getAttribute('aria-label')).toContain('2 agents');
    expect(container?.getAttribute('aria-label')).toContain('2 turns');
  });

  it('renders handoff connector when handoffs provided', () => {
    const turns = [
      makeTurn({ turnIndex: 0, agentName: 'planner' }),
      makeTurn({ turnIndex: 1, agentName: 'executor' }),
    ];
    const handoffs = [makeHandoff()];
    render(
      <WorkflowTimeline
        turns={turns}
        handoffs={handoffs}
        agentNames={['planner', 'executor']}
      />,
    );
    // Handoff aria-label on the group element
    expect(document.querySelector('[aria-label*="Handoff from planner"]')).not.toBeNull();
  });

  it('shows handoff legend text when handoffs are provided', () => {
    const turns = [makeTurn()];
    const handoffs = [makeHandoff()];
    render(
      <WorkflowTimeline
        turns={turns}
        handoffs={handoffs}
        agentNames={['planner']}
      />,
    );
    expect(screen.getByText(/dashed lines.*handoffs/i)).toBeInTheDocument();
  });

  it('does not show handoff legend when no handoffs', () => {
    render(
      <WorkflowTimeline
        turns={[makeTurn()]}
        agentNames={['planner']}
      />,
    );
    expect(screen.queryByText(/dashed lines/i)).not.toBeInTheDocument();
  });
});

// AgentWorkflowView tests

describe('AgentWorkflowView', () => {
  const graph = makeGraph({ nodes: [makeNode()] });

  it('renders DAG tab panel by default', () => {
    render(<AgentWorkflowView graph={graph} />);
    expect(screen.getByTestId('workflow-graph-view')).toBeInTheDocument();
  });

  it('renders a tablist with DAG and Timeline tabs', () => {
    render(<AgentWorkflowView graph={graph} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /dag/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /timeline/i })).toBeInTheDocument();
  });

  it('DAG tab is selected by default', () => {
    render(<AgentWorkflowView graph={graph} />);
    const dagTab = screen.getByRole('tab', { name: /dag/i });
    expect(dagTab).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to Timeline tab on click', () => {
    const turns = [makeTurn()];
    const evaluation = {
      turns,
      handoffs: [],
      handoffScore: null,
      avgTurnRelevance: null,
      conversationCompleteness: null,
      totalTurns: 1,
      errorPropagationTurns: 0,
    };
    render(<AgentWorkflowView graph={graph} evaluation={evaluation} />);

    const timelineTab = screen.getByRole('tab', { name: /timeline/i });
    fireEvent.click(timelineTab);

    expect(timelineTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /dag/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('hides DAG panel when Timeline tab is active', () => {
    render(<AgentWorkflowView graph={graph} />);
    fireEvent.click(screen.getByRole('tab', { name: /timeline/i }));

    const dagPanel = document.getElementById('workflow-panel-dag');
    expect(dagPanel).toHaveAttribute('hidden');
  });

  it('shows Timeline panel when Timeline tab is active', () => {
    const turns = [makeTurn()];
    const evaluation = {
      turns,
      handoffs: [],
      handoffScore: null,
      avgTurnRelevance: null,
      conversationCompleteness: null,
      totalTurns: 1,
      errorPropagationTurns: 0,
    };
    render(<AgentWorkflowView graph={graph} evaluation={evaluation} />);
    fireEvent.click(screen.getByRole('tab', { name: /timeline/i }));

    const timelinePanel = document.getElementById('workflow-panel-timeline');
    expect(timelinePanel).not.toHaveAttribute('hidden');
  });

  it('renders Timeline empty state when no evaluation provided', () => {
    render(<AgentWorkflowView graph={graph} />);
    fireEvent.click(screen.getByRole('tab', { name: /timeline/i }));
    expect(screen.getByText(/no turns to display/i)).toBeInTheDocument();
  });

  it('tab panels have correct aria-labelledby attributes', () => {
    render(<AgentWorkflowView graph={graph} />);
    expect(document.getElementById('workflow-panel-dag'))
      .toHaveAttribute('aria-labelledby', 'workflow-tab-dag');
    expect(document.getElementById('workflow-panel-timeline'))
      .toHaveAttribute('aria-labelledby', 'workflow-tab-timeline');
  });
});
