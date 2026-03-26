import type { CSSProperties } from 'react';
import { plural } from '../lib/quality-utils.js';
import { OTEL_STATUS_ERROR_CODE, SPAN_TREE_INDENT, SPAN_TREE_BASE_PADDING } from '../lib/constants.js';
import { EmptyState } from './EmptyState.js';

interface SpanNode {
  spanId: string;
  name: string;
  durationMs?: number;
  status?: { code: number; message?: string };
  attributes?: Record<string, unknown>;
  children: SpanNode[];
  evalCount: number;
}

interface SpanTreeProps {
  spans: Array<{
    spanId: string;
    name: string;
    durationMs?: number;
    status?: { code: number; message?: string };
    attributes?: Record<string, unknown>;
    parentSpanId?: string;
  }>;
  evalsBySpan: Map<string, number>;
  maxDuration: number;
}

function buildTree(
  spans: SpanTreeProps['spans'],
  evalsBySpan: Map<string, number>,
): SpanNode[] {
  const nodeMap = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  for (const s of spans) {
    nodeMap.set(s.spanId, {
      spanId: s.spanId,
      name: s.name,
      durationMs: s.durationMs,
      status: s.status,
      attributes: s.attributes,
      children: [],
      evalCount: evalsBySpan.get(s.spanId) ?? 0,
    });
  }

  for (const s of spans) {
    const node = nodeMap.get(s.spanId)!;
    const parentId = (s as { parentSpanId?: string }).parentSpanId;
    if (parentId && nodeMap.has(parentId)) {
      nodeMap.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

const STATUS_ICONS: Record<number, string> = {
  0: '',      // UNSET
  1: '\u2713', // OK ✓
  2: '\u2717', // ERROR ✗
};

function SpanRow({ node, depth, maxDuration }: { node: SpanNode; depth: number; maxDuration: number }) {
  const barPct = maxDuration > 0 && node.durationMs ? Math.min((node.durationMs / maxDuration) * 100, 100) : 0;
  const statusCode = node.status?.code ?? 0;
  const isError = statusCode === OTEL_STATUS_ERROR_CODE;

  const barStyle: CSSProperties = {
    height: 'var(--space-1)',
    width: `${barPct}%`,
    background: isError ? 'var(--status-critical)' : 'var(--status-healthy)',
    borderRadius: 'var(--radius-xs)',
    marginTop: 'var(--space-1)',
    minWidth: barPct > 0 ? 'var(--space-0-5)' : 0,
  };

  return (
    <>
      <div
        className="flex-center gap-2 border-b span-row"
        style={{ paddingLeft: depth * SPAN_TREE_INDENT + SPAN_TREE_BASE_PADDING }}
      >
        <span className="text-base span-status-icon" data-error={isError || undefined}>
          {STATUS_ICONS[statusCode]}
        </span>
        <div className="flex-1">
          <div className="text-xs font-medium">{node.name}</div>
          <div className="flex-center gap-2">
            <div className="flex-1 bar-track">
              <div style={barStyle} />
            </div>
            {node.durationMs != null && (
              <span className="mono-xs text-secondary nowrap">
                {node.durationMs < 1000 ? `${node.durationMs.toFixed(0)}ms` : `${(node.durationMs / 1000).toFixed(2)}s`}
              </span>
            )}
          </div>
        </div>
        {node.evalCount > 0 && (
          <span className="text-2xs chip font-semibold chip-accent">
            {plural(node.evalCount, 'eval')}
          </span>
        )}
      </div>
      {node.children.map(child => (
        <SpanRow key={child.spanId} node={child} depth={depth + 1} maxDuration={maxDuration} />
      ))}
    </>
  );
}

export function SpanTree({ spans, evalsBySpan, maxDuration }: SpanTreeProps) {
  const roots = buildTree(spans, evalsBySpan);

  if (roots.length === 0) {
    return <EmptyState message="No spans found for this trace." />;
  }

  return (
    <div>
      {roots.map(node => (
        <SpanRow key={node.spanId} node={node} depth={0} maxDuration={maxDuration} />
      ))}
    </div>
  );
}
