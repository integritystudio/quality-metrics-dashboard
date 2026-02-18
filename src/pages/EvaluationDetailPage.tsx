import { Link } from 'wouter';
import { useTraceEvaluations } from '../hooks/useTraceEvaluations.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { StepScoreChip } from '../components/EvaluationExpandedRow.js';

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: 4,
};

export function EvaluationDetailPage({ traceId }: { traceId: string }) {
  const { data: evaluations, isLoading, error } = useTraceEvaluations(traceId);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="card skeleton" style={{ height: 200 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      </div>
    );
  }

  if (!evaluations || evaluations.length === 0) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="empty-state">
          <h2>No Evaluations Found</h2>
          <p>No evaluations found for trace <code>{traceId}</code></p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      <div className="eval-detail-header">
        <h2 style={{ fontSize: 18 }}>Trace Evaluations</h2>
        <div className="eval-detail-meta">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {traceId}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {evaluations.length} evaluation{evaluations.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {evaluations.map((ev, i) => (
        <div key={i} className="eval-detail-card card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ScoreBadge
                score={ev.scoreValue ?? null}
                metricName={ev.evaluationName}
                label={ev.scoreLabel ?? (ev.scoreValue != null ? ev.scoreValue.toFixed(4) : undefined)}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{ev.evaluationName}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {new Date(ev.timestamp).toLocaleString()}
            </span>
          </div>

          <ChainOfThoughtPanel
            explanation={ev.explanation}
            evaluator={ev.evaluator}
            evaluatorType={ev.evaluatorType}
            scoreUnit={ev.scoreUnit}
          />

          {ev.stepScores && ev.stepScores.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={sectionLabelStyle}>Step Scores</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {ev.stepScores.map(s => (
                  <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
                ))}
              </div>
            </div>
          )}

          {ev.sessionId && (
            <div style={{ marginTop: 12 }}>
              <div style={sectionLabelStyle}>Provenance</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Session: {ev.sessionId}
                {ev.spanId && <> &middot; Span: {ev.spanId}</>}
                {ev.agentName && <> &middot; Agent: {ev.agentName}</>}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
