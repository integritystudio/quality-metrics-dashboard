import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { useAuth0, AUTH0_AUDIENCE } from '../lib/auth0.js';
import { API_BASE } from '../lib/constants.js';
import { postActivityEvent } from '../lib/activity-logger.js';
import type { AppSession } from '../types/auth.js';
import { MeResponseSchema } from '../lib/validation/auth-schemas.js';

interface AuthContextValue {
  session: AppSession | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string>;
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
  const { isLoading: auth0Loading, isAuthenticated, getAccessTokenSilently, logout } = useAuth0();
  const [session, setSession] = useState<AppSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getAccessToken = useCallback(
    () => getAccessTokenSilently({ authorizationParams: { audience: AUTH0_AUDIENCE } }),
    [getAccessTokenSilently],
  );

  useEffect(() => {
    if (auth0Loading) return;

    const controller = new AbortController();
    let cancelled = false;

    if (!isAuthenticated) {
      Promise.resolve().then(() => {
        if (!cancelled) {
          setSession(null);
          setIsLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    getAccessToken()
      .then((jwt) => (cancelled ? null : fetchAppSession(jwt, controller.signal)))
      .then((appSession) => {
        if (!cancelled) {
          setSession(appSession);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSession(null);
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [auth0Loading, isAuthenticated, getAccessToken]);

  const handleSignOut = useCallback(async () => {
    if (session) {
      const jwt = await getAccessToken().catch(() => null);
      if (jwt) void postActivityEvent('logout', jwt);
    }
    logout({ logoutParams: { returnTo: window.location.origin } });
    setSession(null);
  }, [session, logout, getAccessToken]);

  return (
    <AuthContext.Provider value={{ session, isLoading, signOut: handleSignOut, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
