import type { CSSProperties } from 'react';
import { useQualityLive } from '../hooks/useQualityLive.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import { SCORE_THRESHOLD_GREEN, SCORE_THRESHOLD_YELLOW, SCORE_CHIP_PRECISION } from '../lib/constants.js';

function scoreToBadgeColor(score: number): string {
  if (score >= SCORE_THRESHOLD_GREEN) return 'var(--status-healthy)';
  if (score >= SCORE_THRESHOLD_YELLOW) return 'var(--status-warning)';
  return 'var(--status-critical)';
}

export function QualityLiveIndicator() {
  const { data, isLoading, error } = useQualityLive();

  if (isLoading) {
    return <div className="quality-live-bar opacity-50">Loading quality signals...</div>;
  }

  if (error || !data) {
    return null;
  }

  if (data.metrics.length === 0) {
    return null;
  }

  return (
    <div
      className="quality-live-bar flex-center gap-2 text-xs surface-elevated"
      role="status"
      aria-label="Live quality signals"
    >
      <span className="text-secondary font-semibold mr-1">
        Quality
      </span>
      {data.metrics.map((m) => (
        <span
          key={m.name}
          title={`${m.name}: ${m.score.toFixed(SCORE_CHIP_PRECISION)} (${m.evaluatorType})`}
          className="mono text-xs chip gap-1 font-medium inline-flex-center quality-chip"
          style={{ '--chip-color': scoreToBadgeColor(m.score) } as CSSProperties}
        >
          <span className="dot-xs" />
          {m.name.replace(/_/g, ' ')}
          <span className="font-bold">{m.score.toFixed(SCORE_CHIP_PRECISION)}</span>
        </span>
      ))}
      <span className="text-secondary text-2xs ml-auto">
        {formatTimestamp(data.lastUpdated)}
      </span>
    </div>
  );
}
