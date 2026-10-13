/**
 * AgentSessionPage against the real `useAgentSession` → `useApiQuery` → `apiFetch`
 * stack, the real header, page shell and turn timeline, and a memory router carrying
 * the `?agent=` search param. `useAuth` and `fetch` are the substituted boundaries.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import { renderPage } from './support/page-harness.js';
import type { AgentDetailResponse } from './support/api-responses.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

import { AgentSessionPage } from '../pages/AgentSessionPage.js';
import { routes } from '../lib/routes.js';
import { makeGraph, makeEvaluation, makeTurn } from './workflow-fixtures.js';
import { defined } from './support/defined.js';

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
  vi.unstubAllGlobals();
});

const SESSION_RESPONSE: AgentDetailResponse = {
  sessionId: SESSION_ID,
  spans: [],
  evaluation: makeEvaluation({ turns: TURNS, totalTurns: TURNS.length }),
  evaluations: [],
  agentMap: {},
  graph: makeGraph(),
};

/** Mount the page at `path` once the session has loaded. */
async function renderAt(path: string) {
  const fetchSpy = stubFetch(SESSION_RESPONSE);
  const view = renderPage(<AgentSessionPage sessionId={SESSION_ID} />, path);
  await screen.findByRole('heading', { name: 'Agent Session' });
  return { ...view, fetchSpy };
}

function focusedTurnNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-focused]')]
    .map(card => within(card as HTMLElement).getByText(/^#\d+$/).textContent);
}

describe('AgentSessionPage', () => {
  it('fetches the session endpoint with the bearer token', async () => {
    const { fetchSpy } = await renderAt(routes.agentSession(SESSION_ID));
    const [url, init] = defined(fetchSpy.mock.calls[0]);
    expect(url).toBe(`/api/agents/${SESSION_ID}`);
    expect(headersOf(init)['Authorization']).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('links "View Workflow" to /workflows/{sessionId}', async () => {
    await renderAt(routes.agentSession(SESSION_ID));
    expect(screen.getByRole('link', { name: /view workflow/i }))
      .toHaveAttribute('href', `/workflows/${SESSION_ID}`);
  });

  describe('opened from a workflow graph node (?agent=)', () => {
    it("highlights that agent's turns and no others", async () => {
      const { container } = await renderAt(routes.agentSession(SESSION_ID, FOCUSED_AGENT));
      expect(focusedTurnNumbers(container)).toEqual(['#1', '#3']);
    });

    it("scrolls that agent's first turn into view", async () => {
      await renderAt(routes.agentSession(SESSION_ID, FOCUSED_AGENT));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toHaveTextContent('#1');
    });
  });

  describe('opened without ?agent=', () => {
    it('highlights no turn and does not scroll', async () => {
      const { container } = await renderAt(routes.agentSession(SESSION_ID));
      expect(focusedTurnNumbers(container)).toEqual([]);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});
