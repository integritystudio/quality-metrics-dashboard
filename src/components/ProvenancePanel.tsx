import { useCallback } from 'react';
import { Link } from 'wouter';

interface EvaluatorTypeCounts {
  rule: number;
  llm: number;
  seed: number;
  canary: number;
}

interface ProvenancePanelProps {
  evaluationName: string;
  scoreValue?: number;
  scoreLabel?: string;
  traceId?: string;
  spanId?: string;
  sessionId?: string;
  timestamp: string;
  evaluator?: string;
  evaluatorType?: string;
  scoreUnit?: string;
  agentName?: string;
  /** Raw evaluation object for JSON export */
  rawData?: Record<string, unknown>;
  /** Evaluator type breakdown counts */
  evaluatorTypeCounts?: EvaluatorTypeCounts;
}

export function ProvenancePanel(props: ProvenancePanelProps) {
  const {
    evaluationName, scoreValue, scoreLabel,
    traceId, spanId, sessionId, timestamp,
    evaluator, evaluatorType, scoreUnit,
    agentName, rawData, evaluatorTypeCounts,
  } = props;

  const handleExportJson = useCallback(() => {
    const data = rawData ?? {
      evaluationName,
      scoreValue,
      scoreLabel,
      traceId,
      spanId,
      sessionId,
      timestamp,
      evaluator,
      evaluatorType,
      scoreUnit,
      agentName,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eval-${evaluationName}-${new Date(timestamp).getTime()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rawData, evaluationName, scoreValue, scoreLabel, traceId, spanId, sessionId, timestamp, evaluator, evaluatorType, scoreUnit, agentName]);

  const handleCopyTraceLink = useCallback(() => {
    if (traceId) {
      const link = `${window.location.origin}/traces/${traceId}`;
      navigator.clipboard.writeText(link).catch(() => {});
    }
  }, [traceId]);

  const entries: Array<{ label: string; value: string | undefined }> = [
    { label: 'Evaluation', value: evaluationName },
    { label: 'Score', value: scoreValue != null ? `${scoreValue.toFixed(4)}${scoreLabel ? ` (${scoreLabel})` : ''}` : undefined },
    { label: 'Evaluator', value: evaluator },
    { label: 'Type', value: evaluatorType },
    { label: 'Score Unit', value: scoreUnit },
    { label: 'Trace ID', value: traceId },
    { label: 'Span ID', value: spanId },
    { label: 'Session ID', value: sessionId },
    { label: 'Agent', value: agentName },
    { label: 'Evaluated At', value: new Date(timestamp).toISOString() },
    { label: 'OTel Event', value: 'gen_ai.evaluation.result' },
  ];

  return (
    <div className="text-xs">
      <div className="provenance-grid">
        {entries.map(({ label, value }) => value ? (
          <div key={label} style={{ display: 'contents' }}>
            <span className="prov-label">{label}</span>
            <span className="prov-value">
              {label === 'Trace ID' && traceId ? (
                <Link href={`/traces/${traceId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                  {traceId}
                </Link>
              ) : label === 'Session ID' && sessionId ? (
                <Link href={`/sessions/${sessionId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                  {sessionId}
                </Link>
              ) : value}
            </span>
          </div>
        ) : null)}
      </div>
      {evaluatorTypeCounts && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
          {(Object.entries(evaluatorTypeCounts) as Array<[keyof EvaluatorTypeCounts, number]>)
            .filter(([, count]) => count > 0)
            .map(([type, count]) => (
              <span
                key={type}
                className="mono-xs text-secondary chip"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border)',
                }}
              >
                {type}
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {count}
                </span>
              </span>
            ))}
        </div>
      )}
      <div className="provenance-actions">
        <button type="button" className="text-xs" onClick={handleExportJson}>
          Export as JSON
        </button>
        {traceId && (
          <button type="button" className="text-xs" onClick={handleCopyTraceLink}>
            Copy trace link
          </button>
        )}
      </div>
    </div>
  );
}
