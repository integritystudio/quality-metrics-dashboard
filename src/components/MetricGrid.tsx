import type { QualityMetricResult } from '../types.js';
import { MetricCard } from './MetricCard.js';

export function MetricGrid({ metrics }: { metrics: QualityMetricResult[] }) {
  return (
    <div className="metric-grid">
      {metrics.map((m) => (
        <MetricCard key={m.name} metric={m} />
      ))}
    </div>
  );
}

export function MetricGridSkeleton() {
  return (
    <div className="metric-grid">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="card skeleton" style={{ height: 160 }} />
      ))}
    </div>
  );
}
