/**
 * agentColorScale colors the agent lanes, chips and sparklines on the workflow and agent views.
 */
import { describe, expect, it } from 'vitest';
import { agentColorScale } from '../lib/quality-utils.js';
import { AGENT_PALETTE } from '../lib/constants.js';

const PALETTE_SIZE = AGENT_PALETTE.length;
const agentNames = Array.from({ length: PALETTE_SIZE + 1 }, (_, i) => `agent-${i}`);

describe('agentColorScale', () => {
  it('colors each agent by its position in the list', () => {
    const colorOf = agentColorScale(agentNames);

    expect(colorOf('agent-0')).toBe(AGENT_PALETTE[0]);
    expect(colorOf('agent-1')).toBe(AGENT_PALETTE[1]);
  });

  it('cycles the palette once the list outgrows it', () => {
    const colorOf = agentColorScale(agentNames);

    expect(colorOf(`agent-${PALETTE_SIZE}`)).toBe(AGENT_PALETTE[0]);
  });

  it('gives an unlisted agent the first color without shifting the listed ones', () => {
    const colorOf = agentColorScale(['agent-0', 'agent-1']);

    expect(colorOf('unlisted-a')).toBe(AGENT_PALETTE[0]);
    expect(colorOf('unlisted-b')).toBe(AGENT_PALETTE[0]);
    expect(colorOf('agent-1')).toBe(AGENT_PALETTE[1]);
  });
});
