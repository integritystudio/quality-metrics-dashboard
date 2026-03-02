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
import type { TrendBucket } from '../hooks/useTrend.js';
import { CHART_COLORS, CHART_MARGIN, CHART_GRID_PROPS, CHART_AXIS_TICK, CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE, CHART_YAXIS_WIDTH, CHART_YAXIS_TICK_FORMATTER } from '../lib/constants.js';
import { EmptyState } from './EmptyState.js';

interface TrendSeriesProps {
  data: TrendBucket[];
  metricName: string;
}

const COLORS = {
  ...CHART_COLORS,
  band: 'rgba(88, 166, 255, 0.1)',
  bandStroke: 'rgba(88, 166, 255, 0.3)',
  background: 'var(--bg-card)',
};

function formatTime(iso: string, spanDays: number): string {
  const d = new Date(iso);
  if (spanDays <= 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (spanDays <= 7) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function TrendSeries({ data, metricName }: TrendSeriesProps) {
  if (data.length === 0) {
    return <EmptyState message="No trend data available" />;
  }

  const spanMs = new Date(data[data.length - 1].endTime).getTime() - new Date(data[0].startTime).getTime();
  const spanDays = spanMs / (1000 * 60 * 60 * 24);

  const chartData = data.map((bucket) => ({
    time: formatTime(bucket.startTime, spanDays),
    avg: bucket.avg,
    p10: bucket.percentiles?.p10 ?? null,
    p50: bucket.percentiles?.p50 ?? null,
    p90: bucket.percentiles?.p90 ?? null,
    count: bucket.count,
  }));

  const allVals = chartData.flatMap(d =>
    [d.avg, d.p10, d.p90].filter((v): v is number => v !== null)
  );
  if (allVals.length === 0) {
    return <EmptyState message="No scored evaluations in period" />;
  }

  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const yPad = (yMax - yMin) * 0.15 || 0.05;

  return (
    <div role="img" aria-label={`Time series trend for ${metricName}`}>
      <ResponsiveContainer width="100%" height={220}>
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
            formatter={(v: number | string | undefined, name?: string) => [
              typeof v === 'number' ? v.toFixed(4) : 'N/A',
              name === 'avg' ? 'Average' : (name ?? '').toUpperCase(),
            ]}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
          />
          {/* P10-P90 band */}
          <Area
            type="monotone"
            dataKey="p90"
            stroke="none"
            fill={COLORS.band}
            connectNulls
          />
          <Area
            type="monotone"
            dataKey="p10"
            stroke="none"
            fill={COLORS.background}
            connectNulls
          />
          {/* P50 line */}
          <Line
            type="monotone"
            dataKey="p50"
            stroke={COLORS.bandStroke}
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            connectNulls
          />
          {/* Average line */}
          <Line
            type="monotone"
            dataKey="avg"
            stroke={COLORS.line}
            strokeWidth={2}
            dot={{ fill: COLORS.line, r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex-center justify-center gap-4 mt-1 text-xs" style={{ color: COLORS.text }}>
        <span><span style={{ color: COLORS.line }}>&#9473;</span> avg</span>
        <span><span style={{ opacity: 0.5 }}>- -</span> p50</span>
        <span><span style={{ opacity: 0.3 }}>&#9608;</span> p10-p90</span>
      </div>
    </div>
  );
}
