## Status: Phase 1 + Phase 2 + Phase 3 + Phase 4 (Partial) Complete (v3.0.4–current)

As of 2026-03-25, **Phase 1, Phase 2, Phase 3, and Phase 4 (partial) are implemented**:

### Phase 1 (v3.0.4) — superseded by Auth0 migration (2026-03-26)
- ✅ ~~Supabase Auth for sign-in with JWT verification~~ → replaced by Auth0 JWKS verification
- ✅ Provisioning/resolving `public.users` on first login
- ✅ Role/permission loading from `user_roles → roles`
- ✅ Protected routes with permission guards
- ✅ `/api/me` endpoint (no internal user IDs leaked)
- ✅ Bearer token injection in all API requests
- ✅ `AuthContext` provider with session state
- ✅ `LoginPage` and `RequireAuth` guards
- ✅ Cache headers changed to `private, no-store` for authenticated routes

### Phase 2 (v3.0.5–v3.0.10) — AUTH-1 through AUTH-17 Hardening
**P1 items:**
- ✅ AUTH-1: Strict type validation on `AppSession` cast
- ✅ AUTH-2: RequireAuth loading skeleton (replaced null)
- ✅ AUTH-3: Token availability gates for protected queries
- ✅ AUTH-4: Automatic token refresh on 401 + retry

**P2 items:**
- ✅ AUTH-6: Return 401 on `public.users` lookup failure (not silent fallback)
- ✅ AUTH-7: Route restoration after sign-in
- ✅ AUTH-8: Validate `AuthTokenResponse` shape before casting
- ✅ AUTH-9: Use auth state directly instead of re-parsing localStorage
- ✅ AUTH-15: Input validation on `name` path params in metrics/trends routes

**P3 items:**
- ✅ AUTH-12: Token length check before header interpolation
- ✅ AUTH-13: Add `localhost` to CORS policy for local dev
- ✅ AUTH-16: Document CORS `allowMethods: ['GET']` rationale
- ✅ AUTH-17: Parallelize and timeout Supabase fetches in auth middleware

### Phase 3 (current) — Permission-Constrained Views
- ✅ Gate RoleSelector UI based on `allowedViews` from authenticated session
- ✅ Close role query param bypass with server-side `allowedViews` validation on `/api/dashboard`
- ✅ Clean up MeResponse imports

---

## Recommended approach (v3.0.1+)

> **Superseded (2026-03-26)**: Auth0 is the canonical identity provider. See [`impl-auth0-migration.md`](impl-auth0-migration.md) for current architecture. The Supabase Auth approach below is retained as historical context only.

~~Add **Supabase Auth for sign-in**, but keep authorization grounded in your existing app schema:~~

* ~~authenticate with `auth.users`~~
* ~~provision/resolve the matching `public.users` row~~
* ~~load roles from `user_roles -> roles`~~
* ~~gate dashboard/API access by permissions~~
* ~~keep Cloudflare KV as the metrics source for now~~

~~That fits the current repo shape: React/Vite frontend, Hono API, Cloudflare Worker backend, and KV-backed read APIs. The app today still exposes role as a request/UI concept, and the worker currently serves public GET routes with no auth enforcement. ([GitHub][1])~~

---

## Schema adjustment checklist

### 1) Pick one identity mapping rule

Use this rule for all **new** dashboard users:

* `public.users.id = auth.users.id`

Why: your current schema is split. Some tables point to `auth.users`, while others point to `public.users`, which creates ongoing join and authorization complexity. In the schema you shared, `analytics_projects` and `provider_oauth_tokens` point to `auth.users`, while `api_keys`, `user_profiles`, `user_roles`, `user_sessions`, and `user_activity` point to `public.users`. That split is the main thing to tame first.

### 2) Treat `public.users` as the app user record

Keep using:

* `public.users`
* `user_profiles`
* `roles`
* `user_roles`
* `user_activity`
* `user_sessions`

for application identity, RBAC, and audit.

### 3) Do not use `user_profiles.role` as source of truth

Use:

* `user_roles`
* joined to `roles`
* read `roles.permissions`

Treat `user_profiles.role` as legacy/denormalized metadata only.

### 4) Add dashboard permissions into `roles.permissions`

Recommended permission strings:

```json
[
  "dashboard.read",
  "dashboard.executive",
  "dashboard.operator",
  "dashboard.auditor",
  "dashboard.traces.read",
  "dashboard.sessions.read",
  "dashboard.agents.read",
  "dashboard.pipeline.read",
  "dashboard.compliance.read",
  "dashboard.admin"
]
```

### 5) Keep `auth0_id` temporarily, but plan to rename it

Near term:

* keep the column for compatibility

Medium term:

* rename `auth0_id` to something neutral like `identity_subject` or `external_auth_id`

If Supabase Auth becomes the canonical login path, `auth0_id` becomes misleading.

### 6) Decide whether `user_sessions` is auth or audit

Since Supabase Auth already manages authentication sessions, use your `user_sessions` table as:

* telemetry
* device/session audit
* risk monitoring

not as the source of truth for active login validity.

---

## SQL / data changes to make first

### A. Seed dashboard permissions into `roles`

You likely already have role rows; add permissions there rather than inventing new dashboard-only tables.

Example conceptual update:

```sql
update public.roles
set permissions = permissions || '["dashboard.read","dashboard.executive"]'::jsonb
where name = 'executive';
```

Do the equivalent for operator, auditor, admin.

### B. Add a lightweight mapping safeguard if IDs cannot be aligned

Only if you cannot make `public.users.id = auth.users.id` for new users:

```sql
create table public.auth_user_links (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  app_user_id uuid unique not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
```

I would avoid this unless necessary.

### C. Add indexes if missing

Helpful indexes:

```sql
create index if not exists idx_user_roles_user_id on public.user_roles(user_id);
create index if not exists idx_user_roles_role_id on public.user_roles(role_id);
create index if not exists idx_user_profiles_user_id on public.user_profiles(user_id);
create index if not exists idx_user_activity_user_id_created_at on public.user_activity(user_id, created_at desc);
create index if not exists idx_user_sessions_user_id_created_at on public.user_sessions(user_id, created_at desc);
```

---

## File-by-file implementation plan

## 1) `package.json`

Add Supabase client dependency to the frontend app. The repo is already a React 19 + Vite 6 app. ([GitHub][1])

Add:

* `@supabase/supabase-js`

You may also want:

* `jose` if you choose explicit JWT verification in worker code
* or use Supabase JWKS-based verification flow from the worker

### Changes

* install `@supabase/supabase-js`
* optionally install `jose`

---

## 2) `src/lib/supabase.ts` (new)

Create a browser Supabase client.

Responsibilities:

* initialize client from `VITE_SUPABASE_URL`
* initialize from `VITE_SUPABASE_ANON_KEY`
* export singleton client

Example shape:

```ts
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
```

---

## 3) `src/contexts/AuthContext.tsx` (new)

Add an auth/session provider distinct from the current role provider.

Responsibilities:

* load Supabase session on app boot
* subscribe to auth state changes
* fetch `/api/me`
* expose:

  * `session`
  * `user`
  * `appSession`
  * `isLoading`
  * `signIn`
  * `signOut`

### Important

This becomes the new top-level identity source.
Today the app wraps UI in `RoleProvider` and uses explicit role view types like `executive`, `operator`, `auditor`. ([GitHub][2])

---

## 4) `src/pages/LoginPage.tsx` (new)

Create a login page.

Recommended first login methods:

* Google SSO for internal access, or
* magic link if you want minimal setup

UI:

* app logo/title
* "Continue with Google" button or email magic link form
* optional "allowed domain only" message

---

## 5) `src/components/RequireAuth.tsx` (new)

Add a simple route guard.

Behavior:

* loading -> spinner/skeleton
* unauthenticated -> redirect to `/login`
* authenticated but unauthorized -> render access denied
* authenticated and authorized -> render children

---

## 6) `src/App.tsx`

This is the biggest frontend refactor.

The app currently imports `RoleSelector`, `RoleProvider`, and uses `VALID_ROLES = ['executive', 'operator', 'auditor']`, with `RolePage` and dashboard fetching shaped around role as a first-class view selector. ([GitHub][2])

### Refactor goals

* wrap app in `AuthProvider`
* add `/login`
* gate protected routes with `RequireAuth`
* derive available dashboard views from permissions, not from public role selection
* keep "view mode" only for users who actually have multiple allowed view permissions

### Concrete changes

* add auth provider above router
* change root route logic:

  * anonymous -> `/login`
  * signed-in -> dashboard routes
* make `RoleSelector` conditional:

  * only show if user has >1 dashboard view permission
* stop trusting URL/query role alone
* treat role as a display mode derived from permissions

---

## 7) `src/contexts/RoleContext.tsx`

Refactor, don't necessarily delete.

New responsibility:

* store selected **allowed** dashboard mode
* validate selected mode against authenticated user permissions

Example:

* if permissions include `dashboard.executive` and `dashboard.auditor`, allow switching only between those two
* if only `dashboard.operator`, pin mode to operator

---

## 8) `src/hooks/useDashboard.ts`

Today `/api/dashboard` accepts `?period=7d&role=executive` per README, and the frontend already requests role-specific views. ([GitHub][1])

### Change

Send the Supabase access token in `Authorization: Bearer ...`.

Also:

* keep `role` only as a requested view mode
* let backend validate whether that requested role is permitted

---

## 9) Other data hooks

Update these hooks similarly to include auth headers:

* `useMetricDetail`
* `useTrend`
* any trace/session/evaluation/agents/compliance/pipeline hooks

Reason: the worker currently exposes many sensitive detail routes:

* `/api/evaluations/trace/:traceId`
* `/api/traces/:traceId`
* `/api/sessions/:sessionId`
* `/api/agents/detail/:agentId`
* `/api/compliance/*`
* `/api/pipeline` ([GitHub][1])

---

## 10) `src/api/server.ts`

This file should become the frontend API helper boundary.

### Add

* common `apiFetch()` helper
* inject bearer token from Supabase session
* normalize 401 / 403 handling
* optionally auto-refresh on token changes

---

## 11) `src/types.ts`

Add app-auth types.

Recommended additions:

```ts
export type DashboardPermission =
  | 'dashboard.read'
  | 'dashboard.executive'
  | 'dashboard.operator'
  | 'dashboard.auditor'
  | 'dashboard.traces.read'
  | 'dashboard.sessions.read'
  | 'dashboard.agents.read'
  | 'dashboard.pipeline.read'
  | 'dashboard.compliance.read'
  | 'dashboard.admin';

export interface AppSession {
  authUserId: string;  // Server-side only, never exposed via /api/me
  appUserId: string;   // Server-side only, never exposed via /api/me
  email: string;
  fullName?: string;
  organization?: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: RoleViewType[];
}

export interface MeResponse {
  // Only these fields are exposed via /api/me — internal IDs are never sent to client
  email: string;
  roles: string[];
  permissions: DashboardPermission[];
  allowedViews: RoleViewType[];
}
```

---

## 12) `worker/index.ts`

This is the most important backend file.

Right now the worker:

* applies CORS for a few fixed origins
* allows only GET methods
* caches `/api/*`
* serves unauthenticated GET routes directly from KV and query params, including `role` as user input. ([GitHub][3])

### Refactor this file into layers

### A. Add environment bindings

Add bindings for:

* `SUPABASE_URL`
* `SUPABASE_JWKS_URL` or derive from URL
* optionally `SUPABASE_SERVICE_ROLE_KEY` only if you need privileged DB/admin calls
* existing `DASHBOARD`
* existing `ASSETS`

### B. Add auth middleware

For `/api/*` except maybe `/api/health`:

1. read bearer token
2. verify Supabase JWT
3. resolve/provision app user
4. resolve permissions
5. attach normalized session to context

Conceptual context shape:

```ts
type AppSession = {
  authUserId: string;
  appUserId: string;
  email: string;
  roles: string[];
  permissions: string[];
};
```

### C. Add authorization helpers

Example helpers:

* `requirePermission('dashboard.read')`
* `requireAnyPermission(['dashboard.executive', 'dashboard.operator', 'dashboard.auditor'])`

### D. Protect routes

Suggested mapping:

* `/api/dashboard` -> `dashboard.read`
* role-specific dashboard mode:

  * executive -> `dashboard.executive`
  * operator -> `dashboard.operator`
  * auditor -> `dashboard.auditor`
* `/api/metrics/:name` -> `dashboard.read`
* `/api/trends/:name` -> `dashboard.read`
* `/api/correlations` -> `dashboard.read`
* `/api/coverage` -> `dashboard.auditor` or `dashboard.read`, depending on sensitivity
* `/api/pipeline` -> `dashboard.pipeline.read`
* `/api/agents` -> `dashboard.agents.read`
* `/api/agents/detail/:agentId` -> `dashboard.agents.read`
* `/api/traces/:traceId` -> `dashboard.traces.read`
* `/api/evaluations/trace/:traceId` -> `dashboard.traces.read`
* `/api/sessions/:sessionId` -> `dashboard.sessions.read`
* `/api/compliance/*` -> `dashboard.compliance.read`

### E. Add `/api/me`

Return normalized session info. **Important**: Never expose internal user IDs (`authUserId`, `appUserId`) to the client — keep these server-side only.

```json
{
  "email": "user@company.com",
  "roles": ["auditor"],
  "permissions": ["dashboard.read", "dashboard.auditor", "dashboard.traces.read"],
  "allowedViews": ["auditor"]
}
```

See **Section 11** for the MeResponse type definition.

### F. Adjust cache policy

Do not cache authenticated JSON as `public`.
The worker currently sets `Cache-Control: public, max-age=300` on `/api/*`. That should change for protected routes. ([GitHub][3])

Use something like:

* `private, no-store` for `/api/me`
* cautious/private caching or no-store for sensitive detail endpoints
* maybe short-lived private caching if you really need it

### G. Tighten CORS

The worker currently allows three fixed origins. Keep this, but ensure login/callback origin coverage matches actual deployed frontends. ([GitHub][3])

---

## 13) `wrangler.toml`

Add worker environment vars/secrets wiring.

Add/configure:

* `SUPABASE_URL`
* `SUPABASE_PROJECT_REF` if helpful
* non-secret vars for public env if needed
* secret for service role only if used server-side

Do not expose service role to the browser.

---

## 14) `vite.config.ts`

Usually minimal changes only.

Make sure browser env passthrough is ready for:

* `VITE_SUPABASE_URL`
* `VITE_SUPABASE_ANON_KEY`

---

## 15) `e2e/*`

Add end-to-end coverage for auth and authorization.

Recommended tests:

* anonymous user redirected to `/login`
* signed-in executive can open executive dashboard
* executive cannot open trace detail if not granted
* auditor can open trace and compliance pages
* operator cannot access admin-only routes if added later
* expired token leads to relogin / 401 flow

The repo already has an `e2e` directory, so this fits the current structure. ([GitHub][1])

---

## 16) `docs/*`

Add a short auth architecture doc.

Sections:

* identity flow
* `auth.users` vs `public.users`
* provisioning rules
* role/permission model
* protected endpoints
* env vars
* local dev auth setup

The repo already includes a `docs` directory, so this belongs there. ([GitHub][1])

---

## Backend flow to implement

I'd implement this exact request lifecycle:

### On first authenticated request

1. verify Supabase JWT
2. read:

   * `sub`
   * `email`
   * `name` / user metadata if present
3. find `public.users` by `id = authUserId`
4. if missing:

   * insert `public.users`
   * insert `user_profiles`
   * optionally assign default role
5. resolve `user_roles -> roles`
6. flatten permissions from `roles.permissions`
7. return/attach normalized session

### On every protected request

1. verify token
2. resolve normalized session
3. authorize permission
4. serve KV payload

### On login/logout or sensitive reads

Write `user_activity` records:

* `login`
* `logout`
* `dashboard_view`
* `trace_view`
* `session_view`
* `compliance_view`

---

## Provisioning logic

Use backend upsert-on-first-login rather than DB triggers for phase 1.

Why:

* easier to reason about
* easier to control allowed domains
* easier to log activity
* easier to reject unknown users cleanly

Pseudo-rules:

* allow if email domain is approved
* create `public.users`
* create `user_profiles`
* attach default role if applicable
* else deny with 403 and log attempted access

---

## Rollout sequence

### Phase 1

* add Supabase client
* add login page
* add auth provider
* add `/api/me`
* add worker JWT verification

### Phase 2

* add app-user provisioning into `public.users`
* load permissions from `roles`
* protect routes

### Phase 3

* replace unrestricted role selector with permission-constrained view selector
* protect sensitive detail endpoints
* add activity/session audit logging

### Phase 4

* clean up legacy columns/naming
* evaluate whether to align older users to `auth.users.id`
* optionally add admin tooling for role assignment

---

## Highest-risk items

### 1. `auth.users` vs `public.users` split

This is the architectural sharp edge.

### 2. Public cache headers on authenticated APIs

Current `public, max-age=300` is wrong for user-scoped or sensitive responses. ([GitHub][3])

**Status**: Changed to `private, no-store` for all `/api/*` routes.

### 3. PII leakage via `/api/me` response

Internal user IDs (`authUserId`, `appUserId`) from `auth.users` and `public.users` should never be exposed to the client. These are server-side implementation details.

**Status**: v3.0.4 removed these fields from `/api/me` response. Frontend receives only `email`, `roles`, `permissions`, `allowedViews`.

### 4. Role query param abuse

Right now the worker accepts a `role` query param for dashboard views. That should become a requested mode validated against authenticated permissions, not a trust boundary. ([GitHub][3])

### 5. Frontend role-first mental model

The current app structure makes role a primary UI state. That needs to become auth-first, permission-driven state. ([GitHub][2])

---

## Phase 1 Definition of Done (✅ Complete)

- ✅ anonymous users cannot load dashboard data
- ✅ signed-in users get a normalized `/api/me`
- ✅ user roles come from `user_roles → roles.permissions`
- ✅ `/api/dashboard` only allows permitted views
- ✅ trace/session/compliance endpoints are protected
- ✅ KV remains the source for metrics data
- ✅ frontend no longer treats role as an unauthenticated free selector

---

## Next: Phase 4 & Beyond

### Phase 2: ✅ COMPLETE — Hardened Phase 1 Issues (AUTH-1 through AUTH-17)
All items resolved across 5 commits (27e7f2c through 398d6eb):
- ✅ **P1**: AUTH-1, AUTH-2, AUTH-3, AUTH-4 — type safety, loading state, token gating, refresh
- ✅ **P2**: AUTH-6, AUTH-7, AUTH-8, AUTH-9, AUTH-15 — lookup strictness, route restoration, type validation, state mgmt
- ✅ **P3**: AUTH-12, AUTH-13, AUTH-16, AUTH-17 — token guard, CORS, docs, parallelization

### Phase 3: ✅ COMPLETE — Permission-Constrained Views & Audit
- ✅ Replace public role selector with permission-driven view selector (**ce1cb6a**: gate RoleSelector tabs and /role routes on allowedViews)
- ✅ Protect `/api/dashboard` with server-side `allowedViews` check (**34195c9**: close role gate bypass)
- ✅ Clean up MeResponse imports (**3fddbb4**: remove dead MeResponse import)
- ✅ Add activity/session audit logging to `user_activity` table (completed in Phase 4)
- ✅ Document admin role assignment workflows (completed in Phase 4)

### Phase 4: Legacy Cleanup & Hardening (Partial)
- ✅ Add activity/session audit logging to `user_activity` table (**0a5cb35**, **c9ecaac**: fire-and-forget logActivity on dashboard_view, trace_view, session_view, compliance_view)
- ✅ Add login/logout activity logging (**251b8d5**, **daef5a2**, **0ef55ee**: POST /api/activity endpoint, POST /api/logout endpoint, AuthEvent type, SIGNED_IN/SIGNED_OUT hooks in AuthContext)
- ✅ Add admin tooling for role/permission assignment (**d420e6c**, **c9a38dc**: GET/POST/DELETE /api/admin/* routes gated by dashboard.admin, AdminPage.tsx with user list + role assign/revoke, AdminGuard frontend permission check, service role key for RLS bypass)
- ✅ Document admin route error handling policy (**3c1273c**: ADMIN-P4-3)
- ✅ Proactive auto-refresh timer in AuthContext (**5f60b82**: token refresh before expiry)
- ✅ Extract Supabase REST client helpers to `supabase-rest.ts` (**88c7605**: AUTH-P4-1)
- ✅ Make `authUserId`/`appUserId` optional in AppSession (**9e7bb4e**: AUTH-P3-3)
- ✅ Align older users to `auth.users.id` — verified and resolved (2026-03-26): 2 orphaned `public.users` rows deleted, 7 `auth.users`-only accounts provisioned into `public.users`
- ~~Rename `auth0_id` to neutral name~~ — **Permanently dropped**: Auth0 will remain the canonical identity provider for external/enterprise user support. `auth0_id` is the correct column name; it will hold Auth0 subject identifiers (`auth0|...`) once Auth0 becomes canonical. See [phase4-legacy-cleanup.md](phase4-legacy-cleanup.md).
- ✅ Remove deprecated columns from `user_profiles` — `user_profiles.role` dropped (2026-03-26): zero non-null rows, no dependent views, RLS policies, or column-specific triggers

---

## Implementation history

### Phase 1 (v3.0.4) — 79618e4 through 69d48ef
- Supabase client integration
- AuthContext with session state and token refresh (partial)
- LoginPage component
- RequireAuth guard
- /api/me endpoint with PII fixes
- Bearer token injection via useApiQuery
- Worker JWT verification and permission enforcement
- CORS and cache header hardening

### Phase 2 (v3.0.5–v3.0.10) — Recent hardening
- AUTH-1 through AUTH-17 implementation across 5 commits (27e7f2c through 398d6eb)
  - **6e94d95** fix(auth): validate DB permissions and path params in worker
  - **beae4b7** fix(auth): P3 hardening — token guard, CORS, comments, auth timeout
  - **398d6eb** fix(auth): validate name path param in metrics and trends routes
  - **63c46ca** docs(backlog): mark all AUTH items Done
  - **27e7f2c** docs: migrate completed AUTH phase 1 items to v3.0.4 changelog
- All items verified with unit + integration tests
- E2E coverage for auth flows + token lifecycle

### Phase 2.1 (v3.0.10) — Zod Validation Schemas
- **8b9898c** feat(auth): add remaining Zod validation schemas (login, refresh, me endpoint)
  - Created 7 Zod schemas in `src/lib/validation/auth-schemas.ts` for all auth request/response types
  - Updated `AuthContext.tsx` to use `MeResponseSchema.safeParse()` instead of manual validation
  - Added response validation in worker `/api/me` endpoint
  - Eliminated remaining manual `typeof` checks and type assertions

### Phase 3 (current) — Permission-Constrained Views & Audit
- **ce1cb6a** feat(auth): gate RoleSelector tabs and /role routes on allowedViews (Phase 3)
  - Replace public role selector with permission-driven view selector
  - Gate RoleSelector component based on `allowedViews` from authenticated session
- **34195c9** fix(auth): close role gate bypass and add server-side allowedViews check on /api/dashboard
  - Add server-side permission validation on `/api/dashboard` endpoint
  - Prevent role query param bypass by validating against user's allowed views
- **abd2e87** chore(backlog): add Phase 3 auth deferred items from code review (ce1cb6a)
  - Deferred activity logging and admin workflows to Phase 4
- **3fddbb4** chore(auth): remove dead MeResponse import from worker
  - Clean up unused imports

See `git log --oneline` for full implementation sequence and code-review findings.

---

## Zod Validation Schemas ✅ Complete

Created in Phase 2.1 (commit 8b9898c) and updated for Auth0 migration (2026-03-26). All auth schemas live at `src/lib/validation/auth-schemas.ts`.

### Current Schemas
- ✅ `Auth0JwtPayloadSchema` — Auth0 JWT payload after `jose.jwtVerify()` (required: `sub`, `iss`, `aud`, `iat`, `exp`; optional: `email`, `name`, etc.) — replaced `AuthUserResponseSchema` on Auth0 migration
- ✅ `PublicUserSchema` — `public.users` table rows (required: `id` uuid, `email` string); worker looks up by `auth0_id`
- ✅ `UserRoleRowSchema` — `user_roles` joined with `roles` (required: `roles.name` string, `roles.permissions` string[])
- ✅ `MeResponseSchema` — `/api/me` endpoint response (required: `email`, `roles`, `permissions`, `allowedViews`)
- ✅ `ActivityRequestSchema`, `AdminRoleSchema`, `AdminUserRoleRowSchema`, `AdminUserSchema`, `AssignRoleRequestSchema` — admin/activity route schemas (unchanged)

### Removed (Auth0 migration, 2026-03-26)
- ~~`AuthUserResponseSchema`~~ — Supabase `/auth/v1/user` response; worker no longer calls this endpoint
- ~~`AuthTokenResponseSchema`~~ — Supabase sign-in/sign-up response; Auth0 SDK handles token exchange
- ~~`LoginRequestSchema`~~ — email/password login payload; replaced by Auth0 Universal Login redirect
- ~~`RefreshTokenRequestSchema`~~ — token refresh payload; Auth0 SDK handles refresh automatically

### Integration Points
- **worker/index.ts**: JWKS verification via `jose`, `public.users` lookup by `auth0_id`, `user_roles` validation, `/api/me` response validation
- **AuthContext.tsx**: `MeResponseSchema.safeParse()` on `/api/me` response

**Result**: Full Zod coverage for auth request/response validation, eliminating manual type assertions and typeof checks.

[1]: https://github.com/integritystudio/quality-metrics-dashboard "GitHub - integritystudio/quality-metrics-dashboard · GitHub"
[2]: https://raw.githubusercontent.com/integritystudio/quality-metrics-dashboard/refs/heads/main/src/App.tsx "raw.githubusercontent.com"
[3]: https://raw.githubusercontent.com/integritystudio/quality-metrics-dashboard/refs/heads/main/worker/index.ts "raw.githubusercontent.com"
