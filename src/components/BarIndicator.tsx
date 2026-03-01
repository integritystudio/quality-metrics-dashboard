import type { CSSProperties } from 'react';

interface BarIndicatorProps {
  /** Percentage width 0-100 */
  value: number;
  /** Fill color (default: CSS var(--accent)) */
  color?: string;
  /** Fill opacity (default: 1) */
  opacity?: number;
  /** Track height override via --bar-h CSS custom prop (default: CSS 4px) */
  height?: number;
  /** Track background (default: CSS var(--bg-surface)) */
  trackColor?: string;
  /** Extra class on the track div */
  className?: string;
  /** Extra inline styles on the track div (merged with internal overrides) */
  style?: CSSProperties;
}

export function BarIndicator({
  value,
  color,
  opacity,
  height,
  trackColor,
  className,
  style,
}: BarIndicatorProps) {
  const trackStyle: CSSProperties = {
    ...style,
    ...(height != null && { '--bar-h': `${height}px` } as CSSProperties),
    ...(trackColor && { background: trackColor }),
  };

  const fillStyle: CSSProperties = {
    width: `${value}%`,
  };
  if (color) fillStyle.background = color;
  if (opacity != null) fillStyle.opacity = opacity;

  return (
    <div
      className={className ? `mini-bar ${className}` : 'mini-bar'}
      style={trackStyle}
    >
      <div
        className="mini-bar-fill"
        style={fillStyle}
      />
    </div>
  );
}
