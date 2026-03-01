import { useQualityLive } from '../hooks/useQualityLive.js';
import { formatTimestamp } from '../lib/quality-utils.js';
import { SCORE_THRESHOLD_GREEN, SCORE_THRESHOLD_YELLOW } from '../lib/constants.js';

function scoreToBadgeColor(score: number): string {
  if (score >= SCORE_THRESHOLD_GREEN) return 'var(--status-healthy)';
  if (score >= SCORE_THRESHOLD_YELLOW) return 'var(--status-warning)';
  return 'var(--status-critical)';
}

export function QualityLiveIndicator() {
  const { data, isLoading, error } = useQualityLive();

  if (isLoading) {
    return <div className="quality-live-bar" style={{ opacity: 0.5 }}>Loading quality signals...</div>;
  }

  if (error || !data) {
    return null;
  }

  if (data.metrics.length === 0) {
    return null;
  }

  return (
    <div
      className="quality-live-bar flex-center gap-2 text-xs"
      role="status"
      aria-label="Live quality signals"
      style={{
        flexWrap: 'wrap',
        padding: '6px 12px',
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
      }}
    >
      <span className="text-secondary font-semibold" style={{ marginRight: 4 }}>
        Quality
      </span>
      {data.metrics.map((m) => (
        <span
          key={m.name}
          title={`${m.name}: ${m.score.toFixed(2)} (${m.evaluatorType})`}
          className="mono text-xs chip gap-1"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: scoreToBadgeColor(m.score) + '1a',
            color: scoreToBadgeColor(m.score),
            fontWeight: 500,
          }}
        >
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: scoreToBadgeColor(m.score),
          }} />
          {m.name.replace(/_/g, ' ')}
          <span className="font-bold">{m.score.toFixed(2)}</span>
        </span>
      ))}
      <span className="text-secondary" style={{ fontSize: 'var(--font-size-2xs)', marginLeft: 'auto' }}>
        {formatTimestamp(data.lastUpdated)}
      </span>
    </div>
  );
}
