import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import type { HandoffEvaluation } from '../types.js';

interface HandoffCardProps {
  handoff: HandoffEvaluation;
}

export function HandoffCard({ handoff }: HandoffCardProps) {
  const band = scoreColorBand(handoff.score);
  const color = SCORE_COLORS[band];

  return (
    <div className="flex-center" style={{
      gap: 12,
      padding: '8px 12px',
      borderRadius: 8,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
    }}>
      <span className="mono-xs" style={{ fontWeight: 600 }}>
        {handoff.sourceAgent}
      </span>
      <span className="text-muted text-base">&rarr;</span>
      <span className="mono-xs" style={{ fontWeight: 600 }}>
        {handoff.targetAgent}
      </span>
      <span className="mono-xs chip" style={{
        backgroundColor: `${color}20`,
        color,
      }}>
        {handoff.score.toFixed(2)}
      </span>
      {handoff.correctTarget && (
        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--status-healthy)' }} title="Correct target">&#10003;</span>
      )}
      {handoff.contextPreserved && (
        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--status-healthy)' }} title="Context preserved">&#9679;</span>
      )}
    </div>
  );
}
