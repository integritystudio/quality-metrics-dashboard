import { FreqBar } from './FreqBar.js';
import { byValueDesc } from '../lib/quality-utils.js';

interface FreqBarGridProps {
  entries: [string, number][];
  max: number;
  color?: string;
}

export function FreqBarGrid({ entries, max, color }: FreqBarGridProps) {
  return (
    <div className="freq-grid">
      {[...entries]
        .sort(byValueDesc)
        .map(([key, count]) => (
          <FreqBar key={key} label={key} count={count} max={max} color={color} />
        ))
      }
    </div>
  );
}
