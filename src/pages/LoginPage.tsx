import { useEffect } from 'react';
import { useAuth0, AUTH0_AUDIENCE } from '../lib/auth0.js';

export function LoginPage() {
  const { loginWithRedirect } = useAuth0();

  useEffect(() => {
    loginWithRedirect({
      authorizationParams: {
        audience: AUTH0_AUDIENCE,
        redirect_uri: `${window.location.origin}/callback`,
      },
    });
  }, [loginWithRedirect]);

  return <div className="auth-loading" role="status" aria-label="Loading" />;
}
