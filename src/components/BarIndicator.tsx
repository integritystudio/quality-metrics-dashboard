import type { CSSProperties } from 'react';

interface BarIndicatorProps {
  /** Percentage width 0-100 */
  value: number;
  /** Fill color (default: CSS var(--accent)) */
  color?: string;
  /** Fill opacity (default: 1, set in CSS) */
  opacity?: number;
  /** Track height override via --bar-h CSS custom prop (default: CSS 4px) */
  height?: number;
  /** Track background (default: CSS var(--bg-surface)) */
  trackColor?: string;
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
    '--bar-fill-width': `${value}%`,
    ...(height != null && { '--bar-h': `${height}px` } as CSSProperties),
    ...(trackColor && { '--bar-track-color': trackColor } as CSSProperties),
    ...(color && { '--bar-fill-color': color } as CSSProperties),
    ...(opacity != null && { '--bar-fill-opacity': opacity } as CSSProperties),
  } as CSSProperties;

  return (
    <div
      className={className ? `mini-bar ${className}` : 'mini-bar'}
      style={trackStyle}
    >
      <div className="mini-bar-fill" />
    </div>
  );
}
