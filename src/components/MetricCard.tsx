import { memo } from 'react';
import { Link } from 'wouter';
import type { QualityMetricResult } from '../types.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './Indicators.js';

function formatValue(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A';
  return val.toFixed(4);
}

function MetricCardInner({ metric }: { metric: QualityMetricResult }) {
  const { name, displayName, sampleCount, status, values, trend, confidence, alerts } = metric;
  const primaryKey = values.p50 !== undefined && values.p50 !== null ? 'p50' : 'avg';
  const primaryValue = primaryKey === 'p50' ? values.p50 : values.avg;

  return (
    <Link href={`/metrics/${name}`} className="card-link" aria-label={`View ${displayName} metric details`}>
      <div className="card">
        <div className="metric-card-header">
          <h3>{displayName}</h3>
          <StatusBadge status={status} />
        </div>
        <div className="metric-values">
          <div className="primary">
            {formatValue(primaryValue)}
            {trend && <> <TrendIndicator trend={trend} /></>}
          </div>
          <div className="secondary">
            avg: {formatValue(values.avg)} &middot; p95: {formatValue(values.p95)}
          </div>
        </div>
        <div className="metric-footer">
          <span>n={sampleCount} <ConfidenceBadge confidence={confidence} /></span>
          {alerts.length > 0 && (
            <span style={{ color: 'var(--status-warning)' }}>
              {'\u25B2'} {alerts.length} alert{alerts.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export const MetricCard = memo(MetricCardInner);
