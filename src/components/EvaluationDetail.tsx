interface EvalEntry {
  score: number;
  explanation?: string;
  traceId?: string;
  timestamp?: string;
  evaluator?: string;
}

function EvalTable({ title, evals }: { title: string; evals: EvalEntry[] }) {
  if (evals.length === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ fontSize: 14, marginBottom: 8, color: 'var(--text-secondary)' }}>{title}</h4>
      <table className="eval-table">
        <thead>
          <tr>
            <th>Score</th>
            <th>Explanation</th>
            <th>Evaluator</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {evals.map((ev, i) => (
            <tr key={i}>
              <td>{ev.score.toFixed(4)}</td>
              <td className="explanation" title={ev.explanation ?? ''}>
                {ev.explanation ?? '-'}
              </td>
              <td>{ev.evaluator ?? '-'}</td>
              <td>{ev.timestamp ? new Date(ev.timestamp).toLocaleString() : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EvaluationDetail({
  worst,
  best,
}: {
  worst: EvalEntry[];
  best: EvalEntry[];
}) {
  return (
    <div>
      <EvalTable title="Worst Evaluations" evals={worst} />
      <EvalTable title="Best Evaluations" evals={best} />
    </div>
  );
}
