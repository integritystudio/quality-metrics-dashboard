import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Area,
  ResponsiveContainer,
} from 'recharts';
import { extent } from 'd3-array';
import { format, differenceInMilliseconds } from 'date-fns';
import type { TrendBucket } from '../hooks/useTrend.js';
import { CHART_COLORS, CHART_HEIGHT, CHART_MARGIN, CHART_GRID_PROPS, CHART_AXIS_TICK, CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE, CHART_YAXIS_WIDTH, CHART_YAXIS_TICK_FORMATTER } from '../lib/constants.js';
import { formatScore } from '../lib/quality-utils.js';
import { EmptyState } from './EmptyState.js';

interface TrendSeriesProps {
  data: TrendBucket[];
  metricName: string;
}

const TREND_COLORS = {
  band: 'rgba(88, 166, 255, 0.1)',
  bandStroke: 'rgba(88, 166, 255, 0.3)',
  background: '#131920', // --bg-card; must be a hex literal for SVG fill attribute
} as const;

function formatTime(iso: string, spanDays: number): string {
  const d = new Date(iso);
  if (spanDays <= 1) return format(d, 'HH:mm');
  if (spanDays <= 7) return format(d, 'EEE HH:mm');
  return format(d, 'MMM d');
}

export function TrendSeries({ data, metricName }: TrendSeriesProps) {
  if (data.length === 0) {
    return <EmptyState message="No trend data available" />;
  }

  const spanMs = differenceInMilliseconds(
    new Date(data[data.length - 1].endTime),
    new Date(data[0].startTime)
  );
  const spanDays = spanMs / (1000 * 60 * 60 * 24);

  const chartData = data.map((bucket) => ({
    time: formatTime(bucket.startTime, spanDays),
    avg: bucket.avg,
    p10: bucket.percentiles?.p10 ?? null,
    p50: bucket.percentiles?.p50 ?? null,
    p90: bucket.percentiles?.p90 ?? null,
    count: bucket.count,
  }));

  const allVals: number[] = [];
  for (const d of chartData) {
    if (d.avg !== null) allVals.push(d.avg);
    if (d.p10 !== null) allVals.push(d.p10);
    if (d.p90 !== null) allVals.push(d.p90);
  }
  if (allVals.length === 0) {
    return <EmptyState message="No scored evaluations in period" />;
  }

  const [yMin, yMax] = extent(allVals) as [number, number];
  const yPad = (yMax - yMin) * 0.15 || 0.05;

  return (
    <div role="img" aria-label={`Time series trend for ${metricName}`}>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <ComposedChart data={chartData} margin={CHART_MARGIN}>
          <CartesianGrid {...CHART_GRID_PROPS} />
          <XAxis
            dataKey="time"
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
            formatter={(v, name) => [
              formatScore(typeof v === 'number' ? v : null),
              name === 'avg' ? 'Average' : (String(name ?? '')).toUpperCase(),
            ]}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          />
          <Area
            type="monotone"
            dataKey="p90"
            stroke="none"
            fill={TREND_COLORS.band}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="p10"
            stroke="none"
            fill={TREND_COLORS.background}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="p50"
            stroke={TREND_COLORS.bandStroke}
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="avg"
            stroke={CHART_COLORS.line}
            strokeWidth={2}
            dot={{ fill: CHART_COLORS.line, r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex-center justify-center gap-4 mt-1 text-xs chart-dynamics">
        <span><span className="chart-line-indicator">&#9473;</span> avg</span>
        <span><span className="opacity-50">- -</span> p50</span>
        <span><span className="opacity-30">&#9608;</span> p10-p90</span>
      </div>
    </div>
  );
}
