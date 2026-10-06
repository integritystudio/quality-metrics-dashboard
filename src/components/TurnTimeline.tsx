import { useEffect, useRef, type CSSProperties } from 'react';
import { scoreColor, agentColor } from '../lib/quality-utils.js';
import { BarIndicator } from './BarIndicator.js';
import { EmptyState } from './EmptyState.js';
import type { TurnLevelResult } from '../types.js';

const UNKNOWN_AGENT = 'unknown';
// The timeline scrolls sideways: bring the first focused turn to the row's start without jumping the page.
const FOCUS_SCROLL_OPTIONS: ScrollIntoViewOptions = { block: 'nearest', inline: 'start' };

interface TurnTimelineProps {
  turns: TurnLevelResult[];
  agentNames: string[];
  /** Highlights this agent's turns and scrolls the first one into view. */
  focusedAgent?: string;
}

export function TurnTimeline({ turns, agentNames, focusedAgent }: TurnTimelineProps) {
  const firstFocusedRef = useRef<HTMLDivElement>(null);
  const firstFocusedIndex = focusedAgent === undefined
    ? -1
    : turns.findIndex(turn => (turn.agentName ?? UNKNOWN_AGENT) === focusedAgent);

  useEffect(() => {
    firstFocusedRef.current?.scrollIntoView(FOCUS_SCROLL_OPTIONS);
  }, [focusedAgent, firstFocusedIndex]);

  if (turns.length === 0) {
    return <EmptyState message="No turns to display." />;
  }

  const colorByAgent = new Map<string, string>();
  for (const name of agentNames) colorByAgent.set(name, agentColor(name, agentNames));

  return (
    <div className="d-flex gap-2 overflow-x-auto py-2">
      {turns.map((turn, index) => {
        const agent = turn.agentName ?? UNKNOWN_AGENT;
        const color = colorByAgent.get(agent) ?? agentColor(agent, agentNames);
        const bandColor = scoreColor(turn.relevance);
        const focused = agent === focusedAgent;

        return (
          <div
            key={turn.turnIndex}
            ref={index === firstFocusedIndex ? firstFocusedRef : undefined}
            aria-current={focused || undefined}
            className={focused ? 'p-4 shrink-0 turn-card turn-card--focused' : 'p-4 shrink-0 turn-card'}
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
