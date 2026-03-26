import React from 'react';
import { scoreColor, agentColor } from '../lib/quality-utils.js';
import { EmptyState } from './EmptyState.js';
import type { TurnLevelResult, HandoffEvaluation } from '../types.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';

const LANE_HEIGHT = 64;
const LANE_PADDING_TOP = 12;
const TURN_BLOCK_HEIGHT = 32;
const TURN_BLOCK_MIN_WIDTH = 40;
const TURN_BLOCK_GAP = 6;
const TURN_BLOCK_STRIDE = TURN_BLOCK_MIN_WIDTH + TURN_BLOCK_GAP;
const LANE_CENTER_OFFSET = LANE_PADDING_TOP + TURN_BLOCK_HEIGHT / 2;
const LABEL_WIDTH = 120;
const HANDOFF_MARKER_RADIUS = 7;
const HEADER_HEIGHT = 28;
/**
 * CR-PERF-1: Maximum turns rendered in the SVG viewport.
 * Sessions with 10K+ turns would produce 400KB+ SVG without a cap.
 * Excess turns are hidden with a truncation notice below the timeline.
 */
const MAX_VISIBLE_TURNS = 200;

interface LaneSegment {
  agentName: string;
  turns: TurnLevelResult[];
  /** Index of the lane (display order). */
  laneIndex: number;
}

function buildLanes(
  turns: TurnLevelResult[],
  agentNames: string[],
): LaneSegment[] {
  return agentNames.map((name, laneIndex) => ({
    agentName: name,
    turns: turns.filter(t => (t.agentName ?? 'unknown') === name),
    laneIndex,
  }));
}

/** Return the 1-based display index of a handoff in the flat turn list. */
function findHandoffTurnIndex(
  handoff: HandoffEvaluation,
  turns: TurnLevelResult[],
): number | null {
  let sawSource = false;
  for (const t of turns) {
    const agent = t.agentName ?? 'unknown';
    if (agent === handoff.sourceAgent) sawSource = true;
    if (sawSource && agent === handoff.targetAgent) return t.turnIndex;
  }
  return null;
}

interface TurnBlockProps {
  turn: TurnLevelResult;
  color: string;
  width: number;
  x: number;
  y: number;
}

function TurnBlock({ turn, color, width, x, y }: TurnBlockProps) {
  const barColor = scoreColor(turn.relevance);
  const label = `Turn ${turn.turnIndex}: relevance ${turn.relevance.toFixed(SCORE_CHIP_PRECISION)}, progress ${(turn.taskProgress * 100).toFixed(0)}%${turn.hasError ? ', error' : ''}`;
  return (
    <g transform={`translate(${x},${y})`} role="img" aria-label={label}>
      <rect
        width={width}
        height={TURN_BLOCK_HEIGHT}
        rx={4}
        fill={color}
        fillOpacity={0.15}
        stroke={color}
        strokeWidth={1.5}
      />
      <rect
        width={Math.max(2, width * turn.relevance)}
        height={4}
        rx={2}
        fill={barColor}
        fillOpacity={0.85}
      />
      {turn.hasError && (
        <rect
          x={width - 6}
          width={4}
          height={TURN_BLOCK_HEIGHT}
          rx={2}
          fill="var(--status-critical)"
          fillOpacity={0.85}
        />
      )}
      <text
        x={width / 2}
        y={TURN_BLOCK_HEIGHT / 2 + 5}
        textAnchor="middle"
        fontSize={10}
        fill={color}
        fontFamily="var(--font-mono)"
      >
        {turn.turnIndex}
      </text>
    </g>
  );
}

export interface WorkflowTimelineProps {
  turns: TurnLevelResult[];
  handoffs?: HandoffEvaluation[];
  agentNames: string[];
}

export function WorkflowTimeline({ turns, handoffs = [], agentNames }: WorkflowTimelineProps) {
  if (turns.length === 0) {
    return <EmptyState message="No turns to display." />;
  }

  // CR-PERF-1: cap rendered turns to avoid unbounded SVG on high-turn sessions
  const visibleTurns = turns.length > MAX_VISIBLE_TURNS ? turns.slice(0, MAX_VISIBLE_TURNS) : turns;
  const truncated = turns.length > MAX_VISIBLE_TURNS;

  const lanes = buildLanes(visibleTurns, agentNames);
  const totalTurns = visibleTurns.length;
  const agentLaneIndex = new Map(agentNames.map((name, i) => [name, i]));
  const agentColorMap = new Map(agentNames.map(name => [name, agentColor(name, agentNames)]));

  const availableWidth = totalTurns * TURN_BLOCK_STRIDE;
  const svgWidth = LABEL_WIDTH + availableWidth + TURN_BLOCK_GAP;
  const svgHeight = HEADER_HEIGHT + lanes.length * LANE_HEIGHT;

  const turnX = (turnIndex: number): number =>
    LABEL_WIDTH + turnIndex * TURN_BLOCK_STRIDE + TURN_BLOCK_GAP;

  const laneY = (laneIndex: number): number =>
    HEADER_HEIGHT + laneIndex * LANE_HEIGHT + LANE_CENTER_OFFSET;

  return (
    <div
      className="overflow-x-auto"
      role="img"
      aria-label={`Workflow timeline: ${agentNames.length} agents, ${totalTurns} turns`}
    >
      <svg
        width={svgWidth}
        height={svgHeight}
        className="d-block timeline-svg"
        style={{ '--timeline-min-width': `${svgWidth}px` } as React.CSSProperties}
      >
        <g>
          {turns.map(t => (
            <text
              key={t.turnIndex}
              x={turnX(t.turnIndex) + TURN_BLOCK_MIN_WIDTH / 2}
              y={HEADER_HEIGHT - 8}
              textAnchor="middle"
              fontSize={9}
              fill="var(--text-muted)"
              fontFamily="var(--font-mono)"
            >
              {t.turnIndex}
            </text>
          ))}
        </g>

        {lanes.map(({ agentName, turns: laneTurns, laneIndex }) => {
          const color = agentColorMap.get(agentName) ?? agentColor(agentName, agentNames);
          const laneTop = HEADER_HEIGHT + laneIndex * LANE_HEIGHT;

          return (
            <g key={agentName}>
              <rect
                x={0}
                y={laneTop}
                width={svgWidth}
                height={LANE_HEIGHT}
                fill={laneIndex % 2 === 0 ? 'var(--bg-elevated)' : 'var(--bg-card)'}
                fillOpacity={0.5}
              />

              <line
                x1={0}
                y1={laneTop}
                x2={svgWidth}
                y2={laneTop}
                stroke="var(--border-subtle)"
                strokeWidth={1}
              />

              <text
                x={LABEL_WIDTH - 8}
                y={laneTop + LANE_CENTER_OFFSET + 4}
                textAnchor="end"
                fontSize={11}
                fontWeight={600}
                fill={color}
                fontFamily="var(--font-mono)"
              >
                {agentName.length > 12 ? `${agentName.slice(0, 10)}\u2026` : agentName}
              </text>

              {laneTurns.map(turn => (
                <TurnBlock
                  key={turn.turnIndex}
                  turn={turn}
                  color={color}
                  width={TURN_BLOCK_MIN_WIDTH}
                  x={turnX(turn.turnIndex)}
                  y={laneTop + LANE_PADDING_TOP}
                />
              ))}
            </g>
          );
        })}

        <line
          x1={0}
          y1={svgHeight}
          x2={svgWidth}
          y2={svgHeight}
          stroke="var(--border-subtle)"
          strokeWidth={1}
        />

        {/* Handoff markers — drawn on top of lanes */}
        {handoffs.map((h, i) => {
          const turnIndex = findHandoffTurnIndex(h, turns);
          if (turnIndex == null) return null;

          const sourceLaneIdx = agentLaneIndex.get(h.sourceAgent) ?? -1;
          const targetLaneIdx = agentLaneIndex.get(h.targetAgent) ?? -1;
          if (sourceLaneIdx < 0 || targetLaneIdx < 0) return null;

          const x = turnX(turnIndex) + TURN_BLOCK_MIN_WIDTH / 2;
          const y1 = laneY(sourceLaneIdx);
          const y2 = laneY(targetLaneIdx);
          const midY = (y1 + y2) / 2;

          const handoffColor = h.correctTarget
            ? 'var(--status-healthy)'
            : 'var(--status-warning)';

          return (
            <g
              key={`handoff-${i}`}
              role="img"
              aria-label={`Handoff from ${h.sourceAgent} to ${h.targetAgent}, score ${h.score.toFixed(SCORE_CHIP_PRECISION)}`}
            >
              <line
                x1={x}
                y1={y1}
                x2={x}
                y2={y2}
                stroke={handoffColor}
                strokeWidth={2}
                strokeDasharray="4 2"
                opacity={0.7}
              />
              <circle
                cx={x}
                cy={midY}
                r={HANDOFF_MARKER_RADIUS}
                fill="var(--bg-card)"
                stroke={handoffColor}
                strokeWidth={1.5}
              />
              <text
                x={x}
                y={midY + 4}
                textAnchor="middle"
                fontSize={8}
                fill={handoffColor}
                fontFamily="var(--font-mono)"
                fontWeight={600}
              >
                {h.score.toFixed(1)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="flex-wrap gap-4 mt-2 workflow-legend">
        <span className="text-2xs text-muted">Turn relevance bar at top of each block</span>
        {handoffs.length > 0 && (
          <span className="text-2xs text-muted">Dashed lines = handoffs with score</span>
        )}
        {truncated && (
          <span className="text-2xs text-warning">
            Showing first {MAX_VISIBLE_TURNS} of {turns.length} turns
          </span>
        )}
      </div>
    </div>
  );
}
