import { useEffect } from 'react';
import { useAuth0, AUTH0_LOGIN_PARAMS } from '../lib/auth0.js';

export function LoginPage() {
  const { loginWithRedirect } = useAuth0();

  useEffect(() => {
    void loginWithRedirect({ authorizationParams: AUTH0_LOGIN_PARAMS });
  }, [loginWithRedirect]);

  return <div className="auth-loading" role="status" aria-label="Loading" />;
}
