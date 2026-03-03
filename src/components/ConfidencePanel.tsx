import type { ConfidenceIndicator } from '../types.js';
import { SCORE_COLORS, formatScore, formatPercent, type ScoreColorBand } from '../lib/quality-utils.js';
import {
  SCORE_THRESHOLD_GREEN, SCORE_THRESHOLD_YELLOW,
  VARIANCE_LOW_PCT, VARIANCE_MEDIUM_PCT, VARIANCE_DISPLAY_MIN_WIDTH,
  CONFIDENCE_MIN_SAMPLE_SIZE,
} from '../lib/constants.js';
import { BarIndicator } from './BarIndicator.js';


interface EvaluatorScore {
  evaluator: string;
  score: number;
  label?: string;
}

interface ConfidencePanelProps {
  confidence: ConfidenceIndicator;
  /** Per-evaluator scores for multi-judge display */
  evaluatorScores?: EvaluatorScore[];
}

function levelColor(level: string): string {
  if (level === 'high') return SCORE_COLORS.excellent;
  if (level === 'medium') return SCORE_COLORS.adequate;
  return SCORE_COLORS.failing;
}

function levelShape(level: string): string {
  if (level === 'high') return '\u25CF'; // ●
  if (level === 'medium') return '\u25D0'; // ◐
  return '\u25CB'; // ○
}

function VarianceBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const band: ScoreColorBand = pct < VARIANCE_LOW_PCT ? 'excellent' : pct < VARIANCE_MEDIUM_PCT ? 'adequate' : 'failing';
  return (
    <div className="variance-bar flex-center">
      <BarIndicator value={pct} color={SCORE_COLORS[band]} className="flex-1" />
      <span className="mono-xs text-secondary" style={{ minWidth: VARIANCE_DISPLAY_MIN_WIDTH }}>
        {value.toFixed(3)}
      </span>
    </div>
  );
}

export function ConfidencePanel({ confidence, evaluatorScores }: ConfidencePanelProps) {
  const { level, sampleCount, scoreStdDev, evaluatorCount, evaluatorAgreement } = confidence;
  const method = evaluatorCount > 1 ? 'multi-judge agreement' : sampleCount > CONFIDENCE_MIN_SAMPLE_SIZE ? 'sample size' : 'sample count';

  const hasMultiJudge = evaluatorScores && evaluatorScores.length > 1;

  return (
    <div className="text-xs">
      <div className="confidence-header flex-center">
        <span className="text-base" style={{ color: levelColor(level) }}>
          {levelShape(level)} {level}
        </span>
        <span className="confidence-method">({method})</span>
      </div>

      <div className="mb-3 text-xs" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 'var(--space-1) var(--space-4)' }}>
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
            <span className="mono" style={{
              color: evaluatorAgreement > SCORE_THRESHOLD_GREEN ? SCORE_COLORS.excellent : evaluatorAgreement > SCORE_THRESHOLD_YELLOW ? SCORE_COLORS.adequate : SCORE_COLORS.failing,
            }}>
              {formatPercent(evaluatorAgreement * 100, 0)}
            </span>
          </>
        )}
      </div>

      {hasMultiJudge && (
        <div>
          <div className="uppercase text-xs text-muted mb-1-5">Judge Panel</div>
          <div className="agreement-grid">
            <span className="ag-header">Evaluator</span>
            <span className="ag-header">Score</span>
            <span className="ag-header">Label</span>
            {evaluatorScores!.map((es) => (
              <div key={es.evaluator} className="contents">
                <span className="mono-xs">{es.evaluator}</span>
                <span className="mono-xs">{formatScore(es.score)}</span>
                <span className="text-secondary text-xs">{es.label ?? '-'}</span>
              </div>
            ))}
          </div>

          <div className="agreement-summary">
            <div>
              Agreement: <span className="summary-value">
                {evaluatorScores!.every(s => s.label === evaluatorScores![0].label) ? '100%' : 'partial'}
              </span>
              {' '}({evaluatorScores!.filter(s => s.label === evaluatorScores![0].label).length}/{evaluatorScores!.length} same label)
            </div>
            <div>
              Score Range: <span className="summary-value">
                {Math.min(...evaluatorScores!.map(s => s.score)).toFixed(2)} &ndash; {Math.max(...evaluatorScores!.map(s => s.score)).toFixed(2)}
              </span>
              {' '}(spread: {(Math.max(...evaluatorScores!.map(s => s.score)) - Math.min(...evaluatorScores!.map(s => s.score))).toFixed(3)})
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
