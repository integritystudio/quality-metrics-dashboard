import type { CSSProperties, ReactNode } from 'react';
import { scoreColor, type ScoreDirection } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';

type ColoredChipProps = {
  color: string;
  title?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function ColoredChip({ color, title, className, children }: ColoredChipProps) {
  return (
    <span
      className={`mono-xs chip chip-colored d-inline-block${className ? ` ${className}` : ''}`}
      title={title}
      style={{ '--chip-color': color } as CSSProperties}
    >
      {children}
    </span>
  );
}

type ScoreChipProps = {
  score: number;
  direction?: ScoreDirection;
  title?: string;
  className?: string;
  children?: ReactNode;
}

export function ScoreChip({ score, direction, title, className, children }: ScoreChipProps) {
  const color = scoreColor(score, direction);
  return (
    <ColoredChip color={color} title={title} className={className}>
      {children ?? score.toFixed(SCORE_CHIP_PRECISION)}
    </ColoredChip>
  );
}
