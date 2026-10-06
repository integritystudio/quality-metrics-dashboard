/**
 * The session page derives its hallucination indicators, failed-evaluation list
 * and evaluation table from the evaluations the API read. When that read was cut
 * off at its cap the page must say so in text, and must stay quiet otherwise
 * (DASHBOARD-SESSION-EVALS-CAP-SILENT).
 *
 * Runs the real `useSessionDetail` → `useApiQuery` → `apiFetch` stack against a
 * stubbed `fetch`, so what the page reads is the wire shape of
 * `GET /api/sessions/:sessionId`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionDetailPage } from '../pages/SessionDetailPage.js';
import type { SessionDetailResponse } from '../hooks/useSessionDetail.js';
import type { JsonSafe } from '../api/api-constants.js';
import { EVAL_NANOS, makeEvaluation } from './support/fixtures.js';
import { makeEvaluation as makeMultiAgentEvaluation } from './workflow-fixtures.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper, stubFetch } from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN),
  }),
}));

const SESSION_ID = 'sess-long';
/** Evaluations in the served payload; the notice quotes how many rows the page has. */
const READ_EVALUATION_COUNT = 2;
/**
 * What `dataSources.evaluations.count` claims. Deliberately not the row count,
 * so a notice that quoted the claim instead of the rows would read wrong.
 */
const REPORTED_EVALUATION_COUNT = READ_EVALUATION_COUNT + 1;
const NOTICE_TITLE = 'Partial evaluation data';
/** Rendered only once the session payload has loaded. */
const LOADED_PAGE_HEADING = 'Session Detail';

/**
 * A session payload as it arrives over JSON. `truncated` undefined leaves the
 * flag out altogether, which is what a `session:` key served from KV looks like.
 */
function makeSessionDetail(truncated: boolean | undefined): JsonSafe<SessionDetailResponse> {
  const evaluations = Array.from({ length: READ_EVALUATION_COUNT }, () => ({
    ...makeEvaluation({ sessionId: SESSION_ID }),
    timestamp: String(EVAL_NANOS),
  }));
  return {
    sessionId: SESSION_ID,
    dataSources: {
      traces: { count: 0, traceIds: 0 },
      logs: { count: 0 },
      evaluations: { count: REPORTED_EVALUATION_COUNT, ...(truncated !== undefined && { truncated }) },
      total: REPORTED_EVALUATION_COUNT,
    },
    timespan: null,
    sessionInfo: null,
    tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, messages: 0, models: {} },
    tokenProgression: [],
    toolUsage: {},
    mcpUsage: {},
    spanBreakdown: {},
    hookLatency: {},
    errors: { byCategory: {}, details: [] },
    agentActivity: [],
    fileAccess: [],
    gitCommits: [],
    alertSummary: { totalFired: 0, stopEvents: 0 },
    codeStructure: [],
    evaluationBreakdown: [],
    logSummary: { bySeverity: {}, logs: [] },
    multiAgentEvaluation: makeMultiAgentEvaluation(),
    evaluations,
  };
}

function renderSessionPage() {
  return render(<SessionDetailPage sessionId={SESSION_ID} />, { wrapper: makeQueryWrapper().wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SessionDetailPage partial evaluation notice', () => {
  it('says in text that the evaluations are a partial read when the API flags them truncated', async () => {
    stubFetch(makeSessionDetail(true));

    renderSessionPage();

    expect(await screen.findByText(NOTICE_TITLE)).toBeTruthy();
    expect(screen.getByText(new RegExp(`more evaluations than the ${READ_EVALUATION_COUNT} read for this page`))).toBeTruthy();
  });

  it.each([
    ['is false', false],
    ['is absent, as on a payload served from KV', undefined],
  ])('shows no notice when the flag %s', async (_case, truncated) => {
    stubFetch(makeSessionDetail(truncated));

    renderSessionPage();

    expect(await screen.findByText(LOADED_PAGE_HEADING)).toBeTruthy();
    expect(screen.queryByText(NOTICE_TITLE)).toBeNull();
  });
});
