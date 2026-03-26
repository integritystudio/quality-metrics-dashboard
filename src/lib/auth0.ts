export { Auth0Provider, useAuth0 } from '@auth0/auth0-react';

export const AUTH0_DOMAIN = (import.meta.env.VITE_AUTH0_DOMAIN as string | undefined) ?? '';
export const AUTH0_CLIENT_ID = (import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined) ?? '';
export const AUTH0_AUDIENCE = (import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined) ?? '';

if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_AUDIENCE) {
  throw new Error('Missing required env vars: VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE');
}
