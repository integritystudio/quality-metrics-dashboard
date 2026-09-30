/**
 * Shared authorized-fetch helper — the client-side org choke point (P6).
 *
 * Every org-scoped dashboard fetch (useApiQuery, useTrace, AdminPage mutations,
 * org switch) builds its headers here, so the X-Org-Id header is single-source
 * on the client. The header names the client's CHOSEN org only; the worker
 * validates it against the session's memberships on every request and never
 * trusts it as-is.
 */

import { ORG_ID_HEADER, UUID_PATTERN } from './worker-contract.js';

const ORG_STORAGE_KEY = 'obs.activeOrgId';

export function getStoredOrgId(): string | null {
  try {
    const stored = window.localStorage.getItem(ORG_STORAGE_KEY);
    // Defense-in-depth: a corrupted/hand-edited entry must not become an
    // X-Org-Id header value. The worker rejects non-UUIDs anyway (403), but a
    // garbage value here would 403 every request until storage is cleared.
    return stored && UUID_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function setStoredOrgId(orgId: string): void {
  try {
    window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } catch {
    // Storage unavailable (private mode) — the session default still applies.
  }
}

export function apiFetch(
  url: string,
  token: string,
  activeOrgId: string | null,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<Response> {
  const { headers, ...rest } = init ?? {};
  return fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(activeOrgId ? { [ORG_ID_HEADER]: activeOrgId } : {}),
      ...headers,
    },
  });
}
