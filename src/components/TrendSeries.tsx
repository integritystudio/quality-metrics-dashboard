import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Area,
  ResponsiveContainer,
} from 'recharts';
import type { TrendBucket } from '../hooks/useTrend.js';

interface TrendSeriesProps {
  data: TrendBucket[];
  metricName: string;
}

const COLORS = {
  line: '#58a6ff',
  band: 'rgba(88, 166, 255, 0.1)',
  bandStroke: 'rgba(88, 166, 255, 0.3)',
  grid: '#30363d',
  text: '#8b949e',
  tooltip: '#161b22',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function TrendSeries({ data, metricName }: TrendSeriesProps) {
  if (data.length === 0) {
    return (
      <div style={{ color: COLORS.text, padding: 16, textAlign: 'center' }}>
        No trend data available
      </div>
    );
  }

  const chartData = data.map((bucket) => ({
    time: formatTime(bucket.startTime),
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
    return (
      <div style={{ color: COLORS.text, padding: 16, textAlign: 'center' }}>
        No scored evaluations in period
      </div>
    );
  }

  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const yPad = (yMax - yMin) * 0.15 || 0.05;

  return (
    <div aria-label={`Time series trend for ${metricName}`}>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: 16 }}>
          <CartesianGrid stroke={COLORS.grid} strokeDasharray="3 3" />
          <XAxis
            dataKey="time"
            tick={{ fill: COLORS.text, fontSize: 11 }}
            stroke={COLORS.grid}
          />
          <YAxis
            domain={[yMin - yPad, yMax + yPad]}
            tick={{ fill: COLORS.text, fontSize: 11 }}
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
            formatter={(v: number | string | undefined, name?: string) => [
              typeof v === 'number' ? v.toFixed(4) : 'N/A',
              name === 'avg' ? 'Average' : (name ?? '').toUpperCase(),
            ]}
            labelStyle={{ color: '#e6edf3' }}
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
            fill="#0d1117"
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
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 16, justifyContent: 'center', fontSize: 11, color: COLORS.text, marginTop: 4 }}>
        <span><span style={{ color: COLORS.line }}>&#9473;</span> avg</span>
        <span><span style={{ opacity: 0.5 }}>- -</span> p50</span>
        <span><span style={{ opacity: 0.3 }}>&#9608;</span> p10-p90</span>
      </div>
    </div>
  );
}
