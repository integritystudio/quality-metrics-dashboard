import { useMemo, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { scaleSequential } from 'd3-scale';
import { interpolateRdYlGn } from 'd3-scale-chromatic';
import { formatScore } from '../lib/quality-utils.js';
import { HEATMAP_ROW_HEADER_WIDTH, HEATMAP_COL_HEADER_HEIGHT, SCORE_CHIP_PRECISION, SCORE_DISPLAY_PRECISION } from '../lib/constants.js';
import type { CorrelationFeature } from '../types.js';

type CorrelationHeatmapProps = {
  correlations: CorrelationFeature[];
  metrics: string[];
  onCellClick?: (rowMetric: string, colMetric: string) => void;
}

/** Fallback abbreviation length for a metric missing from SHORT_NAMES. */
const SHORT_NAME_MAX_CHARS = 6;

const SHORT_NAMES: Record<string, string> = {
  faithfulness: 'Faith',
  relevance: 'Relev',
  coherence: 'Coher',
  safety: 'Safety',
  instruction_adherence: 'Instr',
  tool_accuracy: 'Tool',
  latency: 'Latency',
};

function shortName(metric: string): string {
  return SHORT_NAMES[metric] ?? metric.slice(0, SHORT_NAME_MAX_CHARS);
}

const colorScale = scaleSequential(interpolateRdYlGn).domain([-1, 1]);

function corrKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A metric's correlation with itself, which is 1 by construction and carries no data. */
const DIAGONAL_VALUE = 1;

const CELL_CLASS = 'mono-xs font-medium flex-center justify-center heatmap-cell';

function cellTooltip(rowMetric: string, colMetric: string, corr: CorrelationFeature | undefined): string {
  if (!corr) return `${rowMetric} vs ${colMetric}: no data`;
  return `${corr.metricA} vs ${corr.metricB}\npearsonR: ${corr.pearsonR.toFixed(SCORE_DISPLAY_PRECISION)}\nlagHours: ${corr.lagHours}\npValue: ${formatScore(corr.pValue)}\nsignificant: ${corr.significant}`;
}

/** The self-correlation cell: never clickable, never toxic, always 1. */
function HeatmapDiagonalCell({ metric }: { metric: string }): ReactNode {
  const label = DIAGONAL_VALUE.toFixed(SCORE_CHIP_PRECISION);
  return (
    <div
      role="gridcell"
      aria-label={`${metric} vs ${metric}: ${label}`}
      title={`${metric}: diagonal (${label})`}
      data-diagonal="true"
      className={CELL_CLASS}
      style={{ '--heatmap-cell-bg': 'var(--bg-surface)' } as CSSProperties}
    >
      {label}
    </div>
  );
}

function HeatmapCell({ rowMetric, colMetric, corr, onCellClick }: {
  rowMetric: string;
  colMetric: string;
  corr: CorrelationFeature | undefined;
  onCellClick: ((rowMetric: string, colMetric: string) => void) | undefined;
}): ReactNode {
  const value = corr?.pearsonR ?? 0;
  const isToxic = corr?.isKnownToxicCombo ?? false;
  const clickable = onCellClick !== undefined;
  const activate = (): void => {
    onCellClick?.(rowMetric, colMetric);
  };
  const activateOnKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  };
  return (
    <div
      role="gridcell"
      aria-label={`${rowMetric} vs ${colMetric}: ${value.toFixed(SCORE_CHIP_PRECISION)}`}
      data-toxic={isToxic ? 'true' : undefined}
      title={cellTooltip(rowMetric, colMetric, corr)}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable ? activateOnKey : undefined}
      className={`${CELL_CLASS}${clickable ? ' cursor-pointer' : ''}`}
      style={{ '--heatmap-cell-bg': colorScale(value) } as CSSProperties}
    >
      {value.toFixed(SCORE_CHIP_PRECISION)}
    </div>
  );
}

export function CorrelationHeatmap({ correlations, metrics, onCellClick }: CorrelationHeatmapProps) {
  const n = metrics.length;
  const cols = n + 1;

  const corrMap = useMemo(
    () => {
      const m = new Map<string, CorrelationFeature>();
      for (const c of correlations) m.set(corrKey(c.metricA, c.metricB), c);
      return m;
    },
    [correlations],
  );

  return (
    <div
      role="grid"
      aria-label="Metric correlation matrix"
      className="gap-half w-full heatmap-grid"
      style={{
        '--heatmap-aspect': `${cols} / ${cols}`,
        '--heatmap-grid-cols': `${HEATMAP_ROW_HEADER_WIDTH}px repeat(${n}, 1fr)`,
        '--heatmap-grid-rows': `${HEATMAP_COL_HEADER_HEIGHT}px repeat(${n}, 1fr)`,
      } as CSSProperties}
    >
      <div role="row" className="contents">
        <div role="gridcell" />
        {metrics.map((m) => (
          <div
            key={`col-${m}`}
            role="columnheader"
            className="text-secondary text-xs font-semibold truncate flex-center"
          >
            {shortName(m)}
          </div>
        ))}
      </div>

      {metrics.map((rowMetric, ri) => (
        <div key={`row-${rowMetric}`} role="row" className="contents">
          <div
            role="rowheader"
            className="text-secondary text-xs font-semibold truncate flex-center heatmap-row-header"
          >
            {shortName(rowMetric)}
          </div>

          {metrics.map((colMetric, ci) => (
            ri === ci
              ? <HeatmapDiagonalCell key={`${rowMetric}-${colMetric}`} metric={rowMetric} />
              : (
                <HeatmapCell
                  key={`${rowMetric}-${colMetric}`}
                  rowMetric={rowMetric}
                  colMetric={colMetric}
                  corr={corrMap.get(corrKey(rowMetric, colMetric))}
                  onCellClick={onCellClick}
                />
              )
          ))}
        </div>
      ))}

    </div>
  );
}
