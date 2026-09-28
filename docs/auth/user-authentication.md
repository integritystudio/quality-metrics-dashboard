## Status: Done (Auth0 migration 2026-03-26; org scoping P5/P6 live, `ORG_SCOPING_ENABLED = "true"`)

Auth0 Universal Login is the canonical identity provider. Supabase stores user records, org memberships and RBAC; all DB access via service role key (Auth0 JWTs cannot satisfy Supabase RLS).

Org-scoping design and phases: parent [`docs/roadmap/org-scoped-multi-tenancy.md`](../../../docs/roadmap/org-scoped-multi-tenancy.md).

---

## Architecture

### Identity Flow

1. User authenticates via Auth0 Universal Login (redirect flow)
2. Auth0 issues JWT; frontend obtains it via `@auth0/auth0-react` (`getAccessTokenSilently`)
3. Worker verifies JWT via Auth0 JWKS (`jose.jwtVerify()`, issuer + audience) and reads `sub` directly from the payload
4. Worker looks up `public.users` by `auth0_id` (Auth0 subject identifier); no row → 401
5. Worker resolves the session (see [Session Resolution](#session-resolution)) and builds `AppSession`
6. `/api/me` returns `{ email, roles, permissions, allowedViews }` plus, on org-scoped sessions, `activeOrg`, `memberships`, `role`, `isStaff` — no internal user IDs

### Session Resolution

With `ORG_SCOPING_ENABLED = "true"` the worker refuses to serve (500) if `HOME_ORG_ID` is empty.

1. **Active org** — first match wins:
   - `X-Org-Id` header (must be a UUID the user is a member of, or the user is staff; otherwise 403)
   - `users.default_organization_id`, re-validated against memberships
   - first membership
   - `HOME_ORG_ID` for staff with no membership
2. **Org path** — permissions derive only from the active org's `organization_memberships.role`, mapped in `src/lib/org-rbac.ts`. Staff (`STAFF_USER_IDS`, JSON array of app user UUIDs) resolve as `owner`.
3. **Legacy fallback** — a user with no membership but with `user_roles` rows resolves via the old global path (`user_roles → roles.permissions`, no org fields on the session). A user with neither gets 403 `No organization membership`.

| Membership role | Dashboard role | Permissions |
|---|---|---|
| `owner` | `owner` | all ten |
| `admin`, `billing_admin` | `admin` | all except `executive`/`operator`/`auditor` |
| `member` | `read` | `dashboard.read` |
| `viewer` | `e2e-dashboard-reader` | all except `dashboard.admin` |

### Key Components

- **`worker/index.ts`** — JWKS JWT verification, session resolution, permission enforcement on all `/api/*` routes, `/api/me`, `/api/org/switch`, `/api/activity`, `/api/admin/*`, `/api/logout`
- **`src/lib/org-rbac.ts`** — `DASHBOARD_ROLE_BY_MEMBERSHIP`, `PERMISSIONS_BY_DASHBOARD_ROLE`, `viewsForPermissions` (worker-safe; shared by worker, API server and frontend)
- **`src/contexts/AuthContext.tsx`** — Auth0 session state, `/api/me` fetch with `MeResponseSchema.safeParse()`, posts one `login` activity event per browser session
- **`src/contexts/OrgContext.tsx`** + **`src/lib/api-client.ts`** — active org state; every API request sends `X-Org-Id` through the shared api-client
- **`src/components/RequireAuth.tsx`** — route guard: unauthenticated → `/login`, unauthorized → access denied
- **`src/pages/LoginPage.tsx`** — Auth0 Universal Login redirect
- **`src/contexts/RoleContext.tsx`** — selected dashboard view mode, validated against `allowedViews` from authenticated session
- **`src/lib/validation/auth-schemas.ts`** — Zod schemas for auth request/response types

### RBAC Model

Permission strings:
```
dashboard.read | dashboard.executive | dashboard.operator | dashboard.auditor
dashboard.traces.read | dashboard.sessions.read | dashboard.agents.read
dashboard.pipeline.read | dashboard.compliance.read | dashboard.admin
```

`dashboard.admin` passes every `hasPermission` check. `allowedViews` is derived server-side:
- **Org path**: strictly from `dashboard.executive`/`operator`/`auditor` — no admin shortcut, so an org `admin` gets `[]` views but keeps data-route access
- **Legacy path**: `dashboard.admin` → all views; otherwise filtered by the same three permissions

### Protected Routes

| Route | Required permission |
|---|---|
| `/api/health` | none (skips auth) |
| `/api/dashboard` | `dashboard.read`; `?role=` must be in `allowedViews` |
| `/api/metrics/:name`, `/api/metrics/:name/evaluations`, `/api/trends/:name` | `dashboard.read` |
| `/api/correlations`, `/api/degradation-signals`, `/api/coverage`, `/api/calibration`, `/api/routing-telemetry` | `dashboard.read` |
| `/api/traces/:traceId`, `/api/evaluations/trace/:traceId` | `dashboard.traces.read` |
| `/api/sessions/:sessionId` | `dashboard.sessions.read` |
| `/api/agents`, `/api/agents/detail/:agentId`, `/api/agents/:sessionId` | `dashboard.agents.read` |
| `/api/pipeline` | `dashboard.pipeline.read` |
| `/api/compliance/sla`, `/api/compliance/verifications` | `dashboard.compliance.read` |
| `/api/admin/members*` | `dashboard.admin` + org-scoped session |
| `/api/admin/users*`, `/api/admin/roles` | staff only (under org scoping) |
| `/api/me`, `/api/org/switch`, `/api/activity`, `/api/logout` | any authenticated session |

### Org Switch

`POST /api/org/switch` (`OrgSwitchRequestSchema`): the target org must be one of the user's memberships (or the user is staff). Persists it as `users.default_organization_id` and returns the updated `/api/me` payload. Later requests carry the active org in `X-Org-Id`.

### Cache Policy

All `/api/*` responses: `Cache-Control: private, no-store`.

### Activity Logging

Fire-and-forget writes to `user_activity` (`USER_ACTIVITY_EVENTS` in `src/types/activity.ts`):
- **Client-posted** via `POST /api/activity` — accepts only `login`/`logout` (`FRONTEND_ACTIVITY_EVENTS`); `AuthContext` posts `login`
- **Worker-logged** — `logout` (`/api/logout`), `dashboard_view`, `trace_view`, `session_view`, `compliance_view` on the matching routes

### Admin

Admin mutations write to `audit_log`. Frontend: `AdminPage.tsx`, wrapped by `AdminGuard` (`src/App.tsx`).

- **Org-scoped** (`/api/admin/members`) — bound to `session.activeOrgId`, never a client parameter:
  - `GET /api/admin/members` — list members of the active org
  - `POST /api/admin/members/:userId/role` — change membership role (`member.role_change`)
  - `DELETE /api/admin/members/:userId` — remove member (`member.remove`)
  - Granting, changing or removing an `owner` membership requires `owner` or staff
- **Global** (`/api/admin/users`, `/api/admin/roles`, `/api/admin/users/:userId/roles[/:roleId]`) — legacy `user_roles` management (`role.assign`/`role.revoke`); staff only under org scoping, `dashboard.admin` when the flag is off

Upstream Supabase failures return a generic message with 500 so schema details never reach the client.

---

## Zod Validation Schemas

All schemas in `src/lib/validation/auth-schemas.ts`.

| Schema | Validates |
|---|---|
| `Auth0JwtPayloadSchema` | Auth0 JWT payload shape (`sub`, `iss`, `aud`, `iat`, `exp`) — defined but not currently used; the worker reads `sub` from the `jwtVerify()` payload directly |
| `PublicUserSchema` | `public.users` rows — lookup by `auth0_id` |
| `UserRoleRowSchema` | `user_roles` joined with `roles` (name + permissions[]) — legacy path |
| `OrgMembershipRoleSchema`, `DashboardRoleSchema` | membership role and derived dashboard role enums |
| `OrgMembershipRowSchema`, `OrgMembershipSummarySchema` | `organization_memberships` rows and their session summary |
| `OrgSwitchRequestSchema` | `POST /api/org/switch` payload |
| `MeResponseSchema` | `/api/me` response (email, roles, permissions, allowedViews; optional org fields) |
| `ActivityRequestSchema` | `POST /api/activity` payload |
| `AdminMemberRowSchema`, `AdminMemberSchema`, `UpdateMemberRoleRequestSchema` | org-scoped admin payloads |
| `AdminRoleSchema`, `AdminUserRoleRowSchema`, `AdminUserSchema`, `AssignRoleRequestSchema` | global admin payloads |

Removed on Auth0 migration: `AuthUserResponseSchema`, `AuthTokenResponseSchema`, `LoginRequestSchema`, `RefreshTokenRequestSchema` — all replaced by Auth0 SDK.

---

## DB State (historical, as of 2026-03-26 Auth0 migration)

- 2 orphaned `public.users` rows deleted (no matching `auth.users`)
- 7 `auth.users`-only accounts provisioned into `public.users`
- `user_profiles.role` column dropped (denormalized, zero non-null rows)
- `auth0_id` column retained — correct name; holds Auth0 subject identifiers (`auth0|...`); backfill verified complete 2026-09-27
