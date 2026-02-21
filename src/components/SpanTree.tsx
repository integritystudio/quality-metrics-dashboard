import type { CSSProperties } from 'react';

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
  const isError = statusCode === 2;

  const barStyle: CSSProperties = {
    height: 4,
    width: `${barPct}%`,
    background: isError ? 'var(--status-critical)' : 'var(--status-healthy)',
    borderRadius: 2,
    marginTop: 4,
    minWidth: barPct > 0 ? 2 : 0,
  };

  return (
    <>
      <div
        style={{
          paddingLeft: depth * 20 + 8,
          paddingTop: 8,
          paddingBottom: 8,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 14, color: isError ? 'var(--status-critical)' : 'var(--text-primary)' }}>
          {STATUS_ICONS[statusCode]}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{node.name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: 2, height: 4 }}>
              <div style={barStyle} />
            </div>
            {node.durationMs != null && (
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {node.durationMs < 1000 ? `${node.durationMs.toFixed(0)}ms` : `${(node.durationMs / 1000).toFixed(2)}s`}
              </span>
            )}
          </div>
        </div>
        {node.evalCount > 0 && (
          <span style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 10,
            background: 'var(--accent-bg)',
            color: 'var(--accent)',
            fontWeight: 600,
          }}>
            {node.evalCount} eval{node.evalCount > 1 ? 's' : ''}
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
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>No spans found for this trace.</div>;
  }

  return (
    <div>
      {roots.map(node => (
        <SpanRow key={node.spanId} node={node} depth={0} maxDuration={maxDuration} />
      ))}
    </div>
  );
}
