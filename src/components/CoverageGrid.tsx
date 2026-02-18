import { memo, useState, useMemo } from 'react';
import type { CoverageCell, CoverageGap, CoverageStatus } from '../types.js';

interface CoverageGridProps {
  metrics: string[];
  inputs: string[];
  cells: CoverageCell[];
  gaps: CoverageGap[];
  overallCoveragePercent: number;
}

const STATUS_COLORS: Record<CoverageStatus, string> = {
  covered: 'var(--score-good, #0072B2)',
  partial: 'var(--score-fair, #E69F00)',
  missing: 'var(--score-poor, #D55E00)',
};

/** Truncate long IDs for display */
function truncateId(id: string, max = 10): string {
  if (id.length <= max) return id;
  return id.slice(0, 4) + '\u2026' + id.slice(-4);
}

function CoverageGridInner({ metrics, inputs, cells, gaps, overallCoveragePercent }: CoverageGridProps) {
  const [hovered, setHovered] = useState<{ metric: string; input: string } | null>(null);

  const cellMap = useMemo(() => {
    const map = new Map<string, CoverageCell>();
    for (const cell of cells) {
      map.set(`${cell.metric}|${cell.input}`, cell);
    }
    return map;
  }, [cells]);

  if (metrics.length === 0 || inputs.length === 0) {
    return <p>No coverage data available.</p>;
  }

  // Limit displayed inputs to avoid huge grids
  const maxInputs = 30;
  const displayInputs = inputs.slice(0, maxInputs);
  const truncated = inputs.length > maxInputs;

  return (
    <div role="region" aria-label="Evaluation coverage heatmap">
      {/* Summary bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 600 }}>
          {overallCoveragePercent.toFixed(1)}%
        </span>
        <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
          coverage ({metrics.length} metrics x {inputs.length} inputs)
        </span>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, fontSize: 12 }}>
        {(['covered', 'partial', 'missing'] as const).map(status => (
          <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 12, height: 12, borderRadius: 2,
              background: STATUS_COLORS[status],
            }} />
            <span>{status}</span>
          </div>
        ))}
      </div>

      {/* Grid */}
      <div style={{ overflowX: 'auto' }}>
        <div
          role="table"
          aria-label="Coverage matrix"
          style={{
            display: 'grid',
            gridTemplateColumns: `120px repeat(${displayInputs.length}, 28px)`,
            gap: 1,
          }}
        >
          {/* Header row */}
          <div role="row" style={{ display: 'contents' }}>
            <div role="columnheader" style={{ fontSize: 11, fontWeight: 600 }} />
            {displayInputs.map(input => (
              <div
                key={input}
                role="columnheader"
                title={input}
                style={{
                  fontSize: 9,
                  writingMode: 'vertical-lr',
                  textAlign: 'end',
                  overflow: 'hidden',
                  maxHeight: 60,
                  color: 'var(--text-secondary)',
                }}
              >
                {truncateId(input, 8)}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {metrics.map(metric => (
            <div key={metric} role="row" style={{ display: 'contents' }}>
              <div
                role="rowheader"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={metric}
              >
                {metric}
              </div>
              {displayInputs.map(input => {
                const cell = cellMap.get(`${metric}|${input}`);
                const status = cell?.status ?? 'missing';
                const count = cell?.count ?? 0;
                const isHovered = hovered?.metric === metric && hovered?.input === input;

                return (
                  <div
                    key={input}
                    role="cell"
                    aria-label={`${metric} / ${truncateId(input)}: ${status} (${count})`}
                    title={`${metric} / ${truncateId(input)}: ${count} evaluation${count !== 1 ? 's' : ''}`}
                    onMouseEnter={() => setHovered({ metric, input })}
                    onMouseLeave={() => setHovered(null)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 3,
                      background: STATUS_COLORS[status],
                      opacity: isHovered ? 1 : 0.8,
                      cursor: 'default',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 9,
                      fontFamily: 'var(--font-mono)',
                      color: '#fff',
                      transition: 'opacity 0.15s',
                    }}
                  >
                    {count > 0 ? count : ''}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {truncated && (
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          Showing {maxInputs} of {inputs.length} inputs.
        </p>
      )}

      {/* Gap summary */}
      {gaps.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 style={{ fontSize: 14, marginBottom: 8 }}>Coverage Gaps</h4>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            {gaps.map(gap => (
              <li key={gap.metric} style={{ marginBottom: 4 }}>
                <strong>{gap.metric}</strong>: {gap.coveragePercent.toFixed(0)}% covered
                ({gap.missingInputs.length} input{gap.missingInputs.length !== 1 ? 's' : ''} missing)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const CoverageGrid = memo(CoverageGridInner);
