import { useAuth0, AUTH0_AUDIENCE } from '../lib/auth0.js';

export function LoginPage() {
  const { loginWithRedirect } = useAuth0();

  const handleLogin = () =>
    loginWithRedirect({
      authorizationParams: {
        audience: AUTH0_AUDIENCE,
        redirect_uri: `${window.location.origin}/callback`,
      },
    });

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Sign in</h1>
        <button className="login-btn" onClick={handleLogin}>
          Sign in
        </button>
      </div>
    </div>
  );
}
