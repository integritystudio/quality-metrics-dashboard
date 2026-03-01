import { scaleSequential } from 'd3-scale';
import { interpolateRdYlGn } from 'd3-scale-chromatic';
import type { CorrelationFeature } from '../types.js';

interface CorrelationHeatmapProps {
  correlations: CorrelationFeature[];
  metrics: string[];
  onCellClick?: (rowMetric: string, colMetric: string) => void;
}

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
  // Parse "rgb(r, g, b)" string from d3
  const m = bg.match(/(\d+)/g);
  if (!m || m.length < 3) return '#111';
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
  return L > 0.18 ? '#111' : '#fff';
}

const colorScale = scaleSequential(interpolateRdYlGn).domain([-1, 1]);

function lookupCorrelation(
  correlations: CorrelationFeature[],
  a: string,
  b: string,
): CorrelationFeature | undefined {
  return correlations.find(
    (c) => (c.metricA === a && c.metricB === b) || (c.metricA === b && c.metricB === a),
  );
}

export function CorrelationHeatmap({ correlations, metrics, onCellClick }: CorrelationHeatmapProps) {
  const n = metrics.length;
  const cols = n + 1;

  return (
    <div
      role="table"
      aria-label="Metric correlation matrix"
      className="gap-half"
      style={{
        display: 'grid',
        gridTemplateColumns: `80px repeat(${n}, 1fr)`,
        gridTemplateRows: `32px repeat(${n}, 1fr)`,
        width: '100%',
        aspectRatio: `${cols} / ${cols}`,
      }}
    >
      {/* Top-left empty corner */}
      <div role="cell" />

      {/* Column headers */}
      {metrics.map((m) => (
        <div
          key={`col-${m}`}
          role="columnheader"
          className="text-secondary text-xs font-semibold"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {shortName(m)}
        </div>
      ))}

      {/* Rows */}
      {metrics.map((rowMetric, ri) => (
        <div key={`row-${rowMetric}`} role="presentation" className="contents">
          {/* Row header */}
          <div
            role="rowheader"
            className="text-secondary text-xs font-semibold"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 8,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {shortName(rowMetric)}
          </div>

          {/* Data cells */}
          {metrics.map((colMetric, ci) => {
            const isDiag = ri === ci;
            const corr = isDiag ? undefined : lookupCorrelation(correlations, rowMetric, colMetric);
            const value = isDiag ? 1 : corr?.pearsonR ?? 0;
            const isToxic = corr?.isKnownToxicCombo ?? false;
            const bg = isDiag ? 'var(--bg-secondary, #2a2a2a)' : colorScale(value);

            const tooltip = isDiag
              ? `${rowMetric}: diagonal (1.00)`
              : corr
                ? `${corr.metricA} vs ${corr.metricB}\npearsonR: ${corr.pearsonR.toFixed(3)}\nlagHours: ${corr.lagHours}\npValue: ${corr.pValue?.toFixed(4) ?? 'N/A'}\nsignificant: ${corr.significant}`
                : `${rowMetric} vs ${colMetric}: no data`;

            return (
              <div
                key={`${ri}-${ci}`}
                role="cell"
                aria-label={`${rowMetric} vs ${colMetric}: ${value.toFixed(2)}`}
                title={tooltip}
                onClick={!isDiag && onCellClick ? () => onCellClick(rowMetric, colMetric) : undefined}
                className="mono-xs"
                style={{
                  cursor: !isDiag && onCellClick ? 'pointer' : 'default',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: bg,
                  color: isDiag ? 'var(--text-secondary)' : contrastText(value),
                  fontWeight: 500,
                  borderRadius: 2,
                  border: isToxic ? '2px solid #f04438' : 'none',
                  animation: isToxic ? 'toxicPulse 2s ease-in-out infinite' : undefined,
                  minHeight: 36,
                }}
              >
                {value.toFixed(2)}
              </div>
            );
          })}
        </div>
      ))}

    </div>
  );
}
