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
    <div className="flex-wrap gap-6">
      {SCORES.map(({ label, metricName }) => (
        <div key={label} className="text-center">
          <div className="field-label text-secondary text-xs mb-1">{label}</div>
          <ScoreBadge score={values[metricName]} metricName={metricName} />
        </div>
      ))}
    </div>
  );
}
