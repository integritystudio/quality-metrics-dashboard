import { TrendChart } from './TrendChart.js';
import { useMetricDetail } from '../hooks/useMetricDetail.js';
import type { Period, MetricDynamics } from '../types.js';

interface MetricCompareProps {
  metricName?: string;
  period: Period;
  availableMetrics: string[];
  onMetricChange: (name: string) => void;
}

export function MetricCompare({ metricName, period, availableMetrics, onMetricChange }: MetricCompareProps) {
  const { data: detail } = useMetricDetail(metricName, period);

  if (!metricName) {
    return (
      <div className="text-muted text-center p-6">
        Select a metric from the heatmap or dropdown
      </div>
    );
  }

  return (
    <div className="p-4">
      <select
        value={metricName}
        onChange={(e) => onMetricChange(e.target.value)}
        className="mb-3 text-primary text-xs surface-elevated"
        style={{
          padding: '4px 8px',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {availableMetrics.map(m => <option key={m} value={m}>{m}</option>)}
      </select>

      {detail && (
        <div className="mb-3 flex-wrap gap-4">
          {(['avg', 'p50', 'p95'] as const).map(key => (
            <div key={key} className="text-center">
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
