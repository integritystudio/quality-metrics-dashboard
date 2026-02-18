import { Link } from 'wouter';
import { scoreColorBand, truncateText, SCORE_COLORS, type ScoreColorBand, type ScoreDirection } from '../lib/quality-utils.js';

interface ScoreBadgeProps {
  score: number | null;
  metricName: string;
  direction?: ScoreDirection;
  label?: string;
  evaluator?: string;
  evaluatorType?: string;
  explanation?: string;
  traceId?: string;
}

const SCORE_SHAPES: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '\u25CF',  // ●
  good: '\u25CF',       // ●
  adequate: '\u25B2',   // ▲
  poor: '\u25A0',       // ■
  failing: '\u25A0',    // ■
  no_data: '\u25CB',    // ○
};

function Tooltip({ score, label, evaluator, evaluatorType, explanation, traceId }: {
  score: number;
  label?: string;
  evaluator?: string;
  evaluatorType?: string;
  explanation?: string;
  traceId?: string;
}) {
  return (
    <div className="score-badge-tooltip" role="tooltip">
      <div className="tooltip-row">
        <span>Score</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{score.toFixed(4)}</span>
      </div>
      {label && (
        <div className="tooltip-row">
          <span>Label</span>
          <span>{label}</span>
        </div>
      )}
      {evaluator && (
        <div className="tooltip-row">
          <span>Evaluator</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{evaluator}</span>
        </div>
      )}
      {evaluatorType && (
        <div className="tooltip-row">
          <span>Type</span>
          <span>{evaluatorType}</span>
        </div>
      )}
      {explanation && (
        <div className="tooltip-row" style={{ flexDirection: 'column', gap: 2 }}>
          <span>Explanation</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{truncateText(explanation, 120)}</span>
        </div>
      )}
      {traceId && (
        <Link href={`/evaluations/trace/${traceId}`} className="tooltip-link">
          View full explanation &rarr;
        </Link>
      )}
    </div>
  );
}

export function ScoreBadge({ score, metricName, direction = 'maximize', label, evaluator, evaluatorType, explanation, traceId }: ScoreBadgeProps) {
  const hasTooltip = evaluator || evaluatorType || explanation || traceId;

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

  const badge = (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color }}
      aria-label={`Score: ${score}, ${band} (${directionHint})`}
    >
      {shape} {label ?? score.toFixed(2)}
    </span>
  );

  if (!hasTooltip) return badge;

  return (
    <span className="score-badge-wrapper" tabIndex={0}>
      {badge}
      <Tooltip
        score={score}
        label={label}
        evaluator={evaluator}
        evaluatorType={evaluatorType}
        explanation={explanation}
        traceId={traceId}
      />
    </span>
  );
}
