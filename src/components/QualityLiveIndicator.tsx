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
      className="quality-live-bar flex-center"
      role="status"
      aria-label="Live quality signals"
      style={{
        gap: 8,
        flexWrap: 'wrap',
        padding: '6px 12px',
        fontSize: 12,
        borderRadius: 6,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
      }}
    >
      <span className="text-secondary" style={{ fontWeight: 600, marginRight: 4 }}>
        Quality
      </span>
      {data.metrics.map((m) => (
        <span
          key={m.name}
          title={`${m.name}: ${m.score.toFixed(2)} (${m.evaluatorType})`}
          className="mono text-xs chip"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
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
          <span style={{ fontWeight: 700 }}>{m.score.toFixed(2)}</span>
        </span>
      ))}
      <span className="text-secondary" style={{ fontSize: 'var(--font-size-2xs)', marginLeft: 'auto' }}>
        {formatTimestamp(data.lastUpdated)}
      </span>
    </div>
  );
}
