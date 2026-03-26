# Auth0 Migration — Implementation Guide

**Decision**: Auth0 is the canonical identity provider for external/enterprise user support.
**Date**: 2026-03-26
**Status**: Code + tenant setup complete (2026-03-26). Worker secret provisioning and deployment remain.
**Parent**: [`docs/roadmap/users.md`](users.md) (Phase 4 — Auth0 canonical decision)

---

## Overview

Supabase Auth (JWT verification via `/auth/v1/user`) has been replaced with Auth0 as the identity provider. Supabase remains the application database. Auth0 issues JWTs; the worker verifies them via JWKS; `public.users` is the app-level user record keyed by `auth0_id`.

**What stays**: Supabase DB, `public.users`, `user_roles`, `roles`, `user_activity`, all KV reads, all route handlers, all permission logic.

**What changed**: JWT issuance/verification, session management on the frontend, user provisioning path, activity logging auth.

---

## Status

| Task | File(s) | Status |
|------|---------|--------|
| Auth0 tenant setup | `.auth0_cli`, `local/tenant.yaml` | ✅ Done (2026-03-26) |
| Auth0 Post-Login Action | `.auth0_cli`, `local/actions/provision-user-and-enrich-token/code.js` | ✅ Done (2026-03-26) |
| Worker: JWKS JWT verification | `worker/index.ts` | ✅ Done (2026-03-26) |
| Worker: user lookup by `auth0_id` | `worker/index.ts` | ✅ Done (2026-03-26) |
| Worker: activity logging via service role | `worker/index.ts` | ✅ Done (2026-03-26) |
| Worker: remove `SUPABASE_ANON_KEY` dependency | `worker/index.ts`, `wrangler.toml` | ✅ Done (2026-03-26) |
| Frontend: replace `supabase.ts` with Auth0 SDK | `src/lib/auth0.ts` (new), `src/lib/supabase.ts` (delete later) | ✅ Done (2026-03-26) |
| Frontend: update `AuthContext.tsx` | `src/contexts/AuthContext.tsx` | ✅ Done (2026-03-26) |
| Frontend: update `LoginPage.tsx` | `src/pages/LoginPage.tsx` | ✅ Done (2026-03-26) |
| Schemas: replace `AuthUserResponseSchema` | `src/lib/validation/auth-schemas.ts` | ✅ Done (2026-03-26) |
| Schemas: remove Supabase-specific schemas | `src/lib/validation/auth-schemas.ts` | ✅ Done (2026-03-26) |
| DB: RLS policy on `user_activity` | Supabase | ✅ Done (2026-03-26) |
| DB: existing user `auth0_id` backfill | Supabase | Handled by Post-Login Action on first login |
| Env vars: add Auth0, remove Supabase anon key | `wrangler.toml`, `.env` | ✅ Done (2026-03-26) |
| Tests: update worker auth mocks | `worker/__tests__/` | ✅ Done (2026-03-26) |
| DB: fix permissions mismatch (`dashboard.*` format) | Supabase `public.roles` | ✅ Done (2026-03-26) |

**Remaining**: provision worker secrets → deploy both workers → smoke test → delete `src/lib/supabase.ts`.

---

## 1. Auth0 Tenant Setup

### Application

Create a **Single Page Application** in the Auth0 dashboard:

- **Allowed Callback URLs**: `https://integritystudio.dev/callback`, `http://localhost:5173/callback`
- **Allowed Logout URLs**: `https://integritystudio.dev`, `http://localhost:5173`
- **Allowed Web Origins**: `https://integritystudio.dev`, `http://localhost:5173`
- **Token Endpoint Auth Method**: None (SPA, PKCE)

### API (Audience)

Create an API resource in Auth0:

- **Name**: `integritystudio-dashboard`
- **Identifier (Audience)**: `https://api.integritystudio.dev` (or your preferred audience string)
- **Signing Algorithm**: RS256

This audience must be passed when requesting tokens so the JWT includes the correct `aud` claim.

### Connections

Configure at minimum:
- Username-Password-Authentication (existing users)
- Google social connection (for enterprise onboarding)
- Enterprise SAML/OIDC connections as needed per org

---

## 2. Auth0 Post-Login Action

This Action runs after every successful login. It provisions `public.users` on first login and enriches the token with app permissions. Replaces the current worker-side provisioning and the `assign_default_role` DB trigger as the primary mechanism (trigger remains as safety net).

```javascript
// Auth0 Action: Post-Login
// Secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

exports.onExecutePostLogin = async (event, api) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = event.secrets;
  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };

  const auth0Id = event.user.user_id; // e.g. "auth0|abc123"
  const email = event.user.email;

  // 1. Look up existing public.users row by auth0_id
  let userRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?auth0_id=eq.${encodeURIComponent(auth0Id)}&select=id,email&limit=1`,
    { headers }
  );
  let users = await userRes.json();

  // 2. If not found by auth0_id, try by email (handles migrated Supabase users)
  if (!Array.isArray(users) || !users[0]) {
    userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,email&limit=1`,
      { headers }
    );
    users = await userRes.json();

    if (Array.isArray(users) && users[0]) {
      // Backfill auth0_id for migrated user
      await fetch(
        `${SUPABASE_URL}/rest/v1/users?id=eq.${users[0].id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ auth0_id: auth0Id }),
        }
      );
    }
  }

  // 3. Provision new public.users row if still not found
  if (!Array.isArray(users) || !users[0]) {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ auth0_id: auth0Id, email }),
    });
    const inserted = await insertRes.json();
    users = Array.isArray(inserted) ? inserted : [inserted];
  }

  const appUserId = users[0]?.id;
  if (!appUserId) return; // fail open — don't block login

  // 4. Load permissions from user_roles → roles
  const rolesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${appUserId}&select=roles(name,permissions)`,
    { headers }
  );
  const roleRows = await rolesRes.json();

  const permissions = new Set();
  const roleNames = [];
  if (Array.isArray(roleRows)) {
    for (const row of roleRows) {
      if (!row?.roles) continue;
      roleNames.push(row.roles.name);
      for (const perm of (row.roles.permissions ?? [])) {
        permissions.add(perm);
      }
    }
  }

  // 5. Enrich token with app-level claims (avoids a DB round-trip on every request)
  api.idToken.setCustomClaim('https://integritystudio.dev/roles', roleNames);
  api.idToken.setCustomClaim('https://integritystudio.dev/permissions', [...permissions]);
  api.accessToken.setCustomClaim('https://integritystudio.dev/roles', roleNames);
  api.accessToken.setCustomClaim('https://integritystudio.dev/permissions', [...permissions]);
  api.accessToken.setCustomClaim('https://integritystudio.dev/app_user_id', appUserId);
};
```

**Namespace prefix** (`https://integritystudio.dev/`): Auth0 requires custom claims to be namespaced with a URL you control to avoid conflicts with reserved claims.

---

## 3. Worker Changes (`worker/index.ts`) ✅

### 3a. Dependencies

Add `jose` for JWKS verification (available in Cloudflare Workers):

```bash
cd dashboard && npm install jose
```

### 3b. Bindings

Replace in `Bindings` type and `wrangler.toml`:

```typescript
// Remove:
SUPABASE_ANON_KEY: string;

// Add:
AUTH0_DOMAIN: string;       // e.g. "integritystudio.us.auth0.com"
AUTH0_AUDIENCE: string;     // e.g. "https://api.integritystudio.dev"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` remain — all DB access switches to service role.

### 3c. JWT Verification (lines 122–131)

Replace the Supabase `/auth/v1/user` fetch with JWKS verification:

```typescript
import { createRemoteJWKSet, jwtVerify } from 'jose';

// In the auth middleware, replace lines 122–131:

// Build JWKS URL from domain binding (cached per isolate lifetime by jose)
const JWKS = createRemoteJWKSet(
  new URL(`https://${c.env.AUTH0_DOMAIN}/.well-known/jwks.json`)
);

let payload: Record<string, unknown>;
try {
  const { payload: p } = await jwtVerify(jwt, JWKS, {
    issuer: `https://${c.env.AUTH0_DOMAIN}/`,
    audience: c.env.AUTH0_AUDIENCE,
  });
  payload = p as Record<string, unknown>;
} catch {
  return c.json({ error: 'Unauthorized' }, 401);
}

const auth0Id = typeof payload['sub'] === 'string' ? payload['sub'] : null;
if (!auth0Id) return c.json({ error: 'Unauthorized' }, 401);
```

`jwtVerify` validates signature, expiry, issuer, and audience. No network call to Supabase Auth.

### 3d. User Lookup (lines 133–145)

Change lookup from `id=eq.{authUserId}` to `auth0_id=eq.{auth0Id}`, using service role (Auth0 JWT is not a valid Supabase session JWT for RLS):

```typescript
// Replace lines 133–145:
const userRes = await fetch(
  `${c.env.SUPABASE_URL}/rest/v1/users?select=id,email&auth0_id=eq.${encodeURIComponent(auth0Id)}&limit=1`,
  { headers: serviceRoleHeaders(c.env), signal: controller.signal },
).catch(() => null);
if (!userRes?.ok) return c.json({ error: 'Unauthorized' }, 401);
const rawUsers: unknown = await userRes.json().catch(() => null);
if (!Array.isArray(rawUsers) || !rawUsers[0]) return c.json({ error: 'Unauthorized' }, 401);
const userResult = PublicUserSchema.safeParse(rawUsers[0]);
if (!userResult.success) return c.json({ error: 'Unauthorized' }, 401);
const appUserId = userResult.data.id;
const email = userResult.data.email;
```

`authUserId` is now `auth0Id` (the Auth0 `sub`); `appUserId` is `public.users.id` (your internal UUID).

### 3e. Roles Lookup (lines 150–165)

Switch from user JWT to service role (same Auth0 JWT issue):

```typescript
const rolesRes = await fetch(
  `${c.env.SUPABASE_URL}/rest/v1/user_roles?select=roles(name,permissions)&user_id=eq.${encodeURIComponent(appUserId)}`,
  { headers: serviceRoleHeaders(c.env), signal: controller.signal },  // was: userAuthHeaders
).catch(() => null);
```

### 3f. Activity Logging

`logActivity` currently passes the user JWT to satisfy Supabase RLS (`user_id = auth.uid()`). Auth0 JWTs are not valid Supabase session tokens, so RLS will reject them. Switch to service role:

```typescript
// Update logActivity signature — drop jwt param, use service role:
function logActivity(
  appUserId: string,
  activityType: UserActivityEvent,
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string },
): void {
  supabasePost(
    `${env.SUPABASE_URL}/rest/v1/user_activity`,
    { user_id: appUserId, activity_type: activityType },
    env,
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
```

Remove all `c.get('jwt')` arguments passed to `logActivity` calls throughout the file.

### 3g. `AppSession` update

`authUserId` now holds the Auth0 `sub` (`auth0|...`), not a UUID. Update the test-mode bypass accordingly and any code that assumes `authUserId` is UUID-shaped.

---

## 4. Frontend Changes ✅

### 4a. Install Auth0 React SDK

```bash
cd dashboard && npm install @auth0/auth0-react
```

### 4b. New `src/lib/auth0.ts`

Replace `src/lib/supabase.ts` with an Auth0 wrapper that exposes the same surface used by `AuthContext.tsx`:

```typescript
// src/lib/auth0.ts
export { Auth0Provider, useAuth0 } from '@auth0/auth0-react';

export const AUTH0_DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN as string;
export const AUTH0_CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID as string;
export const AUTH0_AUDIENCE = import.meta.env.VITE_AUTH0_AUDIENCE as string;

if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_AUDIENCE) {
  throw new Error('Missing required env vars: VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE');
}
```

### 4c. `src/contexts/AuthContext.tsx`

Replace Supabase session management with Auth0 hooks:

```typescript
import { useAuth0 } from '@auth0/auth0-react';
import { AUTH0_AUDIENCE } from '../lib/auth0.js';

// Replace loadSession / getSession / refreshSession / onAuthStateChange / startAutoRefresh / stopAutoRefresh
// with useAuth0() hook:

export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoading: auth0Loading, isAuthenticated, getAccessTokenSilently, logout } = useAuth0();
  const [session, setSession] = useState<AppSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (auth0Loading) return;
    if (!isAuthenticated) {
      setSession(null);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    getAccessTokenSilently({ authorizationParams: { audience: AUTH0_AUDIENCE } })
      .then((jwt) => fetchAppSession(jwt, controller.signal))
      .then((appSession) => {
        setSession(appSession);
        setIsLoading(false);
      })
      .catch(() => {
        setSession(null);
        setIsLoading(false);
      });
    return () => controller.abort();
  }, [auth0Loading, isAuthenticated, getAccessTokenSilently]);

  const handleSignOut = useCallback(async () => {
    if (session) {
      const jwt = await getAccessTokenSilently({ authorizationParams: { audience: AUTH0_AUDIENCE } }).catch(() => null);
      if (jwt) void postActivityEvent('logout', jwt);
    }
    logout({ logoutParams: { returnTo: window.location.origin } });
    setSession(null);
  }, [session, logout, getAccessTokenSilently]);

  return (
    <AuthContext.Provider value={{ session, isLoading, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}
```

Token refresh is handled automatically by the Auth0 SDK via `getAccessTokenSilently`. Remove `startAutoRefresh` / `stopAutoRefresh` / `refreshSession` calls.

### 4d. `src/App.tsx` — Wrap with `Auth0Provider`

```typescript
import { Auth0Provider } from './lib/auth0.js';
import { AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_AUDIENCE } from './lib/auth0.js';

// Wrap at the root:
<Auth0Provider
  domain={AUTH0_DOMAIN}
  clientId={AUTH0_CLIENT_ID}
  authorizationParams={{
    redirect_uri: `${window.location.origin}/callback`,
    audience: AUTH0_AUDIENCE,
  }}
>
  <AuthProvider>
    {/* existing router */}
  </AuthProvider>
</Auth0Provider>
```

### 4e. `src/pages/LoginPage.tsx`

Replace email/password form with Auth0 Universal Login redirect:

```typescript
import { useAuth0 } from '@auth0/auth0-react';
import { AUTH0_AUDIENCE } from '../lib/auth0.js';

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
    <div>
      <button onClick={handleLogin}>Sign in</button>
    </div>
  );
}
```

Add a `/callback` route that renders nothing (Auth0Provider handles the token exchange on mount).

### 4f. `src/lib/supabase.ts`

Delete this file after migrating all imports. The only remaining Supabase reference in the frontend should be the env vars for the API base URL if still needed; otherwise remove entirely.

### 4g. Other hooks (`useDashboard`, `useMetricDetail`, etc.)

These call `getAccessToken()` from a custom hook or directly from `AuthContext`. Replace any remaining `getSession()?.access_token` calls with `getAccessTokenSilently()` from `useAuth0()`.

---

## 5. Validation Schema Changes (`src/lib/validation/auth-schemas.ts`) ✅

### Replace `AuthUserResponseSchema`

The current schema validates the Supabase `/auth/v1/user` response. Replace with Auth0 JWT payload claims:

```typescript
// Auth0 JWT payload — result of jwtVerify() in the worker
export const Auth0JwtPayloadSchema = z.object({
  sub: z.string(),                          // Auth0 subject: "auth0|abc123"
  email: z.email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().url().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
});
```

### Remove (no longer needed)

- `AuthTokenResponseSchema` — Auth0 SDK handles token exchange
- `LoginRequestSchema` — Auth0 Universal Login handles login UI
- `RefreshTokenRequestSchema` — Auth0 SDK handles refresh

### `PublicUserSchema` — no change required

The schema selects `id`, `email`, `created_at`, `updated_at`. The worker now passes `auth0_id` as the query filter but does not need to parse it from the response. No schema change needed.

---

## 6. Database Changes ✅

### 6a. Drop RLS policy on `user_activity`

The current policy (`user_id = auth.uid()`) relies on Supabase Auth sessions. With Auth0 JWTs and service-role writes, this policy is no longer enforced at the DB level. Drop it and rely on the worker's permission guard for authorization:

```sql
-- Find and drop the policy
select polname from pg_policy
join pg_class on pg_class.oid = pg_policy.polrelid
where pg_class.relname = 'user_activity';

-- Drop:
drop policy "<policy_name>" on public.user_activity;
```

Access to activity data is already gated at the API layer by `dashboard.admin` permission on `/api/admin/*` routes.

### 6b. Existing user `auth0_id` backfill

All 8 current `public.users` rows have `auth0_id = public.users.id` (Supabase UUID stand-ins). When these users authenticate via Auth0 for the first time, the Post-Login Action handles the backfill by email fallback. No manual migration is required before go-live — the Action updates `auth0_id` to the real Auth0 sub on first login.

Verify all users are backfilled after go-live:

```sql
-- Should return zero rows once all users have logged in via Auth0
select id, email, auth0_id
from public.users
where auth0_id = id::text;  -- still has UUID stand-in
```

---

## 7. Environment Variables (partial — worker done ✅, frontend pending)

### Worker (`wrangler.toml` + secrets)

```toml
# Add:
[vars]
AUTH0_DOMAIN = "integritystudio.us.auth0.com"
AUTH0_AUDIENCE = "https://api.integritystudio.dev"

# Keep:
# SUPABASE_URL (var or secret)
# SUPABASE_SERVICE_ROLE_KEY (secret)

# Remove:
# SUPABASE_ANON_KEY
```

### Frontend (`.env`)

```bash
# Add:
VITE_AUTH0_DOMAIN=integritystudio.us.auth0.com
VITE_AUTH0_CLIENT_ID=<from Auth0 dashboard>
VITE_AUTH0_AUDIENCE=https://api.integritystudio.dev

# Remove:
# VITE_SUPABASE_URL
# VITE_SUPABASE_ANON_KEY
```

---

## 8. Test Updates (`worker/__tests__/`) ✅

The worker tests mock Supabase auth responses. Replace with Auth0 JWT mocks:

- `admin-routes.test.ts`: Replace `ALLOW_TEST_BYPASS` mock or stub `jwtVerify` from `jose` to return a fixed payload with `sub: 'auth0|test-user'`
- `activity-logging.test.ts`: Update `logActivity` mock — remove `jwt` argument, verify service-role header is used
- Remove any test that exercises the Supabase `/auth/v1/user` fetch path

The test-token bypass (`ALLOW_TEST_BYPASS=true` + `jwt === 'test-token'`) in `worker/index.ts` remains valid for integration tests and does not need to change.

---

## 9. Permissions Model — Resolved ✅

**Fixed 2026-03-26.** `roles.permissions` values were simple strings (`"read"`, `"write"`, `"all"`) misaligned with the worker's `VALID_PERMISSIONS` set (`dashboard.*` format). Option A was applied — permissions updated directly in `public.roles`:

```sql
-- Applied:
update public.roles set permissions = '["dashboard.read"]'::jsonb where name = 'read';
update public.roles set permissions = '["dashboard.read","dashboard.traces.read",...]'::jsonb where name = 'admin';
update public.roles set permissions = '["dashboard.read","dashboard.executive",...]'::jsonb where name = 'owner';
```

Permissions are now stored in the DB as the source of truth and the Post-Login Action reads them at login time. No mapping in the Action is needed.

---

## Rollout Sequence

- ✅ Resolve permissions model mismatch (section 9, Option A)
- ✅ DB changes: drop RLS policy on `user_activity` (section 6a)
- ✅ Worker changes: JWKS verification, `auth0_id` lookup, service-role activity logging (section 3)
- ✅ Frontend changes: Auth0 SDK, `AuthContext`, `LoginPage`, `App.tsx` (section 4–5)
- ✅ Tests: worker auth mocks updated, `auth-context-refresh` rewritten (section 8)
- ✅ Auth0 tenant setup + Post-Login Action (section 1–2) — deployed via `.auth0_cli` / `a0deploy` (2026-03-26)
- ✅ Set frontend `.env`: generated from Doppler via `.auth0_cli` (2026-03-26)
- [ ] Provision worker secrets: `wrangler secret put SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY` for both workers
- [ ] Deploy both workers (`obs-toolkit-quality-metrics-api` + `quality-metrics-api`)
- [ ] Smoke test: sign in, verify `/api/me`, verify a protected route, verify activity logging
- [ ] Monitor Supabase logs for auth errors for 48h
- [ ] After all users log in via Auth0: verify `auth0_id` backfill complete (section 6b)
- [ ] Delete `src/lib/supabase.ts` and remaining dead code (see `BACKLOG.md` AUTH0-CLEANUP)
