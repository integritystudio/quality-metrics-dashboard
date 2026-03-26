import { Link } from 'wouter';
import { scoreColorBand, adaptiveScoreColorBand, truncateText, formatScore, SCORE_COLORS, type ScoreDirection, type PercentileDistribution } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';
import { routes } from '../lib/routes.js';
import { SCORE_SHAPES } from '../lib/symbols.js';
import { useMetricCalibration } from '../context/CalibrationContext.js';
import type { ReactNode } from 'react';

function MetadataRow({ label, value, mono }: { label: string; value?: ReactNode; mono?: boolean }) {
  if (value == null || value === '') return null;
  return (
    <div className="tooltip-row">
      <span className="text-secondary">{label}</span>
      <span className={mono ? 'mono-xs' : undefined}>{value}</span>
    </div>
  );
}

interface ScoreBadgeProps {
  score: number | null;
  metricName: string;
  direction?: ScoreDirection;
  label?: string;
  evaluator?: string;
  evaluatorType?: string;
  explanation?: string;
  traceId?: string;
  calibration?: { distribution: PercentileDistribution; sampleSize: number };
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
    <div className="score-badge-tooltip surface-elevated" role="tooltip">
      <MetadataRow label="Score" value={formatScore(score)} mono />
      <MetadataRow label="Label" value={label} />
      <MetadataRow label="Evaluator" value={evaluator} mono />
      <MetadataRow label="Type" value={evaluatorType} />
      {explanation && (
        <div className="tooltip-row tooltip-row--col gap-half">
          <span className="text-secondary">Explanation</span>
          <span className="text-secondary text-xs">{truncateText(explanation, 120)}</span>
        </div>
      )}
      {traceId && (
        <Link href={routes.evaluationDetail(traceId)} className="tooltip-link text-xs">
          View full explanation &rarr;
        </Link>
      )}
    </div>
  );
}

export function ScoreBadge({ score, metricName, direction = 'maximize', label, evaluator, evaluatorType, explanation, traceId, calibration: calibrationProp }: ScoreBadgeProps) {
  const contextCalibration = useMetricCalibration(metricName);
  const calibration = calibrationProp ?? contextCalibration;
  const hasTooltip = evaluator || evaluatorType || explanation || traceId;

  if (score === null) {
    return (
      <span
        className="inline-flex-center gap-1"
        style={{ color: SCORE_COLORS.no_data }}
        aria-label={`${metricName}: no data`}
      >
        {SCORE_SHAPES.no_data} {label ?? 'N/A'}
      </span>
    );
  }

  const band = calibration
    ? adaptiveScoreColorBand(score, metricName, direction, calibration.distribution, calibration.sampleSize)
    : scoreColorBand(score, direction);
  const color = SCORE_COLORS[band];
  const shape = SCORE_SHAPES[band];
  const directionHint = direction === 'minimize' ? 'lower is better' : 'higher is better';

  const badge = (
    <span
      className="inline-flex-center gap-1"
      style={{ color }}
      aria-label={`Score: ${score}, ${band} (${directionHint})`}
    >
      {shape} {label ?? score.toFixed(SCORE_CHIP_PRECISION)}
    </span>
  );

  if (!hasTooltip) return badge;

  return (
    <span className="score-badge-wrapper inline-flex-center" tabIndex={0}>
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
