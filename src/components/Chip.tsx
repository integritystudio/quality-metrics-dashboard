import type { CSSProperties, ReactNode } from 'react';
import { scoreColor, type ScoreDirection } from '../lib/quality-utils.js';

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
      className={`mono-xs chip d-inline-block${className ? ` ${className}` : ''}`}
      title={title}
      style={{
        backgroundColor: `${color}20`,
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

interface ScoreChipProps {
  score: number;
  direction?: ScoreDirection;
  title?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function ScoreChip({ score, direction, title, className, style, children }: ScoreChipProps) {
  const color = scoreColor(score, direction);
  return (
    <ColoredChip color={color} title={title} className={className} style={style}>
      {children ?? score.toFixed(2)}
    </ColoredChip>
  );
}
