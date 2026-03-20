import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { getSession, signOut as supabaseSignOut, onAuthStateChange, refreshSession } from '../lib/supabase.js';
import type { SupabaseSession } from '../lib/supabase.js';
import { API_BASE } from '../lib/constants.js';
import type { AppSession } from '../types/auth.js';

interface AuthContextValue {
  session: AppSession | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchAppSession(jwt: string): Promise<AppSession | null> {
  try {
    const res = await fetch(`${API_BASE}/api/me`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${jwt}` },
    });
    if (!res.ok) return null;
    return res.json() as Promise<AppSession>;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadSession = useCallback(async (supabaseSession: SupabaseSession | null) => {
    if (!supabaseSession) {
      setSession(null);
      setIsLoading(false);
      return;
    }
    const appSession = await fetchAppSession(supabaseSession.access_token);
    setSession(appSession);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    // Load on mount from localStorage
    const current = getSession();
    if (!current) {
      // Try refresh before giving up
      refreshSession().then(refreshed => loadSession(refreshed));
    } else {
      loadSession(current);
    }

    // Subscribe to future auth state changes (signIn / signOut)
    const unsubscribe = onAuthStateChange((supabaseSession) => {
      setIsLoading(true);
      loadSession(supabaseSession);
    });

    return unsubscribe;
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
