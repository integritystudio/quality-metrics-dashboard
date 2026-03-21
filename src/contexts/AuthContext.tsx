import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { getSession, signOut as supabaseSignOut, onAuthStateChange, refreshSession } from '../lib/supabase.js';
import type { SupabaseSession } from '../lib/supabase.js';
import { API_BASE } from '../lib/constants.js';
import type { AppSession, MeResponse } from '../types/auth.js';

interface AuthContextValue {
  session: AppSession | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchAppSession(jwt: string, signal?: AbortSignal): Promise<AppSession | null> {
  try {
    const res = await fetch(`${API_BASE}/api/me`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${jwt}` },
      signal,
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      !('email' in data) ||
      !('roles' in data) ||
      !('permissions' in data) ||
      !Array.isArray((data as Record<string, unknown>).roles) ||
      !Array.isArray((data as Record<string, unknown>).permissions)
    ) {
      return null;
    }
    // MeResponse doesn't include internal IDs (authUserId/appUserId not exposed by /api/me)
    // We satisfy AppSession type but these IDs are never used in frontend code
    const me = data as Record<string, unknown>;
    return {
      authUserId: '',
      appUserId: '',
      email: me.email as string,
      roles: me.roles as string[],
      permissions: me.permissions as string[],
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const loadSeqRef = useRef(0);

  const loadSession = useCallback(async (supabaseSession: SupabaseSession | null, signal?: AbortSignal) => {
    const seq = ++loadSeqRef.current;
    if (!supabaseSession) {
      if (seq === loadSeqRef.current) {
        setSession(null);
        setIsLoading(false);
      }
      return;
    }
    const appSession = await fetchAppSession(supabaseSession.access_token, signal);
    if (seq === loadSeqRef.current) {
      setSession(appSession);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const current = getSession();
    const init = current
      ? loadSession(current, controller.signal)
      : refreshSession().then((s) => loadSession(s, controller.signal));
    void init;

    const unsubscribe = onAuthStateChange((supabaseSession) => {
      setIsLoading(true);
      void loadSession(supabaseSession, controller.signal);
    });

    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [loadSession]);

  const handleSignOut = useCallback(async () => {
    await supabaseSignOut();
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ session, isLoading, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
