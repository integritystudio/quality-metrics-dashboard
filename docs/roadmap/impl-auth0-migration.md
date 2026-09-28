# Auth0 Migration — Implementation Guide

**Decision**: Auth0 is the canonical identity provider for external/enterprise user support.
**Date**: 2026-03-26
**Status**: Code complete (commits `6a53313`, `37f71c0`, 2026-03-26). Deployed and smoke-tested 2026-03-27 (`c96513a`). Only the `auth0_id` backfill remains — see [Rollout Sequence](#rollout-sequence).
**Parent**: [`docs/auth-architecture.md`](../../../docs/auth-architecture.md) (history: [`docs/archive/user-rationalization-implementation-record.md`](../../../docs/archive/user-rationalization-implementation-record.md), Phase 4 — Auth0 canonical decision)

---

## Overview

Supabase Auth (JWT verification via `/auth/v1/user`) has been replaced with Auth0 as the identity provider. Supabase remains the application database. Auth0 issues JWTs; the worker verifies them via JWKS; `public.users` is the app-level user record keyed by `auth0_id`.

**What stays**: Supabase DB, `public.users`, `user_roles`, `roles`, `user_activity`, all KV reads, all route handlers, all permission logic.

**What changed**: JWT issuance/verification, session management on the frontend, user provisioning path, activity logging auth.

---

## Where the implementation detail went

The step-by-step worker, frontend, schema, env-var, test and permissions sections (former §3–§5 and §7–§9) were removed on 2026-09-27 because the code now carries them and had moved past their snippets — refresh tokens, org scoping, three workers, and the `provisioned-dashboard-viewer` default role all postdate them. They are in git history before that date. Read instead:

- Dashboard auth flow, RBAC, protected routes, Zod schemas: [`docs/auth/user-authentication.md`](../auth/user-authentication.md)
- Cross-service tokens and identity schema: [`docs/auth-architecture.md`](../../../docs/auth-architecture.md)
- Code: `worker/index.ts` (JWKS verification, `auth0_id` lookup, activity logging), `src/App.tsx` (`Auth0Provider`), `src/contexts/AuthContext.tsx`, `src/lib/validation/auth-schemas.ts`

What remains here is what the code does not hold: the decision, the tenant setup, the Post-Login Action source, the database changes, and the open backfill.

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

## Rollout Sequence

- ✅ Resolve permissions model mismatch (section 9, Option A)
- ✅ DB changes: drop RLS policy on `user_activity` (section 6a)
- ✅ Worker changes: JWKS verification, `auth0_id` lookup, service-role activity logging (section 3)
- ✅ Frontend changes: Auth0 SDK, `AuthContext`, `LoginPage`, `App.tsx` (section 4–5)
- ✅ Tests: worker auth mocks updated, `auth-context-refresh` rewritten (section 8)
- ✅ Auth0 tenant setup + Post-Login Action (section 1–2) — deployed via `.auth0_cli` / `a0deploy` (2026-03-26)
- ✅ Set frontend `.env`: generated from Doppler via `.auth0_cli` (2026-03-26)
- ✅ Deploy both workers (`obs-toolkit-quality-metrics-api` + `quality-metrics-api`) — deployed 2026-03-27
- ✅ Smoke test: sign in, verify `/api/me`, verify a protected route, verify activity logging — all passing 2026-03-27; fixed `waitUntil` bug (activity logging was silently dropped without `ctx.waitUntil`)
- ✅ Monitor Supabase logs for auth errors for 48h — no errors detected; 0 users with null `auth0_id` as of 2026-03-27; backfill fires on first Auth0 login per Post-Login Action
- [ ] After all users log in via Auth0: verify `auth0_id` backfill complete (section 6b) — 2/12 users backfilled so far (alyshialedlie@gmail.com, test@integritystudio.ai); 5 core team users pending first Auth0 login
- ✅ Delete `src/lib/supabase.ts` and remaining dead code — already deleted (pre-existing)
