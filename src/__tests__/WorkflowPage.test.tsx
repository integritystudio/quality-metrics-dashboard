/**
 * WorkflowPage against the real `useAgentWorkflow` → `useApiQuery` → `apiFetch`
 * stack, the real `PageShell` and `DetailPageHeader`, and a memory router.
 * `useAuth` and `fetch` are the substituted boundaries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { AgentWorkflowView } from '../components/AgentWorkflowView.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import { currentPath, makeRoutedQueryWrapper } from './support/memory-router.js';
import type { AgentGraphResponse } from './support/api-responses.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

// The real view always mounts the @xyflow/react graph and an elkjs layout, neither of which
// runs under jsdom; its forwarding to the graph is covered in WorkflowTimeline.test.tsx.
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

import { WorkflowPage } from '../pages/WorkflowPage.js';
import { routes } from '../lib/routes.js';
import { makeNode, makeGraph, makeEvaluation } from './workflow-fixtures.js';
import type { WorkflowGraph } from '../types/workflow-graph.js';

/** The route's payload, plus the null graph a session key synced before graphs were precomputed carries. */
type GraphPayload = Omit<AgentGraphResponse, 'graph'> & { graph: AgentGraphResponse['graph'] | null };

const SESSION_ID = 'session-abc';
/** `useApiQuery` never retries a 401, so the error renders without retry backoff. */
const HTTP_UNAUTHORIZED = 401;
const WORKFLOW_VIEW = 'agent-workflow-view';
const NO_GRAPH_TITLE = 'No workflow graph for this session';

function graphResponse(graph: WorkflowGraph | null = makeGraph(), sessionId = SESSION_ID): GraphPayload {
  return { sessionId, evaluation: makeEvaluation(), graph };
}

/** Mount the page at its own route; returns the memory router for navigation assertions. */
function renderPage(sessionId = SESSION_ID) {
  const { wrapper, location } = makeRoutedQueryWrapper(routes.workflow(sessionId));
  render(<WorkflowPage sessionId={sessionId} />, { wrapper });
  return location;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkflowPage', () => {
  describe('when the session has a graph', () => {
    it('renders the workflow view', async () => {
      stubFetch(graphResponse());
      renderPage();
      expect(await screen.findByTestId(WORKFLOW_VIEW)).toBeInTheDocument();
    });

    it('titles the header "Workflow" and shows the session id', async () => {
      stubFetch(graphResponse());
      renderPage();
      expect(await screen.findByRole('heading', { name: 'Workflow' })).toBeInTheDocument();
      expect(screen.getByText(SESSION_ID)).toBeInTheDocument();
    });

    it('displays the workflow shape in the header', async () => {
      stubFetch(graphResponse(makeGraph({ workflowShape: 'branching' })));
      renderPage();
      expect(await screen.findByText(/branching/)).toBeInTheDocument();
    });

    it('displays agent count in the header', async () => {
      stubFetch(graphResponse(makeGraph({
        nodes: [makeNode({ id: 'n1' }), makeNode({ id: 'n2' }), makeNode({ id: 'n3' })],
      })));
      renderPage();
      expect(await screen.findByText(/3 agents/)).toBeInTheDocument();
    });

    it('uses the singular for a one-agent graph', async () => {
      stubFetch(graphResponse(makeGraph({ nodes: [makeNode({ id: 'n1' })] })));
      renderPage();
      expect(await screen.findByText(/1 agent$/)).toBeInTheDocument();
    });
  });

  describe('the request', () => {
    it('fetches the graph endpoint for the session with the bearer token', async () => {
      const fetchSpy = stubFetch(graphResponse(makeGraph(), 'my-session-id'));
      renderPage('my-session-id');
      await screen.findByTestId(WORKFLOW_VIEW);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('/api/agents/my-session-id/graph');
      expect(headersOf(init)['Authorization']).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
    });

    it('URL-encodes the session id in the request path', async () => {
      const fetchSpy = stubFetch(graphResponse(makeGraph(), 'session/with/slashes'));
      renderPage('session/with/slashes');
      await screen.findByTestId(WORKFLOW_VIEW);
      expect(fetchSpy.mock.calls[0]![0]).toBe('/api/agents/session%2Fwith%2Fslashes/graph');
    });
  });

  describe('when the session has no precomputed graph', () => {
    it('renders an empty state instead of the graph', async () => {
      stubFetch(graphResponse(null));
      renderPage();
      expect(await screen.findByText(NO_GRAPH_TITLE)).toBeInTheDocument();
      expect(screen.queryByTestId(WORKFLOW_VIEW)).not.toBeInTheDocument();
    });
  });

  describe('while the request is in flight', () => {
    it('shows the page skeleton and no workflow view', async () => {
      stubFetch(graphResponse());
      renderPage();
      expect(document.querySelector('.page-skeleton')).toBeInTheDocument();
      expect(screen.queryByTestId(WORKFLOW_VIEW)).not.toBeInTheDocument();
      await screen.findByTestId(WORKFLOW_VIEW);
    });
  });

  describe('when the request fails', () => {
    it('shows the API error instead of the graph', async () => {
      stubFetch({ error: 'unauthorized' }, { status: HTTP_UNAUTHORIZED });
      renderPage();
      expect(await screen.findByRole('heading', { name: 'Failed to load' })).toBeInTheDocument();
      expect(screen.getByText(new RegExp(`API error: ${HTTP_UNAUTHORIZED}`))).toBeInTheDocument();
      expect(screen.queryByTestId(WORKFLOW_VIEW)).not.toBeInTheDocument();
    });
  });

  describe('onNodeClick navigation', () => {
    it('navigates to /agents/{sessionId}?agent={nodeId} when a node is clicked', async () => {
      stubFetch(graphResponse(makeGraph({ nodes: [makeNode({ id: 'agent-node-42', label: 'executor' })] })));
      const location = renderPage();
      fireEvent.click(await screen.findByTestId('graph-node-agent-node-42'));
      expect(currentPath(location)).toBe('/agents/session-abc?agent=agent-node-42');
    });

    it('URL-encodes sessionId and nodeId in the navigation path', async () => {
      stubFetch(graphResponse(
        makeGraph({ nodes: [makeNode({ id: 'node with spaces', label: 'test' })] }),
        'session/with/slashes',
      ));
      const location = renderPage('session/with/slashes');
      fireEvent.click(await screen.findByTestId('graph-node-node with spaces'));
      expect(currentPath(location)).toBe('/agents/session%2Fwith%2Fslashes?agent=node%20with%20spaces');
    });
  });
});
