import { scaleSequential } from 'd3-scale';
import { interpolateRdYlGn } from 'd3-scale-chromatic';
import type { CorrelationFeature } from '../../../dist/lib/quality-feature-engineering.js';

interface CorrelationHeatmapProps {
  correlations: CorrelationFeature[];
  metrics: string[];
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

/** Returns black or white text for contrast against a background color */
function contrastText(pearsonR: number): string {
  // Middle range values have lighter background; extreme values are dark
  return Math.abs(pearsonR) > 0.5 ? '#fff' : '#111';
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

export function CorrelationHeatmap({ correlations, metrics }: CorrelationHeatmapProps) {
  const n = metrics.length;
  const cols = n + 1;

  return (
    <div
      role="table"
      aria-label="Metric correlation matrix"
      style={{
        display: 'grid',
        gridTemplateColumns: `80px repeat(${n}, 1fr)`,
        gridTemplateRows: `32px repeat(${n}, 1fr)`,
        gap: 2,
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
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-secondary)',
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
        <div key={`row-${rowMetric}`} role="presentation" style={{ display: 'contents' }}>
          {/* Row header */}
          <div
            role="rowheader"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: 8,
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-secondary)',
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
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: bg,
                  color: isDiag ? 'var(--text-secondary)' : contrastText(value),
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
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

      {/* Keyframe animation for toxic combo pulse */}
      <style>{`
        @keyframes toxicPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(240, 68, 56, 0.4); }
          50% { box-shadow: 0 0 6px 2px rgba(240, 68, 56, 0.6); }
        }
      `}</style>
    </div>
  );
}
