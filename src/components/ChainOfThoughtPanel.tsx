import { MetaItem } from './MetaItem.js';

interface ChainOfThoughtPanelProps {
  explanation?: string;
  evaluator?: string;
  evaluatorType?: string;
  scoreUnit?: string;
}

export function ChainOfThoughtPanel({ explanation, evaluator }: ChainOfThoughtPanelProps) {

  return (
    <div className="cot-panel">
      {explanation && (
        <details open>
          <summary className="cot-summary">Explanation</summary>
          <div className="cot-content">{explanation}</div>
        </details>
      )}
      {evaluator && (
        <div className="cot-content">
          <MetaItem label="Evaluator" value={evaluator} />
        </div>
      )}
      {!explanation && !evaluator && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No chain-of-thought data available.
        </div>
      )}
    </div>
  );
}
