import { ScoreBadge } from './ScoreBadge.js';

interface AgentScoreSummaryProps {
  handoffScore: number;
  avgRelevance: number;
  completeness: number;
}

const SCORES = [
  { label: 'Handoff Score', metricName: 'handoff' },
  { label: 'Avg Relevance', metricName: 'relevance' },
  { label: 'Completeness', metricName: 'completeness' },
] as const;

export function AgentScoreSummary({ handoffScore, avgRelevance, completeness }: AgentScoreSummaryProps) {
  const values = { handoff: handoffScore, relevance: avgRelevance, completeness };
  return (
    <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
      {SCORES.map(({ label, metricName }) => (
        <div key={label} style={{ textAlign: 'center' }}>
          <div className="field-label text-secondary text-xs mb-1">{label}</div>
          <ScoreBadge score={values[metricName]} metricName={metricName} />
        </div>
      ))}
    </div>
  );
}
