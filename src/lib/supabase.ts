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

type AuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string };
};

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

function readRawSession(): SupabaseSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SupabaseSession) : null;
  } catch {
    return null;
  }
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
  const session = readRawSession();
  if (!session) return null;
  // Treat session as expired 60s early to avoid edge races
  if (Date.now() / 1000 > session.expires_at - 60) return null;
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
    const body = await res.text().catch(() => '');
    throw new Error(body || `Sign in failed: ${res.status}`);
  }

  const session = sessionFromTokenResponse(await res.json() as AuthTokenResponse);
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

    const refreshed = sessionFromTokenResponse(await res.json() as AuthTokenResponse);
    saveSession(refreshed);
    notifyListeners(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

export function onAuthStateChange(listener: AuthStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
