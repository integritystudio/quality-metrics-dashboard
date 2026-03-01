import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { AGENT_PALETTE } from '../lib/constants.js';
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
    return <div style={{ padding: 16, color: 'var(--text-muted)' }}>No turns to display.</div>;
  }

  return (
    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '8px 0' }}>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase' }}>{agent}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>#{turn.turnIndex}</span>
            </div>

            {/* Relevance bar */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>Relevance</div>
              <div className="mini-bar" style={{ '--bar-h': '6px' } as React.CSSProperties}>
                <div className="mini-bar-fill" style={{ width: `${turn.relevance * 100}%`, background: bandColor }} />
              </div>
            </div>

            {/* Task progress bar */}
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 2 }}>Progress</div>
              <div className="mini-bar" style={{ '--bar-h': '6px' } as React.CSSProperties}>
                <div className="mini-bar-fill" style={{ width: `${turn.taskProgress * 100}%`, background: 'var(--status-healthy)' }} />
              </div>
            </div>

            {turn.hasError && (
              <div style={{ fontSize: 10, color: 'var(--status-critical)', fontWeight: 600, marginTop: 4 }}>
                Error
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
