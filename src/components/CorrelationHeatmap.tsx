import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { scaleSequential } from 'd3-scale';
import { interpolateRdYlGn } from 'd3-scale-chromatic';
import { formatScore } from '../lib/quality-utils.js';
import { HEATMAP_ROW_HEADER_WIDTH, HEATMAP_COL_HEADER_HEIGHT, SCORE_CHIP_PRECISION, SCORE_DISPLAY_PRECISION } from '../lib/constants.js';
import type { CorrelationFeature } from '../types.js';

interface CorrelationHeatmapProps {
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
  const m = bg.match(/(\d+)/g);
  if (!m || m.length < 3) return CONTRAST_DARK;
  const [r, g, b] = m.map(Number);
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

export function CorrelationHeatmap({ correlations, metrics, onCellClick }: CorrelationHeatmapProps) {
  const n = metrics.length;
  const cols = n + 1;

  const corrMap = useMemo(
    () => new Map(correlations.map(c => [corrKey(c.metricA, c.metricB), c])),
    [correlations],
  );

  return (
    <div
      role="table"
      aria-label="Metric correlation matrix"
      className="gap-half w-full heatmap-grid"
      style={{
        '--heatmap-aspect': `${cols} / ${cols}`,
        gridTemplateColumns: `${HEATMAP_ROW_HEADER_WIDTH}px repeat(${n}, 1fr)`,
        gridTemplateRows: `${HEATMAP_COL_HEADER_HEIGHT}px repeat(${n}, 1fr)`,
      } as CSSProperties}
    >
      <div role="cell" />

      {metrics.map((m) => (
        <div
          key={`col-${m}`}
          role="columnheader"
          className="text-secondary text-xs font-semibold truncate flex-center"
        >
          {shortName(m)}
        </div>
      ))}

      {metrics.map((rowMetric, ri) => (
        <div key={`row-${rowMetric}`} role="presentation" className="contents">
          <div
            role="rowheader"
            className="text-secondary text-xs font-semibold truncate flex-center heatmap-row-header"
          >
            {shortName(rowMetric)}
          </div>

          {metrics.map((colMetric, ci) => {
            const isDiag = ri === ci;
            const corr = isDiag ? undefined : corrMap.get(corrKey(rowMetric, colMetric));
            const value = isDiag ? 1 : corr?.pearsonR ?? 0;
            const isToxic = corr?.isKnownToxicCombo ?? false;
            const bg = isDiag ? 'var(--bg-surface)' : colorScale(value);

            const tooltip = isDiag
              ? `${rowMetric}: diagonal (1.00)`
              : corr
                ? `${corr.metricA} vs ${corr.metricB}\npearsonR: ${corr.pearsonR.toFixed(SCORE_DISPLAY_PRECISION)}\nlagHours: ${corr.lagHours}\npValue: ${formatScore(corr.pValue)}\nsignificant: ${corr.significant}`
                : `${rowMetric} vs ${colMetric}: no data`;

            return (
              <div
                key={`${ri}-${ci}`}
                role="cell"
                aria-label={`${rowMetric} vs ${colMetric}: ${value.toFixed(SCORE_CHIP_PRECISION)}`}
                data-toxic={isToxic ? 'true' : undefined}
                title={tooltip}
                onClick={!isDiag && onCellClick ? () => onCellClick(rowMetric, colMetric) : undefined}
                className={`mono-xs font-medium flex-center justify-center heatmap-cell${!isDiag && onCellClick ? ' cursor-pointer' : ''}`}
                style={{
                  '--heatmap-cell-bg': bg,
                  '--heatmap-cell-fg': isDiag ? 'var(--text-secondary)' : contrastText(value),
                } as CSSProperties}
              >
                {value.toFixed(SCORE_CHIP_PRECISION)}
              </div>
            );
          })}
        </div>
      ))}

    </div>
  );
}
