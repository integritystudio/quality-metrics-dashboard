import type { CSSProperties } from 'react';
import { max } from 'd3-array';

export function ScoreHistogram({ distribution }: { distribution: Array<{ bucket: string; count: number }> }) {
  if (distribution.length === 0) return null;

  const maxCount = max(distribution, d => d.count) ?? 1;

  return (
    <div>
      <div className="histogram">
        {distribution.map((d, i) => (
          <div
            key={i}
            className="histogram-bar"
            style={{ '--histogram-bar-height': `${(d.count / maxCount) * 100}%` } as CSSProperties}
            aria-label={`${d.bucket}: ${d.count} evaluations`}
          >
            <div className="tooltip surface-elevated">
              {d.bucket}: {d.count}
            </div>
          </div>
        ))}
      </div>
      <div className="histogram-labels">
        <span>{distribution[0]?.bucket}</span>
        <span>{distribution[distribution.length - 1]?.bucket}</span>
      </div>
    </div>
  );
}
