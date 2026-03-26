import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import { getSession, signOut as supabaseSignOut, onAuthStateChange, refreshSession } from '../lib/supabase.js';
import type { SupabaseSession } from '../lib/supabase.js';
import { API_BASE } from '../lib/constants.js';
import { postActivityEvent } from '../lib/activity-logger.js';
import type { AppSession } from '../types/auth.js';
import { MeResponseSchema } from '../lib/validation/auth-schemas.js';

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
    const meResult = MeResponseSchema.safeParse(data);
    if (!meResult.success) return null;
    const me = meResult.data;
    // authUserId/appUserId are omitted — /api/me never returns internal IDs.
    return {
      email: me.email,
      roles: me.roles,
      permissions: me.permissions,
      allowedViews: me.allowedViews,
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
    let cancelled = false;
    const seqSnapshot = ++loadSeqRef.current;

    const initializeSession = async () => {
      const current = getSession();
      const session = current ?? (await refreshSession());
      if (!cancelled && seqSnapshot === loadSeqRef.current) {
        await loadSession(session, controller.signal);
      }
    };

    void initializeSession();

    const unsubscribe = onAuthStateChange((supabaseSession, event) => {
      if (event === 'SIGNED_IN' && supabaseSession) {
        void postActivityEvent('login', supabaseSession.access_token);
      }
      if (!cancelled) {
        void loadSession(supabaseSession, controller.signal);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
      unsubscribe();
    };
  }, [loadSession]);

  const handleSignOut = useCallback(async () => {
    const currentSession = getSession();
    if (currentSession) void postActivityEvent('logout', currentSession.access_token);
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
