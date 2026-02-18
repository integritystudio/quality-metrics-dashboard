import { scoreColorBand } from '../lib/quality-utils.js';
import type { EvalRow } from './EvaluationTable.js';

const BAND_COLORS: Record<string, string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
};

function MetaItem({ label, value }: { label: string; value?: string | number }) {
  if (value == null) return null;
  return (
    <div style={{ minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 2, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
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

  return (
    <div className="eval-expanded-content" style={{
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius)',
      padding: 16,
      animation: 'fade-in 0.15s ease-in-out',
    }}>
      {row.explanation && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Explanation
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {row.explanation}
          </div>
        </div>
      )}

      {meta.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 12 }}>
          {meta.map(m => (
            <MetaItem key={m.label} label={m.label} value={m.value} />
          ))}
        </div>
      )}

      {row.stepScores && row.stepScores.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Step Scores
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.stepScores.map((s) => {
              const band = scoreColorBand(s.score, 'maximize');
              return (
                <span
                  key={`${s.step}`}
                  title={s.explanation ?? `Step ${s.step}: ${s.score.toFixed(2)}`}
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: `${BAND_COLORS[band]}20`,
                    color: BAND_COLORS[band],
                  }}
                >
                  {s.step}: {s.score.toFixed(2)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {row.toolVerifications && row.toolVerifications.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 }}>
            Tool Verifications
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {row.toolVerifications.map((tv, i) => {
              const ok = tv.toolCorrect && tv.argsCorrect;
              const color = ok ? '#26d97f' : '#f04438';
              return (
                <span
                  key={`${tv.toolName}-${i}`}
                  title={`tool: ${tv.toolCorrect ? 'correct' : 'wrong'}, args: ${tv.argsCorrect ? 'correct' : 'wrong'}, score: ${tv.score.toFixed(2)}`}
                  style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    backgroundColor: `${color}20`,
                    color,
                  }}
                >
                  {tv.toolName} {tv.score.toFixed(2)}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {!row.explanation && meta.length === 0 && !row.stepScores?.length && !row.toolVerifications?.length && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No additional detail available.
        </div>
      )}
    </div>
  );
}
