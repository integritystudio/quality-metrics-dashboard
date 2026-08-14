/**
 * Shared authorized-fetch helper — the client-side org choke point (P6).
 *
 * Every dashboard fetch (useApiQuery, useTrace, AdminPage mutations, org
 * switch) builds its headers here, so the X-Org-Id header and the org's place
 * in cache keys are single-source on the client. The header names the client's
 * CHOSEN org only; the worker validates it against the session's memberships
 * on every request and never trusts it as-is.
 */

const ORG_STORAGE_KEY = 'obs.activeOrgId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getStoredOrgId(): string | null {
  try {
    const stored = window.localStorage.getItem(ORG_STORAGE_KEY);
    // Defense-in-depth: a corrupted/hand-edited entry must not become an
    // X-Org-Id header value. The worker rejects non-UUIDs anyway (403), but a
    // garbage value here would 403 every request until storage is cleared.
    return stored && UUID_RE.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function setStoredOrgId(orgId: string | null): void {
  try {
    if (orgId) window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
    else window.localStorage.removeItem(ORG_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode) — the session default still applies.
  }
}

export function authHeaders(
  token: string,
  activeOrgId: string | null,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(activeOrgId ? { 'X-Org-Id': activeOrgId } : {}),
    ...extra,
  };
}

export function apiFetch(
  url: string,
  token: string,
  activeOrgId: string | null,
  init?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<Response> {
  const { headers, ...rest } = init ?? {};
  return fetch(url, { ...rest, headers: authHeaders(token, activeOrgId, headers) });
}
