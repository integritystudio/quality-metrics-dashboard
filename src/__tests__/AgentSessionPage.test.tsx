import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

/**
 * Only the three fields AgentSessionPage destructures off the query result —
 * typed so the mock cannot hand the page a `data` shape the real
 * `useAgentSession` could never return.
 */
interface AgentSessionQueryResult {
  data: AgentSessionResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}

// The data hook is the only mock: the header, page shell, turn timeline and wouter render for real.

const mockUseAgentSession = vi.fn<(sessionId: string) => AgentSessionQueryResult>();
vi.mock('../hooks/useAgentSession.js', () => ({
  useAgentSession: (sessionId: string) => mockUseAgentSession(sessionId),
}));

// Imports (after mocks)

import { AgentSessionPage } from '../pages/AgentSessionPage.js';
import { routes } from '../lib/routes.js';
import { makeGraph, makeEvaluation, makeTurn } from './workflow-fixtures.js';
import type { AgentSessionResponse } from '../hooks/useAgentSession.js';

const SESSION_ID = 'session-xyz';
const FOCUSED_AGENT = 'executor';
const TURNS = [
  makeTurn({ turnIndex: 0, agentName: 'planner' }),
  makeTurn({ turnIndex: 1, agentName: FOCUSED_AGENT }),
  makeTurn({ turnIndex: 2, agentName: 'planner' }),
  makeTurn({ turnIndex: 3, agentName: FOCUSED_AGENT }),
];

// jsdom has no layout, so it does not implement scrollIntoView.
const scrollIntoView = vi.fn();
Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockLoaded() {
  mockUseAgentSession.mockReturnValue({
    data: {
      sessionId: SESSION_ID,
      spans: [],
      evaluation: makeEvaluation({ turns: TURNS, totalTurns: TURNS.length }),
      evaluations: [],
      agentMap: {},
      graph: makeGraph(),
    },
    isLoading: false,
    error: null,
  });
}

function renderAt(path: string) {
  const location = memoryLocation({ path });
  return render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <AgentSessionPage sessionId={SESSION_ID} />
    </Router>,
  );
}

function focusedTurnNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-focused]')]
    .map(card => within(card as HTMLElement).getByText(/^#\d+$/).textContent);
}

describe('AgentSessionPage', () => {
  it('links "View Workflow" to /workflows/{sessionId}', () => {
    mockLoaded();
    renderAt(routes.agentSession(SESSION_ID));
    expect(screen.getByRole('link', { name: /view workflow/i }))
      .toHaveAttribute('href', `/workflows/${SESSION_ID}`);
  });

  describe('opened from a workflow graph node (?agent=)', () => {
    it("highlights that agent's turns and no others", () => {
      mockLoaded();
      const { container } = renderAt(routes.agentSession(SESSION_ID, FOCUSED_AGENT));
      expect(focusedTurnNumbers(container)).toEqual(['#1', '#3']);
    });

    it("scrolls that agent's first turn into view", () => {
      mockLoaded();
      renderAt(routes.agentSession(SESSION_ID, FOCUSED_AGENT));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toHaveTextContent('#1');
    });
  });

  describe('opened without ?agent=', () => {
    it('highlights no turn and does not scroll', () => {
      mockLoaded();
      const { container } = renderAt(routes.agentSession(SESSION_ID));
      expect(focusedTurnNumbers(container)).toEqual([]);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});
