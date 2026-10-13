import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import type { AgentWindowStats, CodeQualityResponse } from '../api/routes/code-quality.js';
import { AgentCodeQualityPage } from '../pages/AgentCodeQualityPage.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import { renderPage } from './support/page-harness.js';

/**
 * AgentCodeQualityPage splits survival rows by cohort (CSV2) and content kind
 * (CSV3a): scored code is D7's input, baseline agents are the comparison
 * group, docs are reported but never scored. It also must not render blank
 * while only 3d/7d checkpoints exist.
 *
 * Rendered against the real query stack (`useCodeQuality` → `useApiQuery` →
 * `apiFetch`), the real `PageShell` and a memory router; only `useAuth` and
 * `fetch` are substituted.
 */

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const PAGE_PATH = '/code-quality';
const CODE_QUALITY_URL = '/api/code-quality';
const PAGE_HEADING = 'Agent Code Quality';
const SCORED_TITLE = /Survival by Agent/;
const BASELINE_TITLE = /Baseline Agents/;
const DOC_TITLE = /Documentation/;

function row(overrides: Partial<AgentWindowStats>): AgentWindowStats {
  return {
    agentName: 'agent-auditor', agentVersion: '2026-09-24', window: '21d',
    cohort: 'scored', contentKind: 'code',
    avgSurvivalRate: 0.9, avgChurnRate: 0.1, avgDeletionRate: 0,
    checkpointCount: 1, latestTimestamp: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

/** Serve `rows` from the API, render the page and wait for it to leave the loading state. */
async function renderWith(rows: AgentWindowStats[]) {
  const body: CodeQualityResponse = { survivalByAgentWindow: rows, versionRollout: [], hasData: rows.length > 0 };
  const fetchSpy = stubFetch(body);
  renderPage(<AgentCodeQualityPage />, PAGE_PATH);
  await screen.findByRole('heading', { name: PAGE_HEADING });
  return fetchSpy;
}

function tableUnder(title: RegExp): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('.card') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentCodeQualityPage', () => {
  it('requests the code-quality aggregate with the bearer token', async () => {
    const fetchSpy = await renderWith([row({})]);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(CODE_QUALITY_URL);
    expect(headersOf(init).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  }, TEST_TIMEOUT_MS);

  it('puts scored code, baseline code and docs in separate tables', async () => {
    await renderWith([
      row({}),
      row({ agentName: 'general-purpose', cohort: 'baseline' }),
      row({ agentName: 'documentation-architect', contentKind: 'doc', avgSurvivalRate: 0 }),
    ]);

    expect(within(tableUnder(SCORED_TITLE)).getByText('agent-auditor')).toBeTruthy();
    expect(within(tableUnder(BASELINE_TITLE)).getByText('general-purpose')).toBeTruthy();
    expect(within(tableUnder(DOC_TITLE)).getByText('documentation-architect')).toBeTruthy();
    expect(within(tableUnder(SCORED_TITLE)).queryByText('general-purpose')).toBeNull();
  });

  it('badges baseline rows and flags low survival only in the scored table', async () => {
    await renderWith([
      row({ agentName: 'general-purpose', cohort: 'baseline', avgSurvivalRate: 0.1 }),
      row({ agentName: 'documentation-architect', contentKind: 'doc', avgSurvivalRate: 0 }),
    ]);

    expect(within(tableUnder(BASELINE_TITLE)).getByLabelText('Baseline cohort: not scored')).toBeTruthy();
    expect(screen.queryByLabelText('Below survival threshold')).toBeNull();
  });

  it('shows progress instead of a blank page while only early windows exist', async () => {
    await renderWith([row({ window: '3d', agentName: 'documentation-architect', contentKind: 'doc' })]);

    expect(screen.getByText(/1 earlier-window \(3d \/ 7d\) checkpoint so far/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: SCORED_TITLE })).toBeNull();
  });
});
