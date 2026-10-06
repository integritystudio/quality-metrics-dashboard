import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { LinkProps, DetailPageHeaderProps, PageShellProps } from './test-types.js';
import type { AgentWorkflowView } from '../components/AgentWorkflowView.js';

/**
 * Only the three fields WorkflowPage destructures off the query result —
 * typed so the mock cannot hand the page a `data` shape the real
 * `useAgentWorkflow` could never return.
 */
interface AgentWorkflowQueryResult {
  data: AgentWorkflowResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}

const mockUseAgentWorkflow = vi.fn<(sessionId: string) => AgentWorkflowQueryResult>();
vi.mock('../hooks/useAgentSession.js', () => ({
  useAgentWorkflow: (sessionId: string) => mockUseAgentWorkflow(sessionId),
}));

// Mock wouter — capture navigate calls

const mockNavigate = vi.fn();
vi.mock('wouter', () => ({
  useLocation: () => ['/', mockNavigate],
  Link: ({ href, children, ...rest }: LinkProps) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Mock AgentWorkflowView, the page's direct child — stub renders testid, fires onNodeClick.
// Its own forwarding to the graph is covered in WorkflowTimeline.test.tsx.

vi.mock('../components/AgentWorkflowView.js', () => ({
  AgentWorkflowView: ({ graph, onNodeClick }: ComponentProps<typeof AgentWorkflowView>) => (
    <div data-testid="agent-workflow-view">
      {graph.nodes.map(n => (
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

// Mock DetailPageHeader — renders title and children

vi.mock('../components/DetailPageHeader.js', () => ({
  DetailPageHeader: ({ title, children }: DetailPageHeaderProps) => (
    <div data-testid="detail-page-header">
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));

// Mock PageShell — loading/error placeholders, otherwise renders children

vi.mock('../components/PageShell.js', () => ({
  PageShell: ({ isLoading, error, children }: PageShellProps) => {
    if (isLoading) return <div data-testid="page-shell-loading" />;
    if (error) return <div data-testid="page-shell-error">{error.message}</div>;
    return <div data-testid="page-shell">{children}</div>;
  },
}));

// Imports (after mocks)

import { WorkflowPage } from '../pages/WorkflowPage.js';
import { makeNode, makeGraph, makeEvaluation } from './workflow-fixtures.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';
import type { AgentWorkflowResponse } from '../hooks/useAgentSession.js';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockLoaded(graph: WorkflowGraph | null = makeGraph()) {
  mockUseAgentWorkflow.mockReturnValue({
    data: {
      sessionId: 'session-abc',
      evaluation: makeEvaluation(),
      graph,
    },
    isLoading: false,
    error: null,
  });
}

describe('WorkflowPage', () => {
  describe('when data has a valid graph', () => {
    beforeEach(() => mockLoaded());

    it('renders AgentWorkflowView when graph is present', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByTestId('agent-workflow-view')).toBeInTheDocument();
    });

    it('renders DetailPageHeader with title "Workflow"', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByRole('heading', { name: 'Workflow' })).toBeInTheDocument();
    });

    it('displays the workflow shape in the header', () => {
      mockLoaded(makeGraph({ workflowShape: 'branching' }));
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText(/branching/)).toBeInTheDocument();
    });

    it('displays agent count in the header', () => {
      mockLoaded(makeGraph({
        nodes: [
          makeNode({ id: 'n1' }),
          makeNode({ id: 'n2' }),
          makeNode({ id: 'n3' }),
        ],
      }));
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText(/3 agents/)).toBeInTheDocument();
    });

    it('uses the singular for a one-agent graph', () => {
      mockLoaded(makeGraph({ nodes: [makeNode({ id: 'n1' })] }));
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText(/1 agent$/)).toBeInTheDocument();
    });

    it('calls useAgentWorkflow with the provided sessionId', () => {
      render(<WorkflowPage sessionId="my-session-id" />);
      expect(mockUseAgentWorkflow).toHaveBeenCalledWith('my-session-id');
    });
  });

  describe('when the session has no precomputed graph', () => {
    beforeEach(() => mockLoaded(null));

    it('renders an empty state instead of the graph', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByText('No workflow graph for this session')).toBeInTheDocument();
      expect(screen.queryByTestId('agent-workflow-view')).not.toBeInTheDocument();
    });
  });

  describe('when data is undefined (initial/loading state)', () => {
    beforeEach(() => {
      mockUseAgentWorkflow.mockReturnValue({
        data: undefined,
        isLoading: true,
        error: null,
      });
    });

    it('does not render AgentWorkflowView while loading', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.queryByTestId('agent-workflow-view')).not.toBeInTheDocument();
    });

    it('renders loading state via PageShell', () => {
      render(<WorkflowPage sessionId="session-abc" />);
      expect(screen.getByTestId('page-shell-loading')).toBeInTheDocument();
    });
  });

  describe('onNodeClick navigation', () => {
    it('navigates to /agents/{sessionId}?agent={nodeId} when a node is clicked', () => {
      mockLoaded(makeGraph({ nodes: [makeNode({ id: 'agent-node-42', label: 'executor' })] }));
      render(<WorkflowPage sessionId="session-abc" />);
      fireEvent.click(screen.getByTestId('graph-node-agent-node-42'));
      expect(mockNavigate).toHaveBeenCalledWith(
        '/agents/session-abc?agent=agent-node-42'
      );
    });

    it('URL-encodes sessionId and nodeId in the navigation path', () => {
      mockLoaded(makeGraph({ nodes: [makeNode({ id: 'node with spaces', label: 'test' })] }));
      render(<WorkflowPage sessionId="session/with/slashes" />);
      fireEvent.click(screen.getByTestId('graph-node-node with spaces'));
      expect(mockNavigate).toHaveBeenCalledWith(
        '/agents/session%2Fwith%2Fslashes?agent=node%20with%20spaces'
      );
    });
  });
});
