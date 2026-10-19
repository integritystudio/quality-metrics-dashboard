import { FreqBar } from './FreqBar.js';
import { byValueDesc } from '../lib/quality-utils.js';

type FreqBarGridProps = {
  entries: Array<[string, number]>;
  max: number;
  color?: string;
}

export function FreqBarGrid({ entries, max, color }: FreqBarGridProps) {
  return (
    <div className="freq-grid">
      {[...entries]
        .toSorted(byValueDesc)
        .map(([key, count]) => (
          <FreqBar key={key} label={key} count={count} max={max} color={color} />
        ))
      }
    </div>
  );
}
