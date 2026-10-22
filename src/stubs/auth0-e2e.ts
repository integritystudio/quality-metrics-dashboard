// E2E stub for @auth0/auth0-react — replaces the real SDK when VITE_E2E=1.
// Always returns an authenticated session so tests skip the Auth0 redirect.
import { type ReactElement, type ReactNode, createElement } from 'react';

const TEST_TOKEN = 'test-token';
const TEST_ID_TOKEN = 'test-id-token';

type Auth0Stub = {
  isLoading: boolean;
  isAuthenticated: boolean;
  user: { email: string; sub: string };
  getAccessTokenSilently: () => Promise<string>;
  getIdTokenClaims: () => Promise<{ __raw: string }>;
  logout: () => Promise<void>;
  loginWithRedirect: () => Promise<void>;
};

export function Auth0Provider({ children }: { children: ReactNode }): ReactElement {
  return createElement('div', { 'data-testid': 'auth0-stub' }, children);
}

// eslint-disable-next-line @eslint-react/no-unnecessary-use-prefix -- must match the @auth0/auth0-react export it replaces
export function useAuth0(): Auth0Stub {
  return {
    isLoading: false,
    isAuthenticated: true,
    user: { email: 'test@example.com', sub: 'test-user-id' },
    getAccessTokenSilently: async () => Promise.resolve(TEST_TOKEN),
    getIdTokenClaims: async () => Promise.resolve({ __raw: TEST_ID_TOKEN }),
    logout: async () => Promise.resolve(),
    loginWithRedirect: async () => Promise.resolve(),
  };
}
