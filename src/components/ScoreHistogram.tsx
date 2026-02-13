export function ScoreHistogram({ distribution }: { distribution: Array<{ bucket: string; count: number }> }) {
  if (distribution.length === 0) return null;

  const maxCount = Math.max(...distribution.map((d) => d.count), 1);

  return (
    <div>
      <div className="histogram">
        {distribution.map((d, i) => (
          <div
            key={i}
            className="histogram-bar"
            style={{ height: `${(d.count / maxCount) * 100}%` }}
            aria-label={`${d.bucket}: ${d.count} evaluations`}
          >
            <div className="tooltip">
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
