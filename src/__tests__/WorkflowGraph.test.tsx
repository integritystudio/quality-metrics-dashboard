import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

interface MockNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

interface MockEdge {
  id: string;
  label?: string;
}

interface ReactFlowProps {
  nodes?: MockNode[];
  edges?: MockEdge[];
  onNodeClick?: (event: unknown, node: MockNode) => void;
  nodeTypes?: Record<string, (props: { data: Record<string, unknown> }) => ReactNode>;
  _edgeTypes?: unknown;
  children?: ReactNode;
  [key: string]: unknown;
}

vi.mock('@xyflow/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ReactFlow: ({ nodes, edges, onNodeClick, nodeTypes, _edgeTypes, children, ...rest }: ReactFlowProps) => (
      <div data-testid="reactflow" {...rest}>
        {(nodes ?? []).map((n) => {
          const NodeComp = nodeTypes?.[n.type];
          return (
            <div key={n.id} data-testid={`rf-node-${n.id}`} onClick={() => onNodeClick?.({}, n)}>
              {NodeComp ? <NodeComp data={n.data} /> : n.id}
            </div>
          );
        })}
        {(edges ?? []).map((e) => (
          <div key={e.id} data-testid={`rf-edge-${e.id}`} data-label={e.label} />
        ))}
        {children}
      </div>
    ),
    MiniMap: (_props: unknown) => <div data-testid="minimap" />,
    Controls: () => <div data-testid="controls" />,
    Background: () => null,
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    BaseEdge: () => null,
    getStraightPath: () => ['M 0 0', 0, 0],
    useNodesState: (initial: MockNode[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: MockEdge[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
    useReactFlow: () => ({ fitView: vi.fn() }),
  };
});

interface ELKGraph {
  children?: Array<{ x?: number; y?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class ELK {
    layout(graph: ELKGraph) {
      return Promise.resolve({
        ...graph,
        children: (graph.children ?? []).map((c, i: number) => ({
          ...c,
          x: i * 300,
          y: i * 200,
        })),
      });
    }
  },
}));

import { WorkflowGraphView } from '../components/WorkflowGraph.js';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from '../types/workflow-graph.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    label: 'test-agent',
    evaluationScore: null,
    toolCallCount: 0,
    totalTokens: null,
    durationMs: 1000,
    turnCount: 1,
    hasError: false,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<WorkflowEdge> = {}): WorkflowEdge {
  return {
    id: 'edge-1',
    source: 'node-1',
    target: 'node-2',
    handoffScore: 0.8,
    contextPreserved: true,
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

// ---------------------------------------------------------------------------
// WorkflowGraphView
// ---------------------------------------------------------------------------

describe('WorkflowGraphView', () => {
  const twoNodeGraph: WorkflowGraph = {
    nodes: [
      makeNode({ id: 'node-1', label: 'planner' }),
      makeNode({ id: 'node-2', label: 'executor' }),
    ],
    edges: [makeEdge({ id: 'edge-1', source: 'node-1', target: 'node-2' })],
    rootNodeId: 'node-1',
    workflowShape: 'linear',
  };

  const threeNodeGraph: WorkflowGraph = {
    nodes: [
      makeNode({ id: 'node-1' }),
      makeNode({ id: 'node-2' }),
      makeNode({ id: 'node-3' }),
    ],
    edges: [],
    rootNodeId: 'node-1',
    workflowShape: 'linear',
  };

  const fiveNodeGraph: WorkflowGraph = {
    nodes: Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `node-${i + 1}`, label: `agent-${i + 1}` })
    ),
    edges: [],
    rootNodeId: 'node-1',
    workflowShape: 'branching',
  };
  it('renders container with role=img and aria-label', async () => {
    render(<WorkflowGraphView graph={twoNodeGraph} />);
    const container = await waitFor(() =>
      screen.getByRole('img', { name: 'Agent workflow graph' })
    );
    expect(container).toBeInTheDocument();
  });

  it('renders correct number of nodes', async () => {
    render(<WorkflowGraphView graph={threeNodeGraph} />);
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-node-1')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-node-2')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-node-3')).toBeInTheDocument();
    });
  });

  it('node displays agent label', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ id: 'node-1', label: 'planner' })],
    });
    render(<WorkflowGraphView graph={graph} />);
    await waitFor(() => {
      expect(screen.getByText('planner')).toBeInTheDocument();
    });
  });

  it('node displays Good score badge text for score >= 0.7', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ id: 'node-1', evaluationScore: 0.85 })],
    });
    render(<WorkflowGraphView graph={graph} />);
    await waitFor(() => {
      expect(screen.getByText('Good')).toBeInTheDocument();
    });
  });

  it('node displays tool count', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ id: 'node-1', toolCallCount: 5 })],
    });
    render(<WorkflowGraphView graph={graph} />);
    await waitFor(() => {
      expect(screen.getByText('5 tools')).toBeInTheDocument();
    });
  });

  it('shows Controls always', async () => {
    render(<WorkflowGraphView graph={twoNodeGraph} />);
    await waitFor(() => {
      expect(screen.getByTestId('controls')).toBeInTheDocument();
    });
  });

  it('shows MiniMap for 5+ nodes', async () => {
    render(<WorkflowGraphView graph={fiveNodeGraph} />);
    await waitFor(() => {
      expect(screen.getByTestId('minimap')).toBeInTheDocument();
    });
  });

  it('hides MiniMap for fewer than 5 nodes', async () => {
    render(<WorkflowGraphView graph={threeNodeGraph} />);
    await waitFor(() => {
      expect(screen.getByTestId('reactflow')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('minimap')).not.toBeInTheDocument();
  });

  it('shows simplified fallback for single_agent shape with 1 node and no ReactFlow', async () => {
    const graph = makeGraph({
      nodes: [makeNode({ id: 'node-1', label: 'solo-agent' })],
      workflowShape: 'single_agent',
      rootNodeId: 'node-1',
    });
    render(<WorkflowGraphView graph={graph} />);
    await waitFor(() => {
      expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
      expect(screen.getByText(/solo-agent/)).toBeInTheDocument();
    });
  });

  it('fires onNodeClick with the correct nodeId when a node is clicked', async () => {
    const onNodeClick = vi.fn();
    render(<WorkflowGraphView graph={twoNodeGraph} onNodeClick={onNodeClick} />);
    await waitFor(() => {
      expect(screen.getByTestId('rf-node-node-1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('rf-node-node-1'));
    expect(onNodeClick).toHaveBeenCalledWith('node-1');
  });

  it('renders without error when graph has 0 nodes and 0 edges', async () => {
    const graph: WorkflowGraph = {
      nodes: [],
      edges: [],
      rootNodeId: null,
      workflowShape: 'linear',
    };
    expect(() => render(<WorkflowGraphView graph={graph} />)).not.toThrow();
  });
});

// ============================================================================
// ST-G5 Stress Tests — graph layout stability at scale
// ============================================================================

const ST_G5_LARGE_GRAPH_SIZE = 100;
const ST_G5_DEEP_CHAIN_SIZE = 20;

describe('WorkflowGraphView stress (ST-G5)', () => {
  it('renders 100+ node graph without error and shows all nodes', async () => {
    const nodes: WorkflowNode[] = Array.from({ length: ST_G5_LARGE_GRAPH_SIZE }, (_, i) =>
      makeNode({ id: `node-${i}`, label: `agent-${i}` })
    );
    // Chain edges: 0→1→2→...→99
    const edges: WorkflowEdge[] = nodes.slice(0, -1).map((n, i) =>
      makeEdge({ id: `edge-${i}`, source: n.id, target: `node-${i + 1}` })
    );
    const graph: WorkflowGraph = {
      nodes,
      edges,
      rootNodeId: 'node-0',
      workflowShape: 'branching',
    };

    render(<WorkflowGraphView graph={graph} />);

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-node-0')).toBeInTheDocument();
      expect(screen.getByTestId(`rf-node-node-${ST_G5_LARGE_GRAPH_SIZE - 1}`)).toBeInTheDocument();
    });
    // All 100 nodes rendered
    expect(screen.getAllByTestId(/^rf-node-/).length).toBe(ST_G5_LARGE_GRAPH_SIZE);
  });

  it('renders deeply nested delegation chain without error', async () => {
    const nodes: WorkflowNode[] = Array.from({ length: ST_G5_DEEP_CHAIN_SIZE }, (_, i) =>
      makeNode({ id: `node-${i}`, label: `delegate-${i}` })
    );
    const edges: WorkflowEdge[] = nodes.slice(0, -1).map((n, i) =>
      makeEdge({ id: `edge-${i}`, source: n.id, target: `node-${i + 1}` })
    );
    const graph: WorkflowGraph = {
      nodes,
      edges,
      rootNodeId: 'node-0',
      workflowShape: 'linear',
    };

    render(<WorkflowGraphView graph={graph} />);

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-node-0')).toBeInTheDocument();
      expect(screen.getByTestId(`rf-node-node-${ST_G5_DEEP_CHAIN_SIZE - 1}`)).toBeInTheDocument();
    });
  });

  it('renders without crash when rootNodeId is null (missing parent span inference fallback)', async () => {
    const nodes: WorkflowNode[] = Array.from({ length: 5 }, (_, i) =>
      makeNode({ id: `node-${i}`, label: `orphan-${i}` })
    );
    const graph: WorkflowGraph = {
      nodes,
      edges: [],
      rootNodeId: null,
      workflowShape: 'branching',
    };

    expect(() => render(<WorkflowGraphView graph={graph} />)).not.toThrow();
    await waitFor(() => {
      expect(screen.getByTestId('reactflow')).toBeInTheDocument();
    });
  });

  it('renders disconnected nodes (no edges) without crash', async () => {
    const nodes: WorkflowNode[] = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `orphan-${i}`, label: `isolated-${i}` })
    );
    const graph: WorkflowGraph = {
      nodes,
      edges: [],
      rootNodeId: 'orphan-0',
      workflowShape: 'branching',
    };

    render(<WorkflowGraphView graph={graph} />);

    await waitFor(() => {
      expect(screen.getAllByTestId(/^rf-node-/).length).toBe(10);
    });
  });

  it('handles concurrent renders of different graphs without state leakage', async () => {
    const graphA: WorkflowGraph = {
      nodes: [makeNode({ id: 'a-1', label: 'alpha' }), makeNode({ id: 'a-2', label: 'beta' })],
      edges: [makeEdge({ id: 'ea-1', source: 'a-1', target: 'a-2' })],
      rootNodeId: 'a-1',
      workflowShape: 'linear',
    };
    const graphB: WorkflowGraph = {
      nodes: [makeNode({ id: 'b-1', label: 'gamma' }), makeNode({ id: 'b-2', label: 'delta' })],
      edges: [makeEdge({ id: 'eb-1', source: 'b-1', target: 'b-2' })],
      rootNodeId: 'b-1',
      workflowShape: 'linear',
    };

    const { unmount: unmountA } = render(<WorkflowGraphView graph={graphA} />);
    const { unmount: unmountB } = render(<WorkflowGraphView graph={graphB} />);

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-a-1')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-b-1')).toBeInTheDocument();
    });

    // Unmounting one should not affect the other
    unmountA();
    expect(screen.queryByTestId('rf-node-a-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('rf-node-b-1')).toBeInTheDocument();
    unmountB();
  });
});
