interface ChainOfThoughtPanelProps {
  explanation?: string;
  evaluator?: string;
  evaluatorType?: string;
  scoreUnit?: string;
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
  marginBottom: 4,
};

function MetaItem({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div style={{ minWidth: 120 }}>
      <div style={sectionLabelStyle}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

export function ChainOfThoughtPanel({ explanation, evaluator, evaluatorType, scoreUnit }: ChainOfThoughtPanelProps) {
  const hasConfig = evaluator || evaluatorType || scoreUnit;

  return (
    <div className="cot-panel">
      {explanation && (
        <details open>
          <summary className="cot-summary">Explanation</summary>
          <div className="cot-content">{explanation}</div>
        </details>
      )}
      {hasConfig && (
        <details>
          <summary className="cot-summary">Judge Configuration</summary>
          <div className="cot-content" style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <MetaItem label="Evaluator" value={evaluator} />
            <MetaItem label="Evaluator Type" value={evaluatorType} />
            <MetaItem label="Score Unit" value={scoreUnit} />
          </div>
        </details>
      )}
      {!explanation && !hasConfig && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No chain-of-thought data available.
        </div>
      )}
    </div>
  );
}
