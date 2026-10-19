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
import type { ReactNode } from 'react';
import { extent } from 'd3-array';
import type { MetricDynamics, MetricTrend } from '../types.js';
import {
  CHART_COLORS, CHART_MARGIN, CHART_GRID_PROPS, CHART_AXIS_TICK,
  CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE, CHART_YAXIS_WIDTH, CHART_YAXIS_TICK_FORMATTER,
  CHART_HEIGHT, CHART_STROKE_WIDTH, CHART_DOT_RADIUS, CHART_DOT_RADIUS_ACTIVE, CHART_DOT_RADIUS_PROJECTED,
  CHART_DASH_THRESHOLD, CHART_DASH_PROJECTED, TIME_MS, SCORE_FORMAT_PRECISION, COMPACT_UNIT_PRECISION,
} from '../lib/constants.js';
import { formatPercent } from '../lib/quality-utils.js';
import { EmptyState } from './EmptyState.js';

type TrendChartProps = {
  trend?: MetricTrend | undefined;
  dynamics?: MetricDynamics | undefined;
  warningThreshold?: number | undefined;
  criticalThreshold?: number | undefined;
  metricName: string;
}

function formatValue(v: number): string {
  return Math.abs(v) < 0.001 ? v.toExponential(2) : v.toFixed(SCORE_FORMAT_PRECISION);
}

function formatBreachTime(iso: string): string {
  const hours = (new Date(iso).getTime() - Date.now()) / TIME_MS.HOUR;
  if (hours <= 0) return 'threshold exceeded';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(COMPACT_UNIT_PRECISION)}h`;
  return `${(hours / 24).toFixed(COMPACT_UNIT_PRECISION)}d`;
}

type TrendPoint = { label: string; value: number; projected?: number };

/** A flat series pads to this fraction of its range; a flat one to this constant. */
const Y_PAD_FRACTION = 0.15;
const Y_PAD_MIN = 0.05;

/**
 * Previous and current, plus a projected point when the dynamics carry a
 * velocity. The current point takes a `projected` value of its own so the
 * dashed line bridges from it instead of starting in mid-air.
 */
function buildTrendSeries(trend: MetricTrend, dynamics: MetricDynamics | undefined): { data: TrendPoint[]; projected: boolean } {
  const data: TrendPoint[] = [
    { label: 'Previous', value: trend.previousValue },
    { label: 'Current', value: trend.currentValue },
  ];
  if (!dynamics || dynamics.velocity === 0) return { data, projected: false };
  data.push({
    label: 'Projected',
    value: trend.currentValue, // actual line ends here
    projected: trend.currentValue + dynamics.velocity,
  });
  const current = data[1];
  if (current) current.projected = trend.currentValue;
  return { data, projected: true };
}

/** The padded y domain over actual, projected and threshold values; null when there is nothing to plot. */
function trendYDomain(
  data: readonly TrendPoint[],
  warningThreshold: number | undefined,
  criticalThreshold: number | undefined,
): [number, number] | null {
  const allValues: number[] = [];
  for (const d of data) {
    allValues.push(d.value);
    if (d.projected != null) allValues.push(d.projected);
  }
  if (warningThreshold != null) allValues.push(warningThreshold);
  if (criticalThreshold != null) allValues.push(criticalThreshold);
  if (allValues.length === 0) return null;
  const [yMin, yMax] = extent(allValues) as [number, number];
  const yPad = (yMax - yMin) * Y_PAD_FRACTION || Y_PAD_MIN;
  return [yMin - yPad, yMax + yPad];
}

/** Velocity, acceleration, projected breach and confidence, under the chart. */
function TrendDynamics({ dynamics }: { dynamics: MetricDynamics | undefined }): ReactNode {
  if (!dynamics) return null;
  return (
    <div className="flex-wrap text-xs gap-6 mt-2 py-2 chart-dynamics">
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
          <span className="mono chart-breach-time" data-status={dynamics.projectedStatus}>
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
  );
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

  const { data, projected } = buildTrendSeries(trend, dynamics);
  const yDomain = trendYDomain(data, warningThreshold, criticalThreshold);
  if (!yDomain) {
    return <EmptyState message="Insufficient data" />;
  }

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
              domain={yDomain}
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
            {projected && (
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
      <TrendDynamics dynamics={dynamics} />
    </div>
  );
}
