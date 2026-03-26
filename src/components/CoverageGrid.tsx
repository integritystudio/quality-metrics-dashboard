import { memo, useState, useMemo } from 'react';
import type { CoverageCell, CoverageGap, CoverageStatus } from '../types.js';
import { truncateId, plural, formatPercent } from '../lib/quality-utils.js';
import {
  COVERAGE_GRID_HEADER_WIDTH, COVERAGE_GRID_CELL_SIZE, COVERAGE_GRID_LEGEND_SIZE,
  COVERAGE_GRID_MAX_INPUTS, COVERAGE_GRID_HEADER_MAX_HEIGHT,
} from '../lib/constants.js';
import { EmptyState } from './EmptyState.js';

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

const COVERAGE_STATUSES = Object.keys(STATUS_COLORS) as CoverageStatus[];

function CoverageGridInner({ metrics, inputs, cells, gaps, overallCoveragePercent }: CoverageGridProps) {
  const [hovered, setHovered] = useState<{ metric: string; input: string } | null>(null);

  const cellMap = useMemo(() => {
    const map = new Map<string, CoverageCell>();
    if (!Array.isArray(cells)) return map;
    for (const cell of cells) {
      map.set(`${cell.metric}|${cell.input}`, cell);
    }
    return map;
  }, [cells]);

  if (metrics.length === 0 || inputs.length === 0) {
    return <EmptyState message="No coverage data available." />;
  }

  // Limit displayed inputs to avoid huge grids
  const maxInputs = COVERAGE_GRID_MAX_INPUTS;
  const displayInputs = inputs.slice(0, maxInputs);
  const truncated = inputs.length > maxInputs;

  return (
    <div role="region" aria-label="Evaluation coverage heatmap">
      {/* Summary bar */}
      <div className="flex-center mb-3 gap-3">
        <span className="mono-xl font-semibold">
          {formatPercent(overallCoveragePercent)}
        </span>
        <span className="text-secondary text-base">
          coverage ({metrics.length} metrics x {inputs.length} inputs)
        </span>
      </div>

      {/* Legend */}
      <div className="mb-3 text-xs flex-wrap gap-4">
        {COVERAGE_STATUSES.map(status => (
          <div key={status} className="flex-center gap-1">
            <div style={{
              width: COVERAGE_GRID_LEGEND_SIZE, height: COVERAGE_GRID_LEGEND_SIZE, borderRadius: 'var(--radius-xs)',
              background: STATUS_COLORS[status],
            }} />
            <span>{status}</span>
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        <div
          role="table"
          aria-label="Coverage matrix"
          className="gap-half"
          style={{
            display: 'grid',
            gridTemplateColumns: `${COVERAGE_GRID_HEADER_WIDTH}px repeat(${displayInputs.length}, ${COVERAGE_GRID_CELL_SIZE}px)`,
          }}
        >
          {/* Header row */}
          <div role="row" className="contents">
            <div role="columnheader" className="text-xs font-semibold" />
            {displayInputs.map(input => (
              <div
                key={input}
                role="columnheader"
                title={input}
                className="text-secondary text-2xs"
                style={{
                  writingMode: 'vertical-lr',
                  textAlign: 'end',
                  overflow: 'hidden',
                  maxHeight: COVERAGE_GRID_HEADER_MAX_HEIGHT,
                }}
              >
                {truncateId(input, 8)}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {metrics.map(metric => (
            <div key={metric} role="row" className="contents">
              <div
                role="rowheader"
                className="text-xs flex-center truncate font-medium"
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
                    title={`${metric} / ${truncateId(input)}: ${plural(count, 'evaluation')}`}
                    onMouseEnter={() => setHovered({ metric, input })}
                    onMouseLeave={() => setHovered(null)}
                    className="mono text-2xs flex-center justify-center"
                    style={{
                      width: COVERAGE_GRID_CELL_SIZE,
                      height: COVERAGE_GRID_CELL_SIZE,
                      borderRadius: 'var(--radius-bar)',
                      background: STATUS_COLORS[status],
                      opacity: isHovered ? 1 : 0.8,
                      cursor: 'default',
                      color: 'var(--text-on-accent)',
                      transition: 'opacity var(--transition-fast)',
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
        <p className="text-secondary text-xs mt-2">
          Showing {maxInputs} of {inputs.length} inputs.
        </p>
      )}

      {/* Gap summary */}
      {gaps.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1-5 text-base">Coverage Gaps</h4>
          <ul className="m-0 text-xs" style={{ paddingLeft: 'var(--space-5)' }}>
            {gaps.map(gap => (
              <li key={gap.metric} className="mb-1">
                <strong>{gap.metric}</strong>: {formatPercent(gap.coveragePercent, 0)} covered
                ({plural(gap.missingInputs.length, 'input')} missing)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const CoverageGrid = memo(CoverageGridInner);
