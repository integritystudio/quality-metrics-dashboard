import { ScoreChip } from './ScoreChip.js';
import type { HandoffEvaluation } from '../types.js';

interface HandoffCardProps {
  handoff: HandoffEvaluation;
}

export function HandoffCard({ handoff }: HandoffCardProps) {
  return (
    <div className="flex-center gap-3 surface-elevated" style={{
      padding: '8px 12px',
      borderRadius: 'var(--radius-lg)',
    }}>
      <span className="mono-xs font-semibold">
        {handoff.sourceAgent}
      </span>
      <span className="text-muted text-base">&rarr;</span>
      <span className="mono-xs font-semibold">
        {handoff.targetAgent}
      </span>
      <ScoreChip score={handoff.score} />
      {handoff.correctTarget && (
        <span className="text-2xs text-healthy" title="Correct target">&#10003;</span>
      )}
      {handoff.contextPreserved && (
        <span className="text-2xs text-healthy" title="Context preserved">&#9679;</span>
      )}
    </div>
  );
}
