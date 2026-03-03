import { useTrace } from '../hooks/useTrace.js';
import { SpanTree } from '../components/SpanTree.js';
import { EvaluationEventOverlay } from '../components/EvaluationEventOverlay.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { EmptyState } from '../components/EmptyState.js';
import { plural } from '../lib/quality-utils.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

export function TraceDetailPage({ traceId }: { traceId: string }) {
  const { data, isLoading, error } = useTrace(traceId);

  const isEmpty = !data || (data.spans.length === 0 && data.evaluations.length === 0);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {isEmpty ? (
        <EmptyState
          title="No Trace Data"
          description={<>No spans or evaluations found for trace <code>{traceId}</code></>}
          showSyncHint
        />
      ) : (
        <>
          <DetailPageHeader title="Trace Detail" id={traceId}>
            <span className="text-secondary text-xs">
              {plural(data.spans.length, 'span')} &middot; {plural(data.evaluations.length, 'evaluation')}
            </span>
          </DetailPageHeader>

          {data.evaluations.length > 0 && (
            <ViewSection title="Evaluation Summary">
              <div className="card p-4">
                <EvaluationEventOverlay evaluations={data.evaluations} traceId={traceId} />
              </div>
            </ViewSection>
          )}

          {data.spans.length > 0 && (
            <ViewSection title="Span Hierarchy">
              <div className="card">
                <SpanTree
                  spans={data.spans}
                  evalsBySpan={buildEvalsBySpan(data.evaluations)}
                  maxDuration={data.spans.reduce((max, s) => Math.max(max, s.durationMs ?? 0), 1)}
                />
              </div>
            </ViewSection>
          )}

          {data.spans.length === 0 && data.evaluations.length > 0 && (
            <div className="view-section">
              <div className="card text-muted text-xs p-4">
                Span data not yet available for this trace. Evaluations are shown above.
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

function buildEvalsBySpan(evaluations: Array<{ spanId?: string }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const ev of evaluations) {
    if (ev.spanId) {
      map.set(ev.spanId, (map.get(ev.spanId) ?? 0) + 1);
    }
  }
  return map;
}
