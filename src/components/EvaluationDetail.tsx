import { EvaluationTable, type EvalRow } from './EvaluationTable.js';

interface EvalEntry {
  score: number;
  explanation?: string;
  traceId?: string;
  timestamp?: string;
  evaluator?: string;
  label?: string;
}

export function EvaluationDetail({
  worst,
  best,
}: {
  worst: EvalEntry[];
  best: EvalEntry[];
}) {
  const allEvals: EvalRow[] = [...worst, ...best];
  return (
    <div>
      <EvaluationTable evaluations={allEvals} />
    </div>
  );
}
