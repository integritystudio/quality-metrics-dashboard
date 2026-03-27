// E2E stub for @auth0/auth0-react — replaces the real SDK when VITE_E2E=1.
// Always returns an authenticated session so tests skip the Auth0 redirect.
import { type ReactNode, createElement } from 'react';

const TEST_TOKEN = 'test-token';

export function Auth0Provider({ children }: { children: ReactNode }) {
  return createElement('div', { 'data-testid': 'auth0-stub' }, children);
}

export function useAuth0() {
  return {
    isLoading: false,
    isAuthenticated: true,
    user: { email: 'test@example.com', sub: 'test-user-id' },
    getAccessTokenSilently: () => Promise.resolve(TEST_TOKEN),
    logout: () => Promise.resolve(),
    loginWithRedirect: () => Promise.resolve(),
  };
}
