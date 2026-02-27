import { Link } from 'wouter';
import { useTraceEvaluations } from '../hooks/useTraceEvaluations.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { ProvenancePanel } from '../components/ProvenancePanel.js';
import { StepScoreChip } from '../components/EvaluationExpandedRow.js';
import { formatTimestamp } from '../lib/quality-utils.js';

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
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            Evaluation data may not have been synced yet. Try again after the next sync cycle.
          </p>
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
          <Link href={`/traces/${traceId}`} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>
            View trace &rarr;
          </Link>
        </div>
      </div>

      {evaluations.map((ev, i) => (
        <div key={`${ev.evaluationName}-${ev.timestamp}-${i}`} className="eval-detail-card card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ScoreBadge
                score={ev.scoreValue ?? null}
                metricName={ev.evaluationName}
                label={ev.scoreLabel ?? (ev.scoreValue != null ? ev.scoreValue.toFixed(4) : undefined)}
              />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{ev.evaluationName}</span>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }} title={new Date(ev.timestamp).toLocaleString()}>
              {formatTimestamp(ev.timestamp)}
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
              <div className="section-label">Step Scores</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {ev.stepScores.map(s => (
                  <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
                ))}
              </div>
            </div>
          )}

          <details style={{ marginTop: 12 }}>
            <summary className="cot-summary">Provenance &amp; Audit Trail</summary>
            <div style={{ paddingTop: 8 }}>
              <ProvenancePanel
                evaluationName={ev.evaluationName}
                scoreValue={ev.scoreValue}
                scoreLabel={ev.scoreLabel}
                traceId={ev.traceId ?? traceId}
                spanId={ev.spanId}
                sessionId={ev.sessionId}
                timestamp={ev.timestamp}
                evaluator={ev.evaluator}
                evaluatorType={ev.evaluatorType}
                scoreUnit={ev.scoreUnit}
                agentName={ev.agentName}
                rawData={ev as unknown as Record<string, unknown>}
              />
            </div>
          </details>
        </div>
      ))}
    </div>
  );
}
