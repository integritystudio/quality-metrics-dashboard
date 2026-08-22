import { useEffect } from 'react';
import { useSearch } from 'wouter';
import { useAuth0, AUTH0_LOGIN_PARAMS, safeReturnTo } from '../lib/auth0.js';

export function LoginPage() {
  const { loginWithRedirect } = useAuth0();
  const search = useSearch();

  useEffect(() => {
    // RequireAuth encodes the page that demanded auth as ?redirect=; carry it
    // through Auth0 as appState so onRedirectCallback can restore it after
    // the code exchange.
    const returnTo = safeReturnTo(new URLSearchParams(search).get('redirect'));
    void loginWithRedirect({
      authorizationParams: AUTH0_LOGIN_PARAMS,
      appState: { returnTo },
    });
  }, [loginWithRedirect, search]);

  return <div className="auth-loading" role="status" aria-label="Loading" />;
}
