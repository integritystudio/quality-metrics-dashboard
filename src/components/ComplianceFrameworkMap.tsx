const FRAMEWORKS = [
  {
    name: 'EU AI Act',
    articles: [
      { ref: 'Art. 9 — Risk Management', feature: 'SLA compliance tracking, alerts' },
      { ref: 'Art. 13 — Transparency', feature: 'Chain-of-thought, evaluation provenance' },
      { ref: 'Art. 14 — Human Oversight', feature: 'Human verification events' },
      { ref: 'Art. 15 — Accuracy & Robustness', feature: 'Quality metrics, trend analysis' },
    ],
  },
  {
    name: 'NIST AI RMF',
    articles: [
      { ref: 'MAP 1.5 — Impact Assessment', feature: 'Correlation heatmap, CQI' },
      { ref: 'MEASURE 2.6 — Evaluation', feature: 'LLM-as-Judge, Agent-as-Judge' },
      { ref: 'MEASURE 2.7 — AI System Performance', feature: 'Dashboard metrics, pipeline coverage' },
      { ref: 'MANAGE 4.1 — Risk Monitoring', feature: 'Alerts, threshold monitoring' },
    ],
  },
];

export function ComplianceFrameworkMap() {
  return (
    <div>
      {FRAMEWORKS.map(fw => (
        <div key={fw.name} className="card mb-3">
          <h4 className="mb-3 text-base">{fw.name}</h4>
          <table className="eval-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Reference</th>
                <th style={{ textAlign: 'left' }}>Dashboard Feature</th>
              </tr>
            </thead>
            <tbody>
              {fw.articles.map(a => (
                <tr key={a.ref}>
                  <td style={{ fontSize: 12 }}>{a.ref}</td>
                  <td className="text-secondary text-xs">{a.feature}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
