import { group } from 'd3-array';
import type { WorkflowGraph } from '../types/workflow-graph.js';

/**
 * The root-to-leaf chain with the largest summed `durationMs`, root first; empty when the
 * graph has no root. A node whose search never re-entered a node on the stack has the same
 * best chain from every caller, so it is computed once: an acyclic graph costs O(V + E)
 * however many paths it holds. A node that did re-enter one sits on a cycle and is searched
 * again per caller, which keeps the chain the longest one that repeats no node.
 */
export function criticalPath(graph: WorkflowGraph): string[] {
  const root = graph.rootNodeId;
  if (root === null) return [];

  const outEdges = group(graph.edges, e => e.source);
  const durationOf = new Map(graph.nodes.map(n => [n.id, n.durationMs]));
  const settled = new Map<string, { cost: number; path: string[] }>();
  const onStack = new Set<string>();

  function search(nodeId: string): { cost: number; path: string[]; reenteredStack: boolean } {
    const known = settled.get(nodeId);
    if (known) return { ...known, reenteredStack: false };
    if (onStack.has(nodeId)) return { cost: 0, path: [], reenteredStack: true };
    onStack.add(nodeId);
    let bestTail: string[] = [];
    let bestTailCost = 0;
    let reenteredStack = false;
    for (const { target } of outEdges.get(nodeId) ?? []) {
      const tail = search(target);
      reenteredStack ||= tail.reenteredStack;
      if (tail.cost > bestTailCost) {
        bestTailCost = tail.cost;
        bestTail = tail.path;
      }
    }
    onStack.delete(nodeId);
    const result = { cost: (durationOf.get(nodeId) ?? 0) + bestTailCost, path: [nodeId, ...bestTail] };
    if (!reenteredStack) settled.set(nodeId, result);
    return { ...result, reenteredStack };
  }

  return search(root).path;
}
