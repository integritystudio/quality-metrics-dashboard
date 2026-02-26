import { Link } from 'wouter';
import { useTrace } from '../hooks/useTrace.js';
import { SpanTree } from '../components/SpanTree.js';
import { EvaluationEventOverlay } from '../components/EvaluationEventOverlay.js';

export function TraceDetailPage({ traceId }: { traceId: string }) {
  const { data, isLoading, error } = useTrace(traceId);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="card skeleton" style={{ height: 300 }} />
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

  if (!data || (data.spans.length === 0 && data.evaluations.length === 0)) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="empty-state">
          <h2>No Trace Data</h2>
          <p>No spans or evaluations found for trace <code>{traceId}</code></p>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
            Trace data may not have been synced yet. Try again after the next sync cycle.
          </p>
        </div>
      </div>
    );
  }

  const evalsBySpan = new Map<string, number>();
  for (const ev of data.evaluations) {
    if (ev.spanId) {
      evalsBySpan.set(ev.spanId, (evalsBySpan.get(ev.spanId) ?? 0) + 1);
    }
  }

  const maxDuration = data.spans.reduce((max, s) => Math.max(max, s.durationMs ?? 0), 1);

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      <div className="eval-detail-header">
        <h2 style={{ fontSize: 18 }}>Trace Detail</h2>
        <div className="eval-detail-meta">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {traceId}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            {data.spans.length} span{data.spans.length !== 1 ? 's' : ''} &middot; {data.evaluations.length} evaluation{data.evaluations.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {data.evaluations.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Evaluation Summary</h3>
          <div className="card" style={{ padding: 16 }}>
            <EvaluationEventOverlay evaluations={data.evaluations} />
          </div>
        </div>
      )}

      {data.spans.length > 0 && (
        <div className="view-section">
          <h3 className="section-heading">Span Hierarchy</h3>
          <div className="card">
            <SpanTree spans={data.spans} evalsBySpan={evalsBySpan} maxDuration={maxDuration} />
          </div>
        </div>
      )}

      {data.spans.length === 0 && data.evaluations.length > 0 && (
        <div className="view-section">
          <div className="card" style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
            Span data not yet available for this trace. Evaluations are shown above.
          </div>
        </div>
      )}
    </div>
  );
}
