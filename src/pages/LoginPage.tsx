import { useState, type FormEvent } from 'react';
import { useLocation, useSearch } from 'wouter';
import { signIn } from '../lib/supabase.js';

export function LoginPage() {
  const [, navigate] = useLocation();
  const search = useSearch();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function getRedirectPath(): string {
    const raw = new URLSearchParams(search).get('redirect') ?? '/';
    // Only allow relative paths to prevent open redirect
    return raw.startsWith('/') ? raw : '/';
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await signIn(email, password);
      navigate(getRedirectPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Sign in</h1>
        <form onSubmit={handleSubmit} className="login-form">
          <label className="login-label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            className="login-input"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <label className="login-label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="login-input"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="login-btn" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
