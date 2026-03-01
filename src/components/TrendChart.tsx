import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { MetricDynamics } from '../types.js';
import type { MetricTrend } from '../types.js';
import { CHART_COLORS } from '../lib/constants.js';

interface TrendChartProps {
  trend?: MetricTrend;
  dynamics?: MetricDynamics;
  warningThreshold?: number;
  criticalThreshold?: number;
  metricName: string;
}

const COLORS = {
  ...CHART_COLORS,
  projection: CHART_COLORS.line,
};

function formatValue(v: number): string {
  return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toFixed(4);
}

function formatBreachTime(iso: string): string {
  const hours = (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hours <= 0) return 'threshold exceeded';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function TrendChart({
  trend,
  dynamics,
  warningThreshold,
  criticalThreshold,
  metricName,
}: TrendChartProps) {
  if (!trend) {
    return (
      <div style={{ color: COLORS.text, padding: 16, textAlign: 'center' }}>
        No trend data available
      </div>
    );
  }

  // Build data points: previous and current
  const data: Array<{ label: string; value: number; projected?: number }> = [
    { label: 'Previous', value: trend.previousValue },
    { label: 'Current', value: trend.currentValue },
  ];

  // If dynamics has projectedBreachTime or velocity, add projection point
  if (dynamics && dynamics.velocity !== 0) {
    const projectedValue = trend.currentValue + dynamics.velocity;
    data.push({
      label: 'Projected',
      value: trend.currentValue, // actual line ends here
      projected: projectedValue,
    });
    // Set current point's projected value to bridge the dashed line
    data[1].projected = trend.currentValue;
  }

  // Compute Y domain with some padding
  const allValues = data.flatMap((d) => [d.value, d.projected].filter((v): v is number => v != null));
  if (warningThreshold != null) allValues.push(warningThreshold);
  if (criticalThreshold != null) allValues.push(criticalThreshold);
  if (allValues.length === 0) {
    return <div style={{ color: COLORS.text, padding: 16, textAlign: 'center' }}>Insufficient data</div>;
  }
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.15 || 0.05;

  return (
    <div>
      <div aria-label={`Trend chart for ${metricName}`}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 16 }}>
            <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tick={{ fill: COLORS.text, fontSize: 12 }}
              stroke={COLORS.grid}
            />
            <YAxis
              domain={[yMin - yPad, yMax + yPad]}
              tick={{ fill: COLORS.text, fontSize: 12 }}
              stroke={COLORS.grid}
              tickFormatter={(v: number) => v.toFixed(2)}
              width={48}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: COLORS.tooltip,
                border: `1px solid ${COLORS.grid}`,
                borderRadius: 6,
                color: COLORS.text,
                fontSize: 12,
              }}
              formatter={(v: number | undefined) => [v != null ? formatValue(v) : 'N/A', '']}
              labelStyle={{ color: '#e6edf3' }}
            />
            {warningThreshold != null && (
              <ReferenceLine
                y={warningThreshold}
                stroke={COLORS.warning}
                strokeDasharray="6 3"
                label={{ value: 'Warning', fill: COLORS.warning, fontSize: 12, position: 'right' }}
              />
            )}
            {criticalThreshold != null && (
              <ReferenceLine
                y={criticalThreshold}
                stroke={COLORS.critical}
                strokeDasharray="6 3"
                label={{ value: 'Critical', fill: COLORS.critical, fontSize: 12, position: 'right' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="value"
              stroke={COLORS.line}
              strokeWidth={2}
              dot={{ fill: COLORS.line, r: 4 }}
              activeDot={{ r: 6 }}
              connectNulls
            />
            {dynamics && dynamics.velocity !== 0 && (
              <Line
                type="monotone"
                dataKey="projected"
                stroke={COLORS.projection}
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={{ fill: COLORS.projection, r: 3, strokeDasharray: '' }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {dynamics && (
        <div style={{
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          marginTop: 8,
          padding: '8px 0',
          fontSize: 12,
          color: COLORS.text,
        }}>
          <div>
            <span style={{ fontWeight: 600 }}>Velocity:</span>{' '}
            <span className="mono">
              {dynamics.velocity >= 0 ? '+' : ''}{formatValue(dynamics.velocity)}/hr
            </span>
          </div>
          <div>
            <span style={{ fontWeight: 600 }}>Acceleration:</span>{' '}
            <span className="mono">
              {dynamics.acceleration >= 0 ? '+' : ''}{formatValue(dynamics.acceleration)}/hr
            </span>
          </div>
          {dynamics.projectedBreachTime && (
            <div>
              <span style={{ fontWeight: 600 }}>Breach in:</span>{' '}
              <span className="mono" style={{
                color: dynamics.projectedStatus === 'critical' ? COLORS.critical : COLORS.warning,
              }}>
                {formatBreachTime(dynamics.projectedBreachTime)}
              </span>
            </div>
          )}
          <div>
            <span style={{ fontWeight: 600 }}>Confidence:</span>{' '}
            <span className="mono">
              {(dynamics.confidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
