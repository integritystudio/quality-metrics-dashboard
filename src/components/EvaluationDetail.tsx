import { useState } from 'react';
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
  const [prevMetric, setPrevMetric] = useState(metricName);

  if (prevMetric !== metricName) {
    setPrevMetric(metricName);
    setShowAll(false);
  }

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
        <div className="flex-center gap-3 mt-3">
          {!showAll ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="text-xs cursor-pointer btn-reset text-accent"
              style={{
                border: '1px solid var(--border)',
                padding: 'var(--space-1-5) 14px',
                borderRadius: 'var(--radius)',
              }}
            >
              Show all evaluations
            </button>
          ) : isLoading ? (
            <span className="text-secondary text-xs">Loading...</span>
          ) : data ? (
            <span className="text-secondary text-xs">
              Showing {data.rows.length} of {data.total} evaluations
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
