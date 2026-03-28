import { memo, type CSSProperties } from 'react';
import { max } from 'd3-array';
import type { PipelineStage, PipelineDropoff } from '../types.js';
import { EmptyState } from './EmptyState.js';
import { formatPercent } from '../lib/quality-utils.js';
import { FUNNEL_DROPOFF_WARN_PCT } from '../lib/constants.js';

interface PipelineFunnelProps {
  stages: PipelineStage[];
  dropoffs: PipelineDropoff[];
  overallConversionPercent: number;
}

function PipelineFunnelInner({ stages, dropoffs, overallConversionPercent }: PipelineFunnelProps) {
  if (stages.length === 0) return <EmptyState message="No pipeline data available." />;

  const maxCount = max(stages, s => s.entryCount) ?? 1;

  return (
    <div role="region" aria-label="Evaluation pipeline funnel">
      <div className="flex-center mb-3 gap-2">
        <span className="mono-xl font-semibold">
          {formatPercent(overallConversionPercent)}
        </span>
        <span className="text-secondary text-base">overall conversion</span>
      </div>

      <div className="flex-col gap-1">
        {stages.map((stage, idx) => {
          const widthPct = Math.max(2, (stage.entryCount / maxCount) * 100);
          const dropoff = dropoffs[idx];
          const showDropoff = dropoff && dropoff.dropped > 0;

          return (
            <div key={stage.name}>
              <div className="flex-center gap-3">
                <div
                  className="d-flex funnel-bar"
                  style={{
                    '--funnel-width': `${widthPct}%`,
                    '--funnel-bg': `var(--stage-${stage.name}, var(--accent))`,
                  } as CSSProperties}
                  role="meter"
                  aria-label={`${stage.displayName}: ${stage.entryCount} evaluations`}
                  aria-valuenow={stage.entryCount}
                  aria-valuemin={0}
                  aria-valuemax={maxCount}
                >
                  <span className="text-xs font-semibold text-on-accent nowrap">
                    {stage.displayName}
                  </span>
                  <span className="mono-xs text-on-accent nowrap">
                    {stage.entryCount.toLocaleString()}
                  </span>
                </div>
              </div>

              {showDropoff && (
                <div
                  className="text-xs funnel-dropoff"
                  data-warn={dropoff.dropoffPercent > FUNNEL_DROPOFF_WARN_PCT || undefined}
                >
                  {'\u2193'} -{dropoff.dropped.toLocaleString()} ({formatPercent(dropoff.dropoffPercent)} drop)
                </div>
              )}
            </div>
          );
        })}
      </div>

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
              <td>{dropoffs[idx] != null ? formatPercent(dropoffs[idx].dropoffPercent) : '\u2014'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const PipelineFunnel = memo(PipelineFunnelInner);
