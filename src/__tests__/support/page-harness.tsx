/**
 * Mount a page the way the app does: real react-query (see query-harness), the real
 * `PageShell`, and a wouter memory router carrying path and search params. Pair with
 * the per-file `useAuth` mock and `stubFetch` described in query-harness.
 */

import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { ReactNode } from 'react';
import { makeQueryWrapper } from './query-harness.js';

/** The heading `PageShell` renders over a failed query's message. */
export const PAGE_SHELL_ERROR_HEADING = 'Failed to load';

/** The class of the skeleton `PageShell` renders while its query is loading. */
export const PAGE_SHELL_SKELETON_SELECTOR = '.page-skeleton';

/** The message `useApiQuery` throws for a non-2xx response carrying `body`. */
export function apiErrorMessage(status: number, body: unknown): string {
  return `API error: ${status} – ${JSON.stringify(body)}`;
}

/** Render `ui` at `path` under a fresh query client; returns the recording memory router too. */
export function renderPage(ui: ReactNode, path: string) {
  const location = memoryLocation({ path, record: true });
  const { wrapper: QueryWrapper } = makeQueryWrapper();
  function PageWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <Router hook={location.hook} searchHook={location.searchHook}>{children}</Router>
      </QueryWrapper>
    );
  }
  return { location, ...render(ui, { wrapper: PageWrapper }) };
}

/** Hold every request open, as a slow network would, so a page stays loading. */
export function stubPendingFetch() {
  const fetchSpy = vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => undefined));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}
