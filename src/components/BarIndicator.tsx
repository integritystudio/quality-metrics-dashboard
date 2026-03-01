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
  style?: React.CSSProperties;
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
  const trackStyle = {
    ...style,
    ...(height != null && { '--bar-h': `${height}px` }),
    ...(trackColor && { background: trackColor }),
  } as React.CSSProperties;

  const fillStyle: React.CSSProperties = {
    width: `${value}%`,
  };
  if (color) fillStyle.background = color;
  if (opacity != null) fillStyle.opacity = opacity;

  return (
    <div
      className={className ? `mini-bar ${className}` : 'mini-bar'}
      style={Object.keys(trackStyle).length > 0 ? trackStyle : undefined}
    >
      <div
        className="mini-bar-fill"
        style={fillStyle}
      />
    </div>
  );
}
