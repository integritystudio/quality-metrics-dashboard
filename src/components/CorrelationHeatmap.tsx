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

// WCAG 2.1 contrast ratio formula anchors — these specific values are required by the algorithm.
const CONTRAST_DARK = '#111';
const CONTRAST_LIGHT = '#fff';

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
  return SHORT_NAMES[metric] ?? metric.slice(0, 6);
}

/**
 * Returns black or white text for WCAG 4.5:1 contrast against the
 * interpolateRdYlGn background color for a given pearsonR value.
 * Uses relative luminance per WCAG 2.1 contrast ratio formula.
 */
function contrastText(pearsonR: number): string {
  const bg = colorScale(pearsonR);
  const m = bg.match(/\d+/g);
  if (!m || m.length < 3) return CONTRAST_DARK;
  const [r = 0, g = 0, b = 0] = m.map(Number);
  // sRGB relative luminance (WCAG 2.1)
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  // WCAG contrast ratio: (L1 + 0.05) / (L2 + 0.05)
  // White text (#fff, L=1.0) needs ratio >= 4.5 → L_bg <= ~0.18
  // Black text (#111, L≈0.012) needs ratio >= 4.5 → L_bg >= ~0.10
  return L > 0.18 ? CONTRAST_DARK : CONTRAST_LIGHT;
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
      className={CELL_CLASS}
      style={{
        '--heatmap-cell-bg': 'var(--bg-surface)',
        '--heatmap-cell-fg': 'var(--text-secondary)',
      } as CSSProperties}
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
      style={{
        '--heatmap-cell-bg': colorScale(value),
        '--heatmap-cell-fg': contrastText(value),
      } as CSSProperties}
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
