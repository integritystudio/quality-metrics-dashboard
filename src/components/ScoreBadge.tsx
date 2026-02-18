import { scoreColorBand, type ScoreColorBand, type ScoreDirection } from '../lib/quality-utils.js';

interface ScoreBadgeProps {
  score: number | null;
  metricName: string;
  direction?: ScoreDirection;
  label?: string;
}

const SCORE_COLORS: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
  no_data: '#6b7280',
};

const SCORE_SHAPES: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '\u25CF',  // ●
  good: '\u25CF',       // ●
  adequate: '\u25B2',   // ▲
  poor: '\u25A0',       // ■
  failing: '\u25A0',    // ■
  no_data: '\u25CB',    // ○
};

export function ScoreBadge({ score, metricName, direction = 'maximize', label }: ScoreBadgeProps) {
  if (score === null) {
    return (
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: SCORE_COLORS.no_data }}
        aria-label={`${metricName}: no data`}
      >
        {SCORE_SHAPES.no_data} {label ?? 'N/A'}
      </span>
    );
  }

  const band = scoreColorBand(score, direction);
  const color = SCORE_COLORS[band];
  const shape = SCORE_SHAPES[band];
  const directionHint = direction === 'minimize' ? 'lower is better' : 'higher is better';

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color }}
      aria-label={`Score: ${score}, ${band} (${directionHint})`}
    >
      {shape} {label ?? score.toFixed(2)}
    </span>
  );
}
