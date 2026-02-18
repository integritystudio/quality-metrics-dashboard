import { scoreColorBand, type ScoreColorBand } from '../lib/quality-utils.js';
import type { EvalRow } from './EvaluationTable.js';

const BAND_COLORS: Record<ScoreColorBand, string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: 4,
};

const chipBaseStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 10,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
};

function MetaItem({ label, value }: { label: string; value?: string | number }) {
  if (value == null) return null;
  return (
    <div style={{ minWidth: 120 }}>
      <div style={sectionLabelStyle}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 2, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

export function StepScoreChip({ step, score, explanation }: {
  step: string | number;
  score: number;
  explanation?: string;
}) {
  const band = scoreColorBand(score, 'maximize');
  const color = BAND_COLORS[band];
  return (
    <span
      key={`${step}`}
      title={explanation ?? `Step ${step}: ${score.toFixed(2)}`}
      style={{ ...chipBaseStyle, backgroundColor: `${color}20`, color }}
    >
      {step}: {score.toFixed(2)}
    </span>
  );
}

export function ToolVerificationChip({ toolName, toolCorrect, argsCorrect, score, index }: {
  toolName: string;
  toolCorrect: boolean;
  argsCorrect: boolean;
  score: number;
  index: number;
}) {
  const ok = toolCorrect && argsCorrect;
  const color = ok ? '#26d97f' : '#f04438';
  return (
    <span
      key={`${toolName}-${index}`}
      title={`tool: ${toolCorrect ? 'correct' : 'wrong'}, args: ${argsCorrect ? 'correct' : 'wrong'}, score: ${score.toFixed(2)}`}
      style={{ ...chipBaseStyle, backgroundColor: `${color}20`, color }}
    >
      {toolName} {score.toFixed(2)}
    </span>
  );
}

export function EvaluationExpandedRow({ row }: { row: EvalRow }) {
  const meta = [
    { label: 'Evaluator Type', value: row.evaluatorType },
    { label: 'Trace ID', value: row.traceId },
    { label: 'Span ID', value: row.spanId },
    { label: 'Session ID', value: row.sessionId },
    { label: 'Agent', value: row.agentName },
    { label: 'Trajectory Length', value: row.trajectoryLength },
  ].filter(m => m.value != null);

  const hasDetail = row.explanation || meta.length > 0 ||
    (row.stepScores && row.stepScores.length > 0) ||
    (row.toolVerifications && row.toolVerifications.length > 0);

  return (
    <div className="eval-expanded-content" style={{
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius)',
      padding: 16,
      animation: 'fade-in 0.15s ease-in-out',
    }}>
      {row.explanation && (
        <div style={{ marginBottom: 12 }}>
          <div style={sectionLabelStyle}>Explanation</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {row.explanation}
          </div>
        </div>
      )}

      {meta.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
          {meta.map(m => <MetaItem key={m.label} label={m.label} value={m.value} />)}
        </div>
      )}

      {row.stepScores && row.stepScores.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ ...sectionLabelStyle, marginBottom: 6 }}>Step Scores</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.stepScores.map(s => (
              <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
            ))}
          </div>
        </div>
      )}

      {row.toolVerifications && row.toolVerifications.length > 0 && (
        <div>
          <div style={{ ...sectionLabelStyle, marginBottom: 6 }}>Tool Verifications</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.toolVerifications.map((tv, i) => (
              <ToolVerificationChip
                key={`${tv.toolName}-${i}`}
                toolName={tv.toolName}
                toolCorrect={tv.toolCorrect}
                argsCorrect={tv.argsCorrect}
                score={tv.score}
                index={i}
              />
            ))}
          </div>
        </div>
      )}

      {!hasDetail && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No additional detail available.
        </div>
      )}
    </div>
  );
}
