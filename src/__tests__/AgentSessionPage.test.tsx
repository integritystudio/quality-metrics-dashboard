import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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

// The data hook is the only mock: the header, page shell and wouter `Link` render for real.

const mockUseAgentSession = vi.fn<(sessionId: string) => AgentSessionQueryResult>();
vi.mock('../hooks/useAgentSession.js', () => ({
  useAgentSession: (sessionId: string) => mockUseAgentSession(sessionId),
}));

// Imports (after mocks)

import { AgentSessionPage } from '../pages/AgentSessionPage.js';
import { makeGraph, makeEvaluation } from './workflow-fixtures.js';
import type { AgentSessionResponse } from '../hooks/useAgentSession.js';

const SESSION_ID = 'session-xyz';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockLoaded() {
  mockUseAgentSession.mockReturnValue({
    data: {
      sessionId: SESSION_ID,
      spans: [],
      evaluation: makeEvaluation(),
      evaluations: [],
      agentMap: {},
      graph: makeGraph(),
    },
    isLoading: false,
    error: null,
  });
}

describe('AgentSessionPage', () => {
  it('links "View Workflow" to /workflows/{sessionId}', () => {
    mockLoaded();
    render(<AgentSessionPage sessionId={SESSION_ID} />);
    expect(screen.getByRole('link', { name: /view workflow/i }))
      .toHaveAttribute('href', `/workflows/${SESSION_ID}`);
  });
});
