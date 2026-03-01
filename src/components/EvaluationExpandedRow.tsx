import type { CSSProperties } from 'react';
import { Link } from 'wouter';
import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { MetaItem } from './MetaItem.js';
import type { EvalRow } from './EvaluationTable.js';


export const chipBaseStyle: CSSProperties = {
  display: 'inline-block',
};

export function StepScoreChip({ step, score, explanation }: {
  step: string | number;
  score: number;
  explanation?: string;
}) {
  const band = scoreColorBand(score, 'maximize');
  const color = SCORE_COLORS[band];
  return (
    <span
      className="mono-xs chip"
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
      className="mono-xs chip"
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
        <div className="mb-3">
          <div className="section-label mb-1">Explanation</div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {row.explanation}
          </div>
        </div>
      )}

      {meta.length > 0 && (
        <div className="mb-3" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {meta.map(m => <MetaItem key={m.label} label={m.label} value={m.value} />)}
        </div>
      )}

      {row.stepScores && row.stepScores.length > 0 && (
        <div className="mb-3">
          <div className="section-label mb-1-5">Step Scores</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.stepScores.map(s => (
              <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
            ))}
          </div>
        </div>
      )}

      {row.toolVerifications && row.toolVerifications.length > 0 && (
        <div>
          <div className="section-label mb-1-5">Tool Verifications</div>
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

      {(row.traceId || row.sessionId) && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', gap: 16 }}>
          {row.traceId && (
            <Link href={`/evaluations/trace/${row.traceId}`} className="back-link" style={{ marginBottom: 0 }}>
              View full evaluation detail &rarr;
            </Link>
          )}
          {row.sessionId ? (
            <Link href={`/sessions/${row.sessionId}`} className="back-link" style={{ marginBottom: 0 }}>
              View trace spans &rarr;
            </Link>
          ) : row.traceId ? (
            <Link href={`/traces/${row.traceId}`} className="back-link" style={{ marginBottom: 0 }}>
              View trace spans &rarr;
            </Link>
          ) : null}
        </div>
      )}

      {!hasDetail && !row.traceId && !row.sessionId && (
        <div className="text-muted text-xs">
          No additional detail available.
        </div>
      )}
    </div>
  );
}
