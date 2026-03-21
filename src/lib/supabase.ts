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

type AuthStateListener = (session: SupabaseSession | null) => void;

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

function notifyListeners(session: SupabaseSession | null): void {
  for (const listener of listeners) {
    listener(session);
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
  if (Date.now() / 1000 > session.expires_at - 60) {
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
  notifyListeners(session);
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
  notifyListeners(null);
}

export async function refreshSession(): Promise<SupabaseSession | null> {
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

    if (!res.ok) {
      clearSession();
      notifyListeners(null);
      return null;
    }

    const refreshBody: unknown = await res.json().catch(() => null);
    if (!isValidTokenResponse(refreshBody)) {
      clearSession();
      notifyListeners(null);
      return null;
    }
    const refreshed = sessionFromTokenResponse(refreshBody);
    saveSession(refreshed);
    notifyListeners(refreshed);
    return refreshed;
  } catch {
    clearSession();
    notifyListeners(null);
    return null;
  }
}

export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
