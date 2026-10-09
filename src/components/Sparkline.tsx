import { memo } from 'react';
import { min, max } from 'd3-array';

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

  const minValue = min(values) ?? 0;
  const maxValue = max(values) ?? 0;
  const range = maxValue - minValue || 1;
  const pad = 2;
  const xDenom = data.length > 1 ? data.length - 1 : 1;

  const points = data
    .map((v, i) => {
      if (v === null || !Number.isFinite(v)) return null;
      const x = pad + (i / xDenom) * (width - pad * 2);
      const y = pad + (1 - (v - minValue) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
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
