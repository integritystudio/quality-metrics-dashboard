import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { AGENT_PALETTE } from '../lib/constants.js';
import { BarIndicator } from './BarIndicator.js';
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
    return <div className="text-muted" style={{ padding: 16 }}>No turns to display.</div>;
  }

  return (
    <div className="gap-2" style={{ display: 'flex', overflowX: 'auto', padding: '8px 0' }}>
      {turns.map((turn) => {
        const agent = turn.agentName ?? 'unknown';
        const color = agentColor(agent, agentNames);
        const band = scoreColorBand(turn.relevance);
        const bandColor = SCORE_COLORS[band];

        return (
          <div
            key={turn.turnIndex}
            style={{
              minWidth: 120,
              padding: 12,
              borderRadius: 8,
              border: `2px solid ${color}`,
              background: 'var(--bg-elevated)',
              flexShrink: 0,
            }}
          >
            <div className="flex-center mb-1-5 justify-between">
              <span className="text-2xs uppercase font-semibold" style={{ color }}>{agent}</span>
              <span className="text-muted text-2xs">#{turn.turnIndex}</span>
            </div>

            {/* Relevance bar */}
            <div className="mb-1-5">
              <div className="text-secondary text-2xs" style={{ marginBottom: 2 }}>Relevance</div>
              <BarIndicator value={turn.relevance * 100} height={6} color={bandColor} />
            </div>

            {/* Task progress bar */}
            <div className="mb-1-5">
              <div className="text-secondary text-2xs" style={{ marginBottom: 2 }}>Progress</div>
              <BarIndicator value={turn.taskProgress * 100} height={6} color="var(--status-healthy)" />
            </div>

            {turn.hasError && (
              <div className="text-2xs font-semibold" style={{ color: 'var(--status-critical)', marginTop: 4 }}>
                Error
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
