import { useTrace } from '../hooks/useTrace.js';
import { SpanTree } from '../components/SpanTree.js';
import { EvaluationEventOverlay } from '../components/EvaluationEventOverlay.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { SyncEmptyState } from '../components/SyncEmptyState.js';

export function TraceDetailPage({ traceId }: { traceId: string }) {
  const { data, isLoading, error } = useTrace(traceId);

  const isEmpty = !data || (data.spans.length === 0 && data.evaluations.length === 0);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={300}>
      {isEmpty ? (
        <SyncEmptyState
          title="No Trace Data"
          description={<>No spans or evaluations found for trace <code>{traceId}</code></>}
        />
      ) : (
        <>
          <DetailPageHeader title="Trace Detail" id={traceId}>
            <span className="text-secondary text-xs">
              {data.spans.length} span{data.spans.length !== 1 ? 's' : ''} &middot; {data.evaluations.length} evaluation{data.evaluations.length !== 1 ? 's' : ''}
            </span>
          </DetailPageHeader>

          {data.evaluations.length > 0 && (
            <ViewSection title="Evaluation Summary">
              <div className="card" style={{ padding: 16 }}>
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
              <div className="card text-muted text-xs" style={{ padding: 16 }}>
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
