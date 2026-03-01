import { memo, useState, useMemo } from 'react';
import type { CoverageCell, CoverageGap, CoverageStatus } from '../types.js';
import { truncateId } from '../lib/quality-utils.js';

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
      <div className="flex-center mb-3 gap-3">
        <span className="mono-xl font-semibold">
          {overallCoveragePercent.toFixed(1)}%
        </span>
        <span className="text-secondary text-base">
          coverage ({metrics.length} metrics x {inputs.length} inputs)
        </span>
      </div>

      {/* Legend */}
      <div className="mb-3 text-xs gap-4" style={{ display: 'flex' }}>
        {(['covered', 'partial', 'missing'] as const).map(status => (
          <div key={status} className="flex-center gap-1">
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
          className="gap-half"
          style={{
            display: 'grid',
            gridTemplateColumns: `120px repeat(${displayInputs.length}, 28px)`,
          }}
        >
          {/* Header row */}
          <div role="row" style={{ display: 'contents' }}>
            <div role="columnheader" className="text-xs font-semibold" />
            {displayInputs.map(input => (
              <div
                key={input}
                role="columnheader"
                title={input}
                className="text-secondary"
                style={{
                  fontSize: 'var(--font-size-2xs)',
                  writingMode: 'vertical-lr',
                  textAlign: 'end',
                  overflow: 'hidden',
                  maxHeight: 60,
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
                    className="mono"
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
                      fontSize: 'var(--font-size-2xs)',
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
        <p className="text-secondary text-xs" style={{ marginTop: 8 }}>
          Showing {maxInputs} of {inputs.length} inputs.
        </p>
      )}

      {/* Gap summary */}
      {gaps.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h4 className="mb-1-5 text-base">Coverage Gaps</h4>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
            {gaps.map(gap => (
              <li key={gap.metric} className="mb-1">
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
