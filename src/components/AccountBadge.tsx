/**
 * The signed-in email as Supabase holds it, read through PostgREST with the Auth0 ID
 * token (CR62). The first direct database read in the SPA: everything else goes through
 * the Worker. Renders nothing until the row is in hand, and nothing at all in a build
 * without Supabase configured.
 */

import { useOwnUserRow } from '../hooks/useOwnUserRow.js';

const BADGE_TITLE = 'Your account row, read from Supabase with your Auth0 ID token';

export function AccountBadge() {
  const { data } = useOwnUserRow();
  if (!data) return null;
  return (
    <span className="account-badge text-xs" data-testid="account-badge" title={BADGE_TITLE}>
      {data.email}
    </span>
  );
}
