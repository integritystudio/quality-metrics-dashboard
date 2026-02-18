import { memo } from 'react';

interface SparklineProps {
  /** Array of score values (nulls allowed for gaps) */
  data: (number | null)[];
  /** SVG width in px */
  width?: number;
  /** SVG height in px */
  height?: number;
  /** Stroke color (CSS var or hex) */
  color?: string;
}

function SparklineInner({ data, width = 80, height = 24, color = 'var(--text-secondary)' }: SparklineProps) {
  const values = data.filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;

  const points = data
    .map((v, i) => {
      if (v === null || !Number.isFinite(v)) return null;
      const x = pad + (i / (data.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / range) * (height - pad * 2);
      return `${x},${y}`;
    })
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Score trend sparkline"
      style={{ display: 'block' }}
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
