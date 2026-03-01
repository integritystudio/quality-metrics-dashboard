import { MetaItem } from './MetaItem.js';

interface ChainOfThoughtPanelProps {
  explanation?: string;
  evaluator?: string;
}

export function ChainOfThoughtPanel({ explanation, evaluator }: ChainOfThoughtPanelProps) {

  return (
    <div className="cot-panel">
      {explanation && (
        <details open>
          <summary className="cot-summary text-xs">Explanation</summary>
          <div className="cot-content">{explanation}</div>
        </details>
      )}
      {evaluator && (
        <div className="cot-content">
          <MetaItem label="Evaluator" value={evaluator} />
        </div>
      )}
      {!explanation && !evaluator && (
        <div className="text-muted text-xs">
          No chain-of-thought data available.
        </div>
      )}
    </div>
  );
}
