import { createContext, useContext, useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useAuth0, AUTH0_AUDIENCE } from '../lib/auth0.js';
import type { AppSession } from '../types/auth.js';
import { MeResponseSchema } from '../lib/validation/auth-schemas.js';
import { postActivityEvent } from '../lib/activity-logger.js';
import { apiFetch } from '../lib/api-client.js';

/** sessionStorage key used to prevent duplicate login events on page refresh. */
const SESSION_LOGIN_KEY = 'obs:login_recorded';

/** Rejection reason when Auth0 resolves without a token (typed `string | undefined` since auth0-react 2.28). */
const MISSING_ACCESS_TOKEN_ERROR = 'Auth0 returned no access token';

interface AuthContextValue {
  session: AppSession | null;
  isLoading: boolean;
  signOut: () => Promise<void>;
  getAccessToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchAppSession(jwt: string, signal?: AbortSignal): Promise<AppSession | null> {
  try {
    const res = await apiFetch(`/api/me`, jwt, null, { method: 'GET', signal });
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
      // Org-scoping fields (P6) — present only once the worker serves
      // org-scoped sessions (ORG_SCOPING_ENABLED=true).
      ...(me.activeOrg !== undefined && { activeOrgId: me.activeOrg }),
      ...(me.memberships !== undefined && { memberships: me.memberships }),
      ...(me.role !== undefined && { role: me.role }),
      ...(me.isStaff !== undefined && { isStaff: me.isStaff }),
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoading: auth0Loading, isAuthenticated, getAccessTokenSilently, logout } = useAuth0();
  const [session, setSession] = useState<AppSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const getAccessToken = useCallback(async (): Promise<string> => {
    const token = await getAccessTokenSilently({ authorizationParams: { audience: AUTH0_AUDIENCE } });
    if (!token) throw new Error(MISSING_ACCESS_TOKEN_ERROR);
    return token;
  }, [getAccessTokenSilently]);

  useEffect(() => {
    if (auth0Loading) return;

    const controller = new AbortController();
    let cancelled = false;

    if (!isAuthenticated) {
      void Promise.resolve().then(() => {
        if (!cancelled) {
          setSession(null);
          setIsLoading(false);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    let capturedJwt: string | null = null;

    getAccessToken()
      .then((jwt) => {
        capturedJwt = jwt;
        return cancelled ? null : fetchAppSession(jwt, controller.signal);
      })
      .then((appSession) => {
        if (!cancelled) {
          if (appSession && capturedJwt) {
            // Record login once per browser tab session — guards against
            // duplicate rows on page refresh while still capturing the event on
            // the initial sign-in redirect.
            try {
              if (!sessionStorage.getItem(SESSION_LOGIN_KEY)) {
                sessionStorage.setItem(SESSION_LOGIN_KEY, '1');
                void postActivityEvent('login', capturedJwt);
              }
            } catch {
              // sessionStorage unavailable (private browsing, blocked) — skip silently.
            }
          }
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
      if (jwt) void apiFetch(`/api/logout`, jwt, null, { method: 'POST' }).catch(() => undefined);
    }
    // Deliberately NO setSession(null) here. logout() resolves after CALLING
    // window.location.assign, while the page is still alive — clearing the
    // session at that point re-renders RequireAuth → /login, whose auto
    // loginWithRedirect issues a second navigation that stomps the pending
    // /v2/logout one; Auth0's still-live session then silently re-authenticates
    // and the user lands back signed-in. On success the page unloads and takes
    // all local state with it; on failure the rejection propagates so Layout
    // can re-enable its button and the user retries.
    await logout({ logoutParams: { returnTo: window.location.origin } });
  }, [session, logout, getAccessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, isLoading, signOut: handleSignOut, getAccessToken }),
    [session, isLoading, handleSignOut, getAccessToken],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
