import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('@xyflow/react', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ReactFlow: ({ nodes, edges, onNodeClick, nodeTypes, edgeTypes, children, ...rest }: any) => (
      <div data-testid="reactflow" {...rest}>
        {(nodes ?? []).map((n: any) => {
          const NodeComp = nodeTypes?.[n.type];
          return (
            <div key={n.id} data-testid={`rf-node-${n.id}`} onClick={() => onNodeClick?.({}, n)}>
              {NodeComp ? <NodeComp data={n.data} /> : n.id}
            </div>
          );
        })}
        {(edges ?? []).map((e: any) => (
          <div key={e.id} data-testid={`rf-edge-${e.id}`} data-label={e.label} />
        ))}
        {children}
      </div>
    ),
    MiniMap: (props: any) => <div data-testid="minimap" />,
    Controls: () => <div data-testid="controls" />,
    Background: () => null,
    Handle: () => null,
    Position: { Top: 'top', Bottom: 'bottom' },
    BaseEdge: () => null,
    getStraightPath: () => ['M 0 0', 0, 0],
    useNodesState: (initial: any[]) => {
      const [nodes, setNodes] = React.useState(initial);
      return [nodes, setNodes, vi.fn()];
    },
    useEdgesState: (initial: any[]) => {
      const [edges, setEdges] = React.useState(initial);
      return [edges, setEdges, vi.fn()];
    },
    useReactFlow: () => ({ fitView: vi.fn() }),
  };
});

vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class ELK {
    layout(graph: any) {
      return Promise.resolve({
        ...graph,
        children: (graph.children ?? []).map((c: any, i: number) => ({
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
