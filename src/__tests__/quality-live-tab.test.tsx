/**
 * Live Quality tab: the tab, the route and the page against the real query stack
 * (`useQualityLive` → `useApiQuery` → `apiFetch`, the real `PageShell` and a
 * memory router). Only `useAuth` and `fetch` are substituted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import type { QualityLiveData } from '../types.js';
import { QualityLivePage } from '../pages/QualityLivePage.js';
import { RoleSelector } from '../components/RoleSelector.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import {
  PAGE_SHELL_ERROR_HEADING, PAGE_SHELL_SKELETON_SELECTOR, SERVER_ERROR_BODY, SERVER_ERROR_STATUS, apiErrorMessage,
  renderPage, stubPendingFetch,
} from './support/page-harness.js';

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN),
    session: { allowedViews: [] },
  }),
}));

const HOME_PATH = '/';
const PAGE_PATH = '/quality-live';
const TAB_LABEL = 'Live Quality';
const PAGE_HEADING = 'Live Quality';
const EMPTY_HEADING = 'No Live Quality Data';
const LIVE_URL = '/api/quality/live';
const TIMESTAMP = '2026-01-15T12:00:00.000Z';

const LIVE_DATA: QualityLiveData = {
  metrics: [
    { name: 'coherence', score: 0.45, evaluatorType: 'llm', timestamp: TIMESTAMP },
    { name: 'relevance', score: 0.95, evaluatorType: 'llm', timestamp: TIMESTAMP },
  ],
  sessionCount: 3,
  lastUpdated: TIMESTAMP,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Live Quality tab navigation', () => {
  it('navigates to /quality-live when the tab is clicked', () => {
    const { location } = renderPage(<RoleSelector />, HOME_PATH);

    fireEvent.click(screen.getByRole('tab', { name: TAB_LABEL }));

    expect(location.history.at(-1)).toBe(PAGE_PATH);
    expect(screen.getByRole('tab', { name: TAB_LABEL })).toHaveAttribute('aria-selected', 'true');
  }, TEST_TIMEOUT_MS);
});

describe('QualityLivePage', () => {
  it('requests the live view with the bearer token', async () => {
    const fetchSpy = stubFetch(LIVE_DATA);

    renderPage(<QualityLivePage />, PAGE_PATH);

    await screen.findByRole('heading', { name: PAGE_HEADING });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(LIVE_URL);
    expect(headersOf(init).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  }, TEST_TIMEOUT_MS);

  it('renders a chip per metric and the session count', async () => {
    stubFetch(LIVE_DATA);

    renderPage(<QualityLivePage />, PAGE_PATH);

    expect(await screen.findByTitle('coherence: 0.45 (llm)')).toBeTruthy();
    expect(screen.getByTitle('relevance: 0.95 (llm)')).toBeTruthy();
    expect(screen.getByText(/across 3 sessions/)).toBeTruthy();
  });

  it('shows an empty state when no metric has a score', async () => {
    stubFetch({ ...LIVE_DATA, metrics: [], sessionCount: 0 });

    renderPage(<QualityLivePage />, PAGE_PATH);

    expect(await screen.findByRole('heading', { name: EMPTY_HEADING })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Live quality signals' })).toBeNull();
  });

  it('shows the loading skeleton while the query is in flight', () => {
    stubPendingFetch();

    const { container } = renderPage(<QualityLivePage />, PAGE_PATH);

    expect(container.querySelector(PAGE_SHELL_SKELETON_SELECTOR)).not.toBeNull();
  });

  it('surfaces the error message when the query fails', async () => {
    stubFetch(SERVER_ERROR_BODY, { status: SERVER_ERROR_STATUS });

    renderPage(<QualityLivePage />, PAGE_PATH);

    expect(await screen.findByRole('heading', { name: PAGE_SHELL_ERROR_HEADING })).toBeTruthy();
    expect(screen.getByText(apiErrorMessage(SERVER_ERROR_STATUS, SERVER_ERROR_BODY))).toBeTruthy();
  });
});
