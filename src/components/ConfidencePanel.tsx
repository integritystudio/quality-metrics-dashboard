import type { ConfidenceIndicator } from '../types.js';
import { SCORE_COLORS, type ScoreColorBand } from '../lib/quality-utils.js';

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
  const band: ScoreColorBand = pct < 20 ? 'excellent' : pct < 50 ? 'adequate' : 'failing';
  return (
    <div className="variance-bar">
      <div className="variance-bar-track">
        <div className="variance-bar-fill" style={{ width: `${pct}%`, background: SCORE_COLORS[band] }} />
      </div>
      <span className="mono-xs text-secondary" style={{ minWidth: 36 }}>
        {value.toFixed(3)}
      </span>
    </div>
  );
}

export function ConfidencePanel({ confidence, evaluatorScores }: ConfidencePanelProps) {
  const { level, sampleCount, scoreStdDev, evaluatorCount, evaluatorAgreement } = confidence;
  const method = evaluatorCount > 1 ? 'multi-judge agreement' : sampleCount > 50 ? 'sample size' : 'sample count';

  const hasMultiJudge = evaluatorScores && evaluatorScores.length > 1;

  return (
    <div className="text-xs">
      <div className="confidence-header">
        <span className="text-base" style={{ color: levelColor(level) }}>
          {levelShape(level)} {level}
        </span>
        <span className="confidence-method">({method})</span>
      </div>

      <div className="mb-3" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: 12 }}>
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
              color: evaluatorAgreement > 0.8 ? SCORE_COLORS.excellent : evaluatorAgreement > 0.5 ? SCORE_COLORS.adequate : SCORE_COLORS.failing,
            }}>
              {(evaluatorAgreement * 100).toFixed(0)}%
            </span>
          </>
        )}
      </div>

      {hasMultiJudge && (
        <div>
          <div className="section-label mb-1-5">Judge Panel</div>
          <div className="agreement-grid">
            <span className="ag-header">Evaluator</span>
            <span className="ag-header">Score</span>
            <span className="ag-header">Label</span>
            {evaluatorScores!.map((es) => (
              <div key={es.evaluator} style={{ display: 'contents' }}>
                <span className="mono-xs">{es.evaluator}</span>
                <span className="mono-xs">{es.score.toFixed(4)}</span>
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
