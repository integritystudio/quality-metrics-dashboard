import type { CSSProperties, ReactNode } from 'react';
import { scoreColor, type ScoreDirection } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';

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
      className={`mono-xs chip chip-colored d-inline-block${className ? ` ${className}` : ''}`}
      title={title}
      style={{ '--chip-color': color, ...style } as CSSProperties}
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
      {children ?? score.toFixed(SCORE_CHIP_PRECISION)}
    </ColoredChip>
  );
}
