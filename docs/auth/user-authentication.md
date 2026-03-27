## Status: Done (Phases 1–4, Auth0 migration 2026-03-26)

Auth0 Universal Login is the canonical identity provider. Supabase stores user records and RBAC; all DB access via service role key (Auth0 JWTs cannot satisfy Supabase RLS).

---

## Architecture

### Identity Flow

1. User authenticates via Auth0 Universal Login (redirect flow)
2. Auth0 issues JWT; frontend stores via `@auth0/auth0-react` SDK
3. Worker verifies JWT via Auth0 JWKS (`jose.jwtVerify()`)
4. Worker looks up `public.users` by `auth0_id` (Auth0 subject identifier)
5. Worker resolves `user_roles → roles.permissions`, builds `AppSession`
6. `/api/me` returns `{ email, roles, permissions, allowedViews }` — no internal IDs

### Key Components

- **`worker/index.ts`** — JWKS JWT verification, auth middleware, permission enforcement on all `/api/*` routes, `/api/me`, `/api/activity`, `/api/admin/*`, `/api/logout`
- **`src/contexts/AuthContext.tsx`** — Auth0 session state, `/api/me` fetch with `MeResponseSchema.safeParse()`, `SIGNED_IN`/`SIGNED_OUT` activity hooks, proactive token refresh before expiry
- **`src/components/RequireAuth.tsx`** — route guard: unauthenticated → `/login`, unauthorized → access denied
- **`src/pages/LoginPage.tsx`** — Auth0 Universal Login redirect
- **`src/contexts/RoleContext.tsx`** — selected dashboard view mode, validated against `allowedViews` from authenticated session
- **`src/lib/validation/auth-schemas.ts`** — Zod schemas for all auth request/response types

### RBAC Model

Permissions live in `roles.permissions` (jsonb array). `user_roles` joins users to roles.

Permission strings:
```
dashboard.read | dashboard.executive | dashboard.operator | dashboard.auditor
dashboard.traces.read | dashboard.sessions.read | dashboard.agents.read
dashboard.pipeline.read | dashboard.compliance.read | dashboard.admin
```

`allowedViews` is derived server-side from permissions — the frontend role selector only shows views the user is permitted to access.

### Protected Routes

| Route | Required permission |
|---|---|
| `/api/dashboard` | `dashboard.read` + view-specific |
| `/api/metrics/:name`, `/api/trends/:name` | `dashboard.read` |
| `/api/traces/:traceId`, `/api/evaluations/trace/:traceId` | `dashboard.traces.read` |
| `/api/sessions/:sessionId` | `dashboard.sessions.read` |
| `/api/agents`, `/api/agents/detail/:agentId` | `dashboard.agents.read` |
| `/api/pipeline` | `dashboard.pipeline.read` |
| `/api/compliance/*` | `dashboard.compliance.read` |
| `/api/admin/*` | `dashboard.admin` |

### Cache Policy

- `/api/me`: `private, no-store`
- All other `/api/*`: `private, no-store` (changed from `public, max-age=300` in Phase 1)

### Activity Logging

Fire-and-forget writes to `user_activity` on: `login`, `logout`, `dashboard_view`, `trace_view`, `session_view`, `compliance_view`.

### Admin

`/api/admin/*` routes (gated by `dashboard.admin`): user list, role assign/revoke. Frontend: `AdminPage.tsx` with `AdminGuard` permission check.

---

## Zod Validation Schemas

All schemas in `src/lib/validation/auth-schemas.ts`. Updated for Auth0 migration (2026-03-26).

| Schema | Validates |
|---|---|
| `Auth0JwtPayloadSchema` | Auth0 JWT payload after `jose.jwtVerify()` (required: `sub`, `iss`, `aud`, `iat`, `exp`) |
| `PublicUserSchema` | `public.users` rows — lookup by `auth0_id` |
| `UserRoleRowSchema` | `user_roles` joined with `roles` (name + permissions[]) |
| `MeResponseSchema` | `/api/me` response (email, roles, permissions, allowedViews) |
| `ActivityRequestSchema` | POST `/api/activity` payload |
| `AdminRoleSchema`, `AdminUserRoleRowSchema`, `AdminUserSchema`, `AssignRoleRequestSchema` | Admin route payloads |

Removed on Auth0 migration: `AuthUserResponseSchema`, `AuthTokenResponseSchema`, `LoginRequestSchema`, `RefreshTokenRequestSchema` — all replaced by Auth0 SDK.

Integration: worker JWKS verification (`worker/index.ts`), `AuthContext.tsx` `/api/me` validation.

---

## DB State (as of 2026-03-26)

- 2 orphaned `public.users` rows deleted (no matching `auth.users`)
- 7 `auth.users`-only accounts provisioned into `public.users`
- `user_profiles.role` column dropped (denormalized, zero non-null rows)
- `auth0_id` column retained — correct name; holds Auth0 subject identifiers (`auth0|...`)
