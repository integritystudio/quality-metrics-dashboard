import { useTraceEvaluations } from '../hooks/useTraceEvaluations.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { ProvenancePanel } from '../components/ProvenancePanel.js';
import { StepScoreChip } from '../components/EvaluationExpandedRow.js';
import { PageShell } from '../components/PageShell.js';
import { SyncEmptyState } from '../components/SyncEmptyState.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import { Link, useSearch } from 'wouter';

export function EvaluationDetailPage({ traceId }: { traceId: string }) {
  const { data: allEvaluations, isLoading, error } = useTraceEvaluations(traceId);

  const search = useSearch();
  const metricFilter = new URLSearchParams(search).get('metric');

  const evaluations = metricFilter && allEvaluations
    ? allEvaluations.filter(ev => ev.evaluationName === metricFilter)
    : allEvaluations;

  const heading = metricFilter
    ? `${metricFilter} Evaluations`
    : 'Trace Evaluations';

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={200}>
      {(!evaluations || evaluations.length === 0) ? (
        <SyncEmptyState
          title="No Evaluations Found"
          description={<>No evaluations found for trace <code>{traceId}</code></>}
        />
      ) : (
        <>
          <div className="eval-detail-header">
            <h2 className="page-heading">{heading}</h2>
            <div className="eval-detail-meta">
              <span className="id-chip">{traceId}</span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {evaluations.length} evaluation{evaluations.length !== 1 ? 's' : ''}
              </span>
              <Link href={`/traces/${traceId}`} style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}>
                View trace &rarr;
              </Link>
              {metricFilter && (
                <Link
                  href={`/evaluations/trace/${traceId}`}
                  style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}
                >
                  View all evaluations
                </Link>
              )}
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

              <details open style={{ marginTop: 12 }}>
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
        </>
      )}
    </PageShell>
  );
}
