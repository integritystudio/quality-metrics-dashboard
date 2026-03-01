import type { CSSProperties, ReactNode } from 'react';

interface ColoredChipProps {
  color: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function ColoredChip({ color, title, className, style, children }: ColoredChipProps) {
  return (
    <span
      className={`mono-xs chip${className ? ` ${className}` : ''}`}
      title={title}
      style={{
        display: 'inline-block',
        backgroundColor: `${color}20`,
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
