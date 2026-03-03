import { scoreColor } from '../lib/quality-utils.js';
import { AGENT_PALETTE, TURN_CARD_MIN_WIDTH } from '../lib/constants.js';
import { BarIndicator } from './BarIndicator.js';
import { EmptyState } from './EmptyState.js';
import type { TurnLevelResult } from '../types.js';

function agentColor(agentName: string, agentNames: string[]): string {
  const idx = agentNames.indexOf(agentName);
  return AGENT_PALETTE[idx % AGENT_PALETTE.length];
}

interface TurnTimelineProps {
  turns: TurnLevelResult[];
  agentNames: string[];
}

export function TurnTimeline({ turns, agentNames }: TurnTimelineProps) {
  if (turns.length === 0) {
    return <EmptyState message="No turns to display." />;
  }

  return (
    <div className="d-flex gap-2 overflow-x-auto" style={{ padding: 'var(--space-2) 0' }}>
      {turns.map((turn) => {
        const agent = turn.agentName ?? 'unknown';
        const color = agentColor(agent, agentNames);
        const bandColor = scoreColor(turn.relevance);

        return (
          <div
            key={turn.turnIndex}
            className="p-4 shrink-0"
            style={{
              minWidth: TURN_CARD_MIN_WIDTH,
              borderRadius: 'var(--radius-lg)',
              border: `var(--border-width-thick) solid ${color}`,
              background: 'var(--bg-elevated)',
            }}
          >
            <div className="flex-center mb-1-5 justify-between">
              <span className="text-2xs uppercase font-semibold" style={{ color }}>{agent}</span>
              <span className="text-muted text-2xs">#{turn.turnIndex}</span>
            </div>

            {/* Relevance bar */}
            <div className="mb-1-5">
              <div className="text-secondary text-2xs mb-1">Relevance</div>
              <BarIndicator value={turn.relevance * 100} height={6} color={bandColor} />
            </div>

            {/* Task progress bar */}
            <div className="mb-1-5">
              <div className="text-secondary text-2xs mb-1">Progress</div>
              <BarIndicator value={turn.taskProgress * 100} height={6} color="var(--status-healthy)" />
            </div>

            {turn.hasError && (
              <div className="text-2xs font-semibold text-critical mt-1">
                Error
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
