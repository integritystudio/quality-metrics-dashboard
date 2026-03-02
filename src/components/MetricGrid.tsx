import type { ReactNode } from 'react';
import type { QualityMetricResult } from '../types.js';
import { MetricCard } from './MetricCard.js';

export function MetricGrid({ metrics, sparklines, children }: {
  metrics?: QualityMetricResult[];
  sparklines?: Record<string, (number | null)[]>;
  children?: ReactNode;
}) {
  return (
    <div className="metric-grid">
      {children ?? metrics?.map((m) => (
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
