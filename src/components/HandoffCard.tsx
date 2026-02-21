import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import type { HandoffEvaluation } from '../types.js';

interface HandoffCardProps {
  handoff: HandoffEvaluation;
}

export function HandoffCard({ handoff }: HandoffCardProps) {
  const band = scoreColorBand(handoff.score);
  const color = SCORE_COLORS[band];

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 12px',
      borderRadius: 8,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
    }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>
        {handoff.sourceAgent}
      </span>
      <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>&rarr;</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>
        {handoff.targetAgent}
      </span>
      <span style={{
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 10,
        backgroundColor: `${color}20`,
        color,
        fontFamily: 'var(--font-mono)',
      }}>
        {handoff.score.toFixed(2)}
      </span>
      {handoff.correctTarget && (
        <span style={{ fontSize: 10, color: 'var(--status-healthy)' }} title="Correct target">&#10003;</span>
      )}
      {handoff.contextPreserved && (
        <span style={{ fontSize: 10, color: 'var(--status-healthy)' }} title="Context preserved">&#9679;</span>
      )}
    </div>
  );
}
