import type { QualityMetricResult } from '../types.js';
import { MetricCard } from './MetricCard.js';

export function MetricGrid({ metrics, sparklines }: {
  metrics: QualityMetricResult[];
  sparklines?: Record<string, (number | null)[]>;
}) {
  return (
    <div className="metric-grid">
      {metrics.map((m) => (
        <MetricCard key={m.name} metric={m} sparklineData={sparklines?.[m.name]} />
      ))}
    </div>
  );
}

export function MetricGridSkeleton() {
  return (
    <div className="metric-grid">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="card skeleton" style={{ height: 180 }} />
      ))}
    </div>
  );
}
