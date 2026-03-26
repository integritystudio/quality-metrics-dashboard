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
import type { MetricDynamics, MetricTrend } from '../types.js';
import {
  CHART_COLORS, CHART_MARGIN, CHART_GRID_PROPS, CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE, CHART_YAXIS_WIDTH, CHART_YAXIS_TICK_FORMATTER,
  CHART_HEIGHT, CHART_STROKE_WIDTH, CHART_DOT_RADIUS, CHART_DOT_RADIUS_ACTIVE, CHART_DOT_RADIUS_PROJECTED,
  CHART_DASH_THRESHOLD, CHART_DASH_PROJECTED, TIME_MS,
} from '../lib/constants.js';
import { formatPercent } from '../lib/quality-utils.js';
import { EmptyState } from './EmptyState.js';

interface TrendChartProps {
  trend?: MetricTrend;
  dynamics?: MetricDynamics;
  warningThreshold?: number;
  criticalThreshold?: number;
  metricName: string;
}

function formatValue(v: number): string {
  return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toFixed(4);
}

function formatBreachTime(iso: string): string {
  const hours = (new Date(iso).getTime() - Date.now()) / TIME_MS.HOUR;
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
    return <EmptyState message="No trend data available" />;
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
    return <EmptyState message="Insufficient data" />;
  }
  const yMin = Math.min(...allValues);
  const yMax = Math.max(...allValues);
  const yPad = (yMax - yMin) * 0.15 || 0.05;

  return (
    <div>
      <div role="img" aria-label={`Trend chart for ${metricName}`}>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <LineChart data={data} margin={CHART_MARGIN}>
            <CartesianGrid {...CHART_GRID_PROPS} />
            <XAxis
              dataKey="label"
              tick={CHART_AXIS_TICK}
              stroke={CHART_COLORS.grid}
            />
            <YAxis
              domain={[yMin - yPad, yMax + yPad]}
              tick={CHART_AXIS_TICK}
              stroke={CHART_COLORS.grid}
              tickFormatter={CHART_YAXIS_TICK_FORMATTER}
              width={CHART_YAXIS_WIDTH}
            />
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              formatter={(v) => [typeof v === 'number' ? formatValue(v) : 'N/A', '']}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            />
            {warningThreshold != null && (
              <ReferenceLine
                y={warningThreshold}
                stroke={CHART_COLORS.warning}
                strokeDasharray={CHART_DASH_THRESHOLD}
                label={{ value: 'Warning', fill: CHART_COLORS.warning, fontSize: CHART_AXIS_TICK.fontSize, position: 'right' }}
              />
            )}
            {criticalThreshold != null && (
              <ReferenceLine
                y={criticalThreshold}
                stroke={CHART_COLORS.critical}
                strokeDasharray={CHART_DASH_THRESHOLD}
                label={{ value: 'Critical', fill: CHART_COLORS.critical, fontSize: CHART_AXIS_TICK.fontSize, position: 'right' }}
              />
            )}
            <Line
              type="monotone"
              dataKey="value"
              stroke={CHART_COLORS.line}
              strokeWidth={CHART_STROKE_WIDTH}
              dot={{ fill: CHART_COLORS.line, r: CHART_DOT_RADIUS }}
              activeDot={{ r: CHART_DOT_RADIUS_ACTIVE }}
              connectNulls
            />
            {dynamics && dynamics.velocity !== 0 && (
              <Line
                type="monotone"
                dataKey="projected"
                stroke={CHART_COLORS.line}
                strokeWidth={CHART_STROKE_WIDTH}
                strokeDasharray={CHART_DASH_PROJECTED}
                dot={{ fill: CHART_COLORS.line, r: CHART_DOT_RADIUS_PROJECTED, strokeDasharray: '' }}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {dynamics && (
        <div className="flex-wrap text-xs gap-6 mt-2" style={{
          padding: 'var(--space-2) 0',
          color: CHART_COLORS.text,
        }}>
          <div>
            <span className="font-semibold">Velocity:</span>{' '}
            <span className="mono">
              {dynamics.velocity >= 0 ? '+' : ''}{formatValue(dynamics.velocity)}/hr
            </span>
          </div>
          <div>
            <span className="font-semibold">Acceleration:</span>{' '}
            <span className="mono">
              {dynamics.acceleration >= 0 ? '+' : ''}{formatValue(dynamics.acceleration)}/hr
            </span>
          </div>
          {dynamics.projectedBreachTime && (
            <div>
              <span className="font-semibold">Breach in:</span>{' '}
              <span className="mono" style={{
                color: dynamics.projectedStatus === 'critical' ? CHART_COLORS.critical : CHART_COLORS.warning,
              }}>
                {formatBreachTime(dynamics.projectedBreachTime)}
              </span>
            </div>
          )}
          <div>
            <span className="font-semibold">Confidence:</span>{' '}
            <span className="mono">
              {formatPercent(dynamics.confidence * 100, 0)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
