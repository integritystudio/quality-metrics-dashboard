import type { CSSProperties, ReactNode } from 'react';
import { scoreColor, type ScoreDirection } from '../lib/quality-utils.js';
import { ColoredChip } from './ColoredChip.js';

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
