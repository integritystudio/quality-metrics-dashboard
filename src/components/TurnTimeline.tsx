import type { CSSProperties } from 'react';
import { scoreColor, agentColor } from '../lib/quality-utils.js';
import { BarIndicator } from './BarIndicator.js';
import { EmptyState } from './EmptyState.js';
import type { TurnLevelResult } from '../types.js';

interface TurnTimelineProps {
  turns: TurnLevelResult[];
  agentNames: string[];
}

export function TurnTimeline({ turns, agentNames }: TurnTimelineProps) {
  if (turns.length === 0) {
    return <EmptyState message="No turns to display." />;
  }

  const colorByAgent = new Map<string, string>();
  for (const name of agentNames) colorByAgent.set(name, agentColor(name, agentNames));

  return (
    <div className="d-flex gap-2 overflow-x-auto py-2">
      {turns.map((turn) => {
        const agent = turn.agentName ?? 'unknown';
        const color = colorByAgent.get(agent) ?? agentColor(agent, agentNames);
        const bandColor = scoreColor(turn.relevance);

        return (
          <div
            key={turn.turnIndex}
            className="p-4 shrink-0 turn-card"
            style={{ '--turn-color': color } as CSSProperties}
          >
            <div className="flex-center mb-1-5 justify-between">
              <span className="text-2xs uppercase font-semibold turn-card-agent">{agent}</span>
              <span className="text-muted text-2xs">#{turn.turnIndex}</span>
            </div>

            <div className="mb-1-5">
              <div className="text-secondary text-2xs mb-1">Relevance</div>
              <BarIndicator value={turn.relevance * 100} height={6} color={bandColor} />
            </div>

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
