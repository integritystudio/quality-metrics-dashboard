import { memo } from 'react';
import { extent } from 'd3-array';
import { scaleLinear } from 'd3-scale';

interface SparklineProps {
  /** Array of score values (nulls allowed for gaps) */
  data: (number | null)[];
  /** SVG width in px */
  width?: number;
  /** SVG height in px */
  height?: number;
  /** Stroke color (CSS var or hex) */
  color?: string;
  /** Accessible label for the sparkline */
  label?: string;
}

function SparklineInner({ data, width = 80, height = 24, color = 'var(--text-secondary)', label }: SparklineProps) {
  const values = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length < 2) return null;

  const [minValue = 0, maxValue = 0] = extent(values);
  const pad = 2;
  const x = scaleLinear().domain([0, data.length - 1]).range([pad, width - pad]);
  // A flat series has no extent to scale; it draws along the bottom, as before.
  const y = scaleLinear().domain([minValue, maxValue === minValue ? minValue + 1 : maxValue]).range([height - pad, pad]);

  const points = data
    .map((v, i) => (v === null || !Number.isFinite(v) ? null : `${x(i)},${y(v)}`))
    .filter((p): p is string => p !== null)
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? 'Score trend sparkline'}
      className="d-block"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const Sparkline = memo(SparklineInner);
