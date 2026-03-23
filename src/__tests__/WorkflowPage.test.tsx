import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { LinkProps, WorkflowGraphViewProps, DetailPageHeaderProps, PageShellProps } from './test-types.js';

// ---------------------------------------------------------------------------
// Mock useAgentSession
// ---------------------------------------------------------------------------

const mockUseAgentSession = vi.fn();
vi.mock('../hooks/useAgentSession.js', () => ({
  useAgentSession: (...args: unknown[]) => mockUseAgentSession(...args),
}));

// ---------------------------------------------------------------------------
// Mock wouter — capture navigate calls
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('wouter', () => ({
  useLocation: () => ['/', mockNavigate],
  Link: ({ href, children, ...rest }: LinkProps) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// ---------------------------------------------------------------------------
// Mock WorkflowGraphView — stub renders testid, fires onNodeClick
// ---------------------------------------------------------------------------

vi.mock('../components/WorkflowGraph.js', () => ({
  WorkflowGraphView: ({ graph, onNodeClick }: WorkflowGraphViewProps) => (
    <div data-testid="workflow-graph-view">
      {(graph.nodes ?? []).map(n => (
        <button
          key={n.id}
          data-testid={`graph-node-${n.id}`}
          onClick={() => onNodeClick?.(n.id)}
        >
          {n.label}
        </button>
      ))}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock DetailPageHeader — renders title and children
// ---------------------------------------------------------------------------

vi.mock('../components/DetailPageHeader.js', () => ({
  DetailPageHeader: ({ title, id, children }: DetailPageHeaderProps) => (
    <div data-testid="detail-page-header">
      <h2>{title}</h2>
      {id && <span data-testid="header-id">{id}</span>}
      {children}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock PageShell — renders children directly (no loading/error state needed
// for most tests; tests that need loading/error states override the mock)
// ---------------------------------------------------------------------------

vi.mock('../components/PageShell.js', () => ({
  PageShell: ({ isLoading, error, children }: PageShellProps) => {
    if (isLoading) return <div data-testid="page-shell-loading" />;
    if (error) return <div data-testid="page-shell-error">{error.message}</div>;
    return <div data-testid="page-shell">{children}</div>;
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { WorkflowPage } from '../pages/WorkflowPage.js';
import { AgentSessionPage } from '../pages/AgentSessionPage.js';
import type { WorkflowGraph, WorkflowNode } from '../types/workflow-graph.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    label: 'planner-agent',
    evaluationScore: null,
    toolCallCount: 2,
    totalTokens: null,
    durationMs: 500,
    turnCount: 1,
    hasError: false,
    ...overrides,
  };
}

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [makeNode()],
    edges: [],
    rootNodeId: 'node-1',
    workflowShape: 'linear',
    ...overrides,
  };
}

function makeAgentSessionData(graph: WorkflowGraph | null | undefined = makeGraph()) {
  return {
    sessionId: 'session-abc',
    spans: [],
    evaluation: {
      totalTurns: 3,
      handoffs: [],
      turns: [],
      handoffScore: 0.9,
      avgTurnRelevance: 0.8,
      conversationCompleteness: 0.75,
      errorPropagationTurns: 0,
    },
    evaluations: [],
    agentMap: {},
    graph,
  };
}

// ---------------------------------------------------------------------------
// WorkflowPage tests
// ---------------------------------------------------------------------------

describe('WorkflowPage', () => {
  describe('when data has a valid graph', () => {
    beforeEach(() => {
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(makeGraph()),
        isLoading: false,
        error: null,
      });
    });

    it('renders WorkflowGraphView when graph is present', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByTestId('workflow-graph-view')).toBeInTheDocument();
    });

    it('renders DetailPageHeader with title "Workflow"', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByRole('heading', { name: 'Workflow' })).toBeInTheDocument();
    });

    it('displays the workflow shape in the header', () => {
      const graph = makeGraph({ workflowShape: 'branching' });
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(graph),
        isLoading: false,
        error: null,
      });
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText(/branching/)).toBeInTheDocument();
    });

    it('displays agent count in the header', () => {
      const graph = makeGraph({
        nodes: [
          makeNode({ id: 'n1' }),
          makeNode({ id: 'n2' }),
          makeNode({ id: 'n3' }),
        ],
      });
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(graph),
        isLoading: false,
        error: null,
      });
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText(/3 agents/)).toBeInTheDocument();
    });

    it('calls useAgentSession with the provided sessionId', () => {
      render(<WorkflowPage sessionId="my-session-id" />);
      expect(mockUseAgentSession).toHaveBeenCalledWith('my-session-id');
    });
  });

  describe('when graph is null (data loaded but no graph)', () => {
    beforeEach(() => {
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(null),
        isLoading: false,
        error: null,
      });
    });

    it('does not render WorkflowGraphView', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.queryByTestId('workflow-graph-view')).not.toBeInTheDocument();
    });

    it('shows empty state message', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(
        screen.getByText(/No workflow graph available for this session/i)
      ).toBeInTheDocument();
    });
  });

  describe('when data is undefined (initial/loading state)', () => {
    beforeEach(() => {
      mockUseAgentSession.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      });
    });

    it('does not render WorkflowGraphView while loading', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.queryByTestId('workflow-graph-view')).not.toBeInTheDocument();
    });

    it('renders loading state via PageShell', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByTestId('page-shell-loading')).toBeInTheDocument();
    });
  });

  describe('onNodeClick navigation', () => {
    beforeEach(() => {
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(
          makeGraph({ nodes: [makeNode({ id: 'agent-node-42', label: 'executor' })] })
        ),
        isLoading: false,
        error: null,
      });
    });

    it('navigates to /agents/{sessionId}?agent={nodeId} when a node is clicked', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      fireEvent.click(screen.getByTestId('graph-node-agent-node-42'));
      expect(mockNavigate).toHaveBeenCalledWith(
        '/agents/session-abc?agent=agent-node-42'
      );
    });

    it('URL-encodes sessionId and nodeId in the navigation path', () => {
      mockUseAgentSession.mockReturnValue({
        data: makeAgentSessionData(
          makeGraph({ nodes: [makeNode({ id: 'node with spaces', label: 'test' })] })
        ),
        isLoading: false,
        error: null,
      });
      render(<WorkflowPage sessionId="session/with/slashes" />);
      fireEvent.click(screen.getByTestId('graph-node-node with spaces'));
      expect(mockNavigate).toHaveBeenCalledWith(
        '/agents/session%2Fwith%2Fslashes?agent=node%20with%20spaces'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// AgentSessionPage — "View Workflow" nav link
// ---------------------------------------------------------------------------

describe('AgentSessionPage', () => {
  const SESSION_ID = 'session-xyz';

  function makeEvaluation(overrides: Record<string, unknown> = {}) {
    return {
      totalTurns: 2,
      handoffs: [],
      turns: [{ agentName: 'agent-1', turnIndex: 0 }],
      handoffScore: 0.8,
      avgTurnRelevance: 0.7,
      conversationCompleteness: 0.9,
      errorPropagationTurns: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockUseAgentSession.mockReturnValue({
      data: {
        sessionId: SESSION_ID,
        spans: [],
        evaluation: makeEvaluation(),
        evaluations: [],
        agentMap: {},
        graph: makeGraph(),
      },
      isLoading: false,
      error: null,
    });
  });

  it('renders a "View Workflow" link', () => {
    render(<AgentSessionPage sessionId={SESSION_ID} />);
    expect(screen.getByRole('link', { name: /view workflow/i })).toBeInTheDocument();
  });

  it('"View Workflow" link points to /workflows/{sessionId}', () => {
    render(<AgentSessionPage sessionId={SESSION_ID} />);
    const link = screen.getByRole('link', { name: /view workflow/i });
    expect(link).toHaveAttribute('href', `/workflows/${SESSION_ID}`);
  });
});
