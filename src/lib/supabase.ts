/**
 * Minimal Supabase auth client — no @supabase/supabase-js SDK.
 * Uses raw fetch against Supabase REST API.
 * Env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 */

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

const SESSION_STORAGE_KEY = 'supabase.session';

export interface SupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user: { id: string; email: string };
}

type AuthStateListener = (session: SupabaseSession | null) => void;

const listeners = new Set<AuthStateListener>();

function notifyListeners(session: SupabaseSession | null): void {
  for (const listener of listeners) {
    listener(session);
  }
}

function saveSession(session: SupabaseSession): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage may be unavailable in some environments
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable in some environments
  }
}

export function getSession(): SupabaseSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as SupabaseSession;
    // Treat session as expired 60s early to avoid edge races
    if (Date.now() / 1000 > session.expires_at - 60) return null;
    return session;
  } catch {
    return null;
  }
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
    const body = await res.text().catch(() => '');
    throw new Error(body || `Sign in failed: ${res.status}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: { id: string; email: string };
  };

  const session: SupabaseSession = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    user: { id: data.user.id, email: data.user.email },
  };

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
  let session: SupabaseSession | null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    session = raw ? (JSON.parse(raw) as SupabaseSession) : null;
  } catch {
    return null;
  }

  if (!session?.refresh_token) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });

    if (!res.ok) {
      clearSession();
      notifyListeners(null);
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: { id: string; email: string };
    };

    const refreshed: SupabaseSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
      user: { id: data.user.id, email: data.user.email },
    };

    saveSession(refreshed);
    notifyListeners(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

/** Subscribe to auth state changes. Returns an unsubscribe function. */
export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
