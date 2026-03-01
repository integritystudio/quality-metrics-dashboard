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
      <div style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>
        Select a metric from the heatmap or dropdown
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <select
        value={metricName}
        onChange={(e) => onMetricChange(e.target.value)}
        style={{
          marginBottom: 12,
          padding: '4px 8px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text-primary)',
          fontSize: 13,
        }}
      >
        {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {detail && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
          {(['avg', 'p50', 'p95'] as const).map(key => (
            <div key={key} style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600 }}>
                {detail.values[key]?.toFixed(4) ?? 'N/A'}
              </div>
              <div className="field-label">{key}</div>
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
