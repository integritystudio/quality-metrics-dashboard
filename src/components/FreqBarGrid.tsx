import { FreqBar } from './FreqBar.js';

interface FreqBarGridProps {
  entries: [string, number][];
  max: number;
  color?: string;
}

export function FreqBarGrid({ entries, max, color }: FreqBarGridProps) {
  return (
    <div className="freq-grid">
      {[...entries]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => (
          <FreqBar key={key} label={key} count={count} max={max} color={color} />
        ))
      }
    </div>
  );
}
