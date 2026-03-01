import { memo } from 'react';
import type { PipelineStage, PipelineDropoff } from '../types.js';

interface PipelineFunnelProps {
  stages: PipelineStage[];
  dropoffs: PipelineDropoff[];
  overallConversionPercent: number;
}

function PipelineFunnelInner({ stages, dropoffs, overallConversionPercent }: PipelineFunnelProps) {
  if (stages.length === 0) return <p>No pipeline data available.</p>;

  const maxCount = Math.max(...stages.map(s => s.entryCount), 1);

  return (
    <div role="region" aria-label="Evaluation pipeline funnel">
      <div className="flex-center mb-3 gap-2">
        <span className="mono-xl font-semibold">
          {overallConversionPercent.toFixed(1)}%
        </span>
        <span className="text-secondary text-base">overall conversion</span>
      </div>

      <div className="gap-1" style={{ display: 'flex', flexDirection: 'column' }}>
        {stages.map((stage, idx) => {
          const widthPct = Math.max(2, (stage.entryCount / maxCount) * 100);
          const dropoff = dropoffs[idx];
          const showDropoff = dropoff && dropoff.dropped > 0;

          return (
            <div key={stage.name}>
              {/* Stage bar */}
              <div className="flex-center gap-3">
                <div
                  style={{
                    width: `${widthPct}%`,
                    minWidth: 40,
                    height: 32,
                    background: `var(--stage-${stage.name}, var(--accent))`,
                    borderRadius: 4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 10px',
                    transition: 'width 0.3s ease',
                  }}
                  role="meter"
                  aria-label={`${stage.displayName}: ${stage.entryCount} evaluations`}
                  aria-valuenow={stage.entryCount}
                  aria-valuemin={0}
                  aria-valuemax={maxCount}
                >
                  <span className="text-xs font-semibold" style={{ color: '#fff', whiteSpace: 'nowrap' }}>
                    {stage.displayName}
                  </span>
                  <span className="mono-xs" style={{ color: '#fff', whiteSpace: 'nowrap' }}>
                    {stage.entryCount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Drop-off indicator */}
              {showDropoff && (
                <div style={{
                  fontSize: 12,
                  color: dropoff.dropoffPercent > 20 ? 'var(--status-warning)' : 'var(--text-secondary)',
                  paddingLeft: 10,
                  margin: '2px 0',
                }}>
                  {'\u2193'} -{dropoff.dropped.toLocaleString()} ({dropoff.dropoffPercent.toFixed(1)}% drop)
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Screen reader summary table */}
      <table className="sr-only" aria-label="Pipeline stage details">
        <thead>
          <tr><th>Stage</th><th>Entry</th><th>Exit</th><th>Drop-off</th></tr>
        </thead>
        <tbody>
          {stages.map((stage, idx) => (
            <tr key={stage.name}>
              <td>{stage.displayName}</td>
              <td>{stage.entryCount}</td>
              <td>{stage.exitCount}</td>
              <td>{dropoffs[idx] != null ? `${dropoffs[idx].dropoffPercent.toFixed(1)}%` : '\u2014'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const PipelineFunnel = memo(PipelineFunnelInner);
