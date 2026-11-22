import type { ConfidenceIndicator } from '../types.js';
import { SCORE_COLORS, formatPercent, percentOf, scoreColorBand, type ScoreColorBand } from '../lib/quality-utils.js';
import {
  VARIANCE_LOW_PCT, VARIANCE_MEDIUM_PCT,
  CONFIDENCE_MIN_SAMPLE_SIZE, SCORE_DISPLAY_PRECISION,
  PERCENT_MAX, PERCENT_MULTIPLIER,
} from '../lib/constants.js';
import { BarIndicator } from './BarIndicator.js';

type ConfidencePanelProps = {
  confidence: ConfidenceIndicator;
}

const LEVEL_STATUS: Record<ConfidenceIndicator['level'], 'healthy' | 'warning' | 'critical'> = {
  high: 'healthy',
  medium: 'warning',
  low: 'critical',
};

function levelShape(level: string): string {
  if (level === 'high') return '\u25CF'; // ●
  if (level === 'medium') return '\u25D0'; // ◐
  return '\u25CB'; // ○
}

function VarianceBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(PERCENT_MAX, percentOf(value, max)) : 0;
  const band: ScoreColorBand = pct < VARIANCE_LOW_PCT ? 'excellent' : pct < VARIANCE_MEDIUM_PCT ? 'adequate' : 'failing';
  return (
    <div className="variance-bar flex-center">
      <BarIndicator value={pct} color={SCORE_COLORS[band]} className="flex-1" />
      <span className="mono-xs text-secondary variance-value">
        {value.toFixed(SCORE_DISPLAY_PRECISION)}
      </span>
    </div>
  );
}

export function ConfidencePanel({ confidence }: ConfidencePanelProps) {
  const { level, sampleCount, scoreStdDev, evaluatorCount, evaluatorAgreement } = confidence;
  const method = evaluatorCount > 1 ? 'multi-judge agreement' : sampleCount > CONFIDENCE_MIN_SAMPLE_SIZE ? 'sample size' : 'sample count';

  return (
    <div className="text-xs">
      <div className="confidence-header flex-center">
        <span className="text-base confidence-level-indicator" data-status={LEVEL_STATUS[level]}>
          {levelShape(level)} {level}
        </span>
        <span className="confidence-method">({method})</span>
      </div>

      <div className="confidence-stats-grid mb-3 text-xs">
        <span className="text-secondary">Sample Count</span>
        <span className="mono">{sampleCount}</span>

        {scoreStdDev != null && (
          <>
            <span className="text-secondary">Score Variance</span>
            <VarianceBar value={scoreStdDev} max={0.5} />
          </>
        )}

        <span className="text-secondary">Evaluators</span>
        <span className="mono">{evaluatorCount}</span>

        {evaluatorAgreement != null && (
          <>
            <span className="text-secondary">Agreement</span>
            <span
              className="mono agreement-value"
              data-band={scoreColorBand(evaluatorAgreement)}
            >
              {formatPercent(evaluatorAgreement * PERCENT_MULTIPLIER, 0)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
