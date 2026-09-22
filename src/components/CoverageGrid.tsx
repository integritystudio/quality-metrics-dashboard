import { memo, useState, useMemo, type CSSProperties } from 'react';
import type { CoverageMatrix, CoverageStatus } from '../types.js';
import { truncateId, plural, formatPercent } from '../lib/quality-utils.js';
import { coverageStatusForCount, countAt, summarizeCoverageGaps } from '../lib/coverage-matrix.js';
import {
  COVERAGE_GRID_HEADER_WIDTH, COVERAGE_GRID_CELL_SIZE,
  COVERAGE_GRID_MAX_INPUTS,
} from '../lib/constants.js';
import { EmptyState } from './EmptyState.js';

/**
 * Renders the columnar coverage matrix (CVG-1). Status and per-metric gaps are
 * derived from `counts` rather than shipped: the dense cell list they replace
 * did not fit KV's value limit at production cardinality.
 */
interface CoverageGridProps {
  matrix: CoverageMatrix;
}

const STATUS_COLORS: Record<CoverageStatus, string> = {
  covered: 'var(--score-good, #0072B2)',
  partial: 'var(--score-fair, #E69F00)',
  missing: 'var(--score-poor, #D55E00)',
};

const COVERAGE_STATUSES = Object.keys(STATUS_COLORS) as CoverageStatus[];

function CoverageGridInner({ matrix }: CoverageGridProps) {
  const { metrics, inputs, coveredThreshold, partialThreshold, overallCoveragePercent } = matrix;
  const [hovered, setHovered] = useState<{ metric: string; input: string } | null>(null);

  const gaps = useMemo(() => summarizeCoverageGaps(matrix), [matrix]);

  if (metrics.length === 0 || inputs.length === 0) {
    return <EmptyState message="No coverage data available." />;
  }

  // A prefix slice, so an index into displayInputs is also an index into the
  // matrix columns — no lookup table needed.
  const displayInputs = inputs.slice(0, COVERAGE_GRID_MAX_INPUTS);
  const truncated = inputs.length > COVERAGE_GRID_MAX_INPUTS;

  return (
    <div role="region" aria-label="Evaluation coverage heatmap">
      <div className="flex-center mb-3 gap-3">
        <span className="mono-xl font-semibold">
          {formatPercent(overallCoveragePercent)}
        </span>
        <span className="text-secondary text-base">
          coverage ({metrics.length} metrics x {inputs.length} inputs)
        </span>
      </div>

      <div className="mb-3 text-xs flex-wrap gap-4">
        {COVERAGE_STATUSES.map(status => (
          <div key={status} className="flex-center gap-1">
            <div
              className="coverage-legend-swatch"
              style={{ '--coverage-status-color': STATUS_COLORS[status] } as CSSProperties}
            />
            <span>{status}</span>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto">
        <div
          role="table"
          aria-label="Coverage matrix"
          className="coverage-grid gap-half"
          style={{
            '--coverage-grid-cols': `${COVERAGE_GRID_HEADER_WIDTH}px repeat(${displayInputs.length}, ${COVERAGE_GRID_CELL_SIZE}px)`,
          } as CSSProperties}
        >
          <div role="row" className="contents">
            <div role="columnheader" className="text-xs font-semibold" />
            {displayInputs.map(input => (
              <div
                key={input}
                role="columnheader"
                title={input}
                className="text-secondary text-2xs coverage-header-cell"
              >
                {truncateId(input, 8)}
              </div>
            ))}
          </div>

          {metrics.map((metric, metricIndex) => (
            <div key={metric} role="row" className="contents">
              <div
                role="rowheader"
                className="text-xs flex-center truncate font-medium"
                title={metric}
              >
                {metric}
              </div>
              {displayInputs.map((input, inputIndex) => {
                const count = countAt(matrix, metricIndex, inputIndex);
                const status = coverageStatusForCount(count, coveredThreshold, partialThreshold);
                const isHovered = hovered?.metric === metric && hovered.input === input;

                return (
                  <div
                    key={input}
                    role="cell"
                    aria-label={`${metric} / ${truncateId(input)}: ${status} (${count})`}
                    title={`${metric} / ${truncateId(input)}: ${plural(count, 'evaluation')}`}
                    onMouseEnter={() => setHovered({ metric, input })}
                    onMouseLeave={() => setHovered(null)}
                    className="mono text-2xs flex-center justify-center coverage-cell"
                    data-hovered={isHovered || undefined}
                    style={{ '--coverage-status-color': STATUS_COLORS[status] } as CSSProperties}
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
          Showing {COVERAGE_GRID_MAX_INPUTS} of {inputs.length} inputs.
        </p>
      )}

      {gaps.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1-5 text-base">Coverage Gaps</h4>
          <ul className="m-0 text-xs coverage-gap-list">
            {gaps.map(gap => (
              <li key={gap.metric} className="mb-1">
                <strong>{gap.metric}</strong>: {formatPercent(gap.coveragePercent, 0)} covered
                ({plural(gap.missingCount, 'input')} missing)
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export const CoverageGrid = memo(CoverageGridInner);
