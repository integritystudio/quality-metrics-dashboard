import { useState } from 'react';
import { TrendChart } from './TrendChart.js';
import { useMetricDetail } from '../hooks/useMetricDetail.js';
import { useTrend } from '../hooks/useTrend.js';
import type { Period, MetricDynamics } from '../types.js';

interface MetricCompareProps {
  metricName?: string;
  period: Period;
  availableMetrics: string[];
  onMetricChange: (name: string) => void;
}

export function MetricCompare({ metricName, period, availableMetrics, onMetricChange }: MetricCompareProps) {
  const { data: detail } = useMetricDetail(metricName, period);
  const { data: trend } = useTrend(metricName ?? '', period, 10);

  if (!metricName) {
    return (
      <div className="text-muted" style={{ padding: 24, textAlign: 'center' }}>
        Select a metric from the heatmap or dropdown
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <select
        value={metricName}
        onChange={(e) => onMetricChange(e.target.value)}
        className="mb-3"
        style={{
          padding: '4px 8px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-primary)',
          fontSize: 12,
        }}
      >
        {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {detail && (
        <div className="mb-3 gap-4" style={{ display: 'flex', flexWrap: 'wrap' }}>
          {(['avg', 'p50', 'p95'] as const).map(key => (
            <div key={key} style={{ textAlign: 'center' }}>
              <div className="mono text-md font-semibold">
                {detail.values[key]?.toFixed(4) ?? 'N/A'}
              </div>
              <div className="field-label text-secondary text-xs">{key}</div>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <TrendChart
          trend={detail.trend}
          dynamics={(detail as typeof detail & { dynamics?: MetricDynamics }).dynamics}
          metricName={metricName}
        />
      )}
    </div>
  );
}
