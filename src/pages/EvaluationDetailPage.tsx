import { useTraceEvaluations } from '../hooks/useTraceEvaluations.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { ProvenancePanel } from '../components/ProvenancePanel.js';
import { StepScoreChip } from '../components/EvaluationExpandedRow.js';
import { PageShell } from '../components/PageShell.js';
import { SyncEmptyState } from '../components/SyncEmptyState.js';
import { formatTimestamp, formatScore, plural } from '../lib/quality-utils.js';
import { routes } from '../lib/routes.js';
import { Link, useSearch } from 'wouter';
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
              {plural(evaluations.length, 'evaluation')}
            </span>
            <Link href={routes.trace(traceId)} className="text-xs link-accent">View trace &rarr;</Link>
            {metricFilter && (
              <Link
                href={routes.evaluationDetail(traceId)}
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
                    label={ev.scoreLabel ?? (ev.scoreValue != null ? formatScore(ev.scoreValue) : undefined)}
                  />
                  <span className="text-base font-medium">{ev.evaluationName}</span>
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
                <div className="mt-3">
                  <div className="section-label mb-1">Step Scores</div>
                  <div className="gap-1-5 mt-1 flex-wrap">
                    {ev.stepScores.map(s => (
                      <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
                    ))}
                  </div>
                </div>
              )}

              <details open className="mt-3">
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
