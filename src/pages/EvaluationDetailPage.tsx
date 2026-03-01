import { useTraceEvaluations } from '../hooks/useTraceEvaluations.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { ProvenancePanel } from '../components/ProvenancePanel.js';
import { StepScoreChip } from '../components/EvaluationExpandedRow.js';
import { PageShell } from '../components/PageShell.js';
import { SyncEmptyState } from '../components/SyncEmptyState.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import { Link, useSearch } from 'wouter';
import { ArrowLink } from '../components/ArrowLink.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';

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
          <DetailPageHeader title={heading} id={traceId}>
            <span className="text-secondary text-xs">
              {evaluations.length} evaluation{evaluations.length !== 1 ? 's' : ''}
            </span>
            <ArrowLink href={`/traces/${traceId}`}>View trace</ArrowLink>
            {metricFilter && (
              <Link
                href={`/evaluations/trace/${traceId}`}
                className="text-xs link-accent"
              >
                View all evaluations
              </Link>
            )}
          </DetailPageHeader>

          {evaluations.map((ev, i) => (
            <div key={`${ev.evaluationName}-${ev.timestamp}-${i}`} className="eval-detail-card card">
              <div className="flex-center mb-3 justify-between">
                <div className="flex-center gap-3">
                  <ScoreBadge
                    score={ev.scoreValue ?? null}
                    metricName={ev.evaluationName}
                    label={ev.scoreLabel ?? (ev.scoreValue != null ? ev.scoreValue.toFixed(4) : undefined)}
                  />
                  <span className="text-base" style={{ fontWeight: 500 }}>{ev.evaluationName}</span>
                </div>
                <span className="text-secondary text-xs" title={new Date(ev.timestamp).toLocaleString()}>
                  {formatTimestamp(ev.timestamp)}
                </span>
              </div>

              <ChainOfThoughtPanel
                explanation={ev.explanation}
                evaluator={ev.evaluator}
              />

              {ev.stepScores && ev.stepScores.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div className="section-label mb-1">Step Scores</div>
                  <div className="gap-1-5" style={{ display: 'flex', flexWrap: 'wrap', marginTop: 4 }}>
                    {ev.stepScores.map(s => (
                      <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
                    ))}
                  </div>
                </div>
              )}

              <details open style={{ marginTop: 12 }}>
                <summary className="cot-summary text-xs">Provenance &amp; Audit Trail</summary>
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
