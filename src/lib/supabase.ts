import { fromUnixTime, isPast, subSeconds } from 'date-fns';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('Missing required env vars: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set');
}

const SESSION_STORAGE_KEY = 'supabase.session';

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user: { id: string; email: string };
}

export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED';

type AuthStateListener = (session: SupabaseSession | null, event: AuthEvent) => void;

type AuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string };
};

const listeners = new Set<AuthStateListener>();

// In-memory session cache — avoids localStorage read/parse on every getSession() call.
// Kept in sync by saveSession() and clearSession().
let cachedSession: SupabaseSession | null = null;

function notifyListeners(session: SupabaseSession | null, event: AuthEvent): void {
  for (const listener of listeners) {
    listener(session, event);
  }
}

function saveSession(session: SupabaseSession): void {
  cachedSession = session;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearSession(): void {
  cachedSession = null;
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearSessionAndNotify(): null {
  clearSession();
  notifyListeners(null, 'SIGNED_OUT');
  return null;
}

function isValidSession(value: unknown): value is SupabaseSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['access_token'] === 'string' &&
    typeof v['refresh_token'] === 'string' &&
    typeof v['expires_at'] === 'number' &&
    typeof v['user'] === 'object' && v['user'] !== null &&
    typeof (v['user'] as Record<string, unknown>)['id'] === 'string' &&
    typeof (v['user'] as Record<string, unknown>)['email'] === 'string'
  );
}

function readRawSession(): SupabaseSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidTokenResponse(value: unknown): value is AuthTokenResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['access_token'] === 'string' &&
    typeof v['refresh_token'] === 'string' &&
    typeof v['expires_in'] === 'number' &&
    typeof v['user'] === 'object' && v['user'] !== null &&
    typeof (v['user'] as Record<string, unknown>)['id'] === 'string' &&
    typeof (v['user'] as Record<string, unknown>)['email'] === 'string'
  );
}

function sessionFromTokenResponse(data: AuthTokenResponse): SupabaseSession {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    user: data.user,
  };
}

export function getSession(): SupabaseSession | null {
  // Use in-memory cache when available; fall back to localStorage (e.g. on first load)
  const session = cachedSession ?? readRawSession();
  if (!session) return null;
  // Treat session as expired 60s early to avoid edge races; evict stale cache entry
  if (isPast(subSeconds(fromUnixTime(session.expires_at), 60))) {
    cachedSession = null;
    return null;
  }
  if (!cachedSession) cachedSession = session; // warm cache from localStorage
  return session;
}

export async function signIn(email: string, password: string): Promise<SupabaseSession> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { message?: string } | null;
    const message = body?.message;
    throw new Error(message ? `Sign in failed: ${message}` : `Sign in failed (${res.status})`);
  }

  const body: unknown = await res.json().catch(() => null);
  if (!isValidTokenResponse(body)) throw new Error('Sign in failed: unexpected response shape');
  const session = sessionFromTokenResponse(body);
  saveSession(session);
  notifyListeners(session, 'SIGNED_IN');
  return session;
}

export async function signOut(): Promise<void> {
  const session = getSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${session.access_token}`,
        },
      });
    } catch {
      // Best-effort — clear local session regardless
    }
  }
  clearSession();
  notifyListeners(null, 'SIGNED_OUT');
}

// In-flight refresh promise — coalesces concurrent callers (e.g. multiple tabs firing
// the auto-refresh timer simultaneously) onto a single network request. Supabase rotates
// the refresh token on first use, so a second concurrent call would consume a stale token
// and trigger an unexpected sign-out.
let refreshInFlight: Promise<SupabaseSession | null> | null = null;

export function refreshSession(): Promise<SupabaseSession | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const stored = readRawSession();
    if (!stored?.refresh_token) return null;

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ refresh_token: stored.refresh_token }),
      });

      if (!res.ok) return clearSessionAndNotify();

      const refreshBody: unknown = await res.json().catch(() => null);
      if (!isValidTokenResponse(refreshBody)) return clearSessionAndNotify();

      const refreshed = sessionFromTokenResponse(refreshBody);
      saveSession(refreshed);
      notifyListeners(refreshed, 'TOKEN_REFRESHED');
      return refreshed;
    } catch {
      return clearSessionAndNotify();
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How often (ms) to check if the token is approaching expiry. */
const AUTO_REFRESH_INTERVAL_MS = 30_000;
/** How many seconds before expiry to proactively refresh. */
const TOKEN_EXPIRY_BUFFER_S = 120;

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
/**
 * Reference counter tracking active callers of startAutoRefresh.
 * Guards against React Strict Mode double-mount and multiple AuthProvider
 * instances leaking timers (CR-AUTH-1).
 */
let autoRefreshRefCount = 0;

/**
 * Starts a background timer that proactively refreshes the session when the
 * access token is within TOKEN_EXPIRY_BUFFER_S seconds of expiry.
 * Reference-counted: each call to startAutoRefresh must be paired with a
 * call to stopAutoRefresh. The timer starts only on the first caller and
 * stops only when the last caller releases it.
 */
export function startAutoRefresh(): void {
  autoRefreshRefCount++;
  if (autoRefreshTimer !== null) return;
  autoRefreshTimer = setInterval(() => {
    const session = cachedSession ?? readRawSession();
    if (!session) return;
    const secondsUntilExpiry = session.expires_at - Math.floor(Date.now() / 1000);
    if (secondsUntilExpiry <= TOKEN_EXPIRY_BUFFER_S) {
      void refreshSession();
    }
  }, AUTO_REFRESH_INTERVAL_MS);
}

/**
 * Releases one reference to the auto-refresh timer.
 * The timer is cleared only when the reference count reaches zero.
 */
export function stopAutoRefresh(): void {
  autoRefreshRefCount = Math.max(0, autoRefreshRefCount - 1);
  if (autoRefreshRefCount === 0 && autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}
