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

function TooltipRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="tooltip-row">
      <span>{label}</span>
      <span style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-label)' } : undefined}>{value}</span>
    </div>
  );
}

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
      <TooltipRow label="Score" value={score.toFixed(4)} mono />
      {label && <TooltipRow label="Label" value={label} />}
      {evaluator && <TooltipRow label="Evaluator" value={evaluator} mono />}
      {evaluatorType && <TooltipRow label="Type" value={evaluatorType} />}
      {explanation && (
        <div className="tooltip-row" style={{ flexDirection: 'column', gap: 2 }}>
          <span>Explanation</span>
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-label)' }}>{truncateText(explanation, 120)}</span>
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
