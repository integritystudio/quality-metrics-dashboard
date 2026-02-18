import { useState, useEffect, useRef } from 'react';
import { EvaluationTable, type EvalRow } from './EvaluationTable.js';
import { useMetricEvaluations } from '../hooks/useMetricEvaluations.js';
import type { Period } from '../types.js';

export function EvaluationDetail({
  worst,
  best,
  metricName,
  period,
}: {
  worst: EvalRow[];
  best: EvalRow[];
  metricName?: string;
  period?: Period;
}) {
  const [showAll, setShowAll] = useState(false);
  const prevMetricRef = useRef(metricName);

  useEffect(() => {
    if (prevMetricRef.current !== metricName) {
      prevMetricRef.current = metricName;
      setShowAll(false);
    }
  }, [metricName]);

  const { data, isLoading } = useMetricEvaluations(metricName, period, {
    limit: 200,
    enabled: showAll && !!metricName,
  });

  const topEvals: EvalRow[] = [...worst, ...best];
  const displayEvals = showAll && data ? data.rows : topEvals;

  return (
    <div>
      <EvaluationTable evaluations={displayEvals} />
      {metricName && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
          {!showAll ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              style={{
                background: 'none',
                border: '1px solid var(--border)',
                color: 'var(--accent)',
                padding: '6px 14px',
                borderRadius: 6,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Show all evaluations
            </button>
          ) : isLoading ? (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading...</span>
          ) : data ? (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Showing {data.rows.length} of {data.total} evaluations
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
