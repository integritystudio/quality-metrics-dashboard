import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { ColoredChip } from './ColoredChip.js';
import type { HandoffEvaluation } from '../types.js';

interface HandoffCardProps {
  handoff: HandoffEvaluation;
}

export function HandoffCard({ handoff }: HandoffCardProps) {
  const band = scoreColorBand(handoff.score);
  const color = SCORE_COLORS[band];

  return (
    <div className="flex-center gap-3" style={{
      padding: '8px 12px',
      borderRadius: 8,
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
    }}>
      <span className="mono-xs font-semibold">
        {handoff.sourceAgent}
      </span>
      <span className="text-muted text-base">&rarr;</span>
      <span className="mono-xs font-semibold">
        {handoff.targetAgent}
      </span>
      <ColoredChip color={color}>
        {handoff.score.toFixed(2)}
      </ColoredChip>
      {handoff.correctTarget && (
        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--status-healthy)' }} title="Correct target">&#10003;</span>
      )}
      {handoff.contextPreserved && (
        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--status-healthy)' }} title="Context preserved">&#9679;</span>
      )}
    </div>
  );
}
