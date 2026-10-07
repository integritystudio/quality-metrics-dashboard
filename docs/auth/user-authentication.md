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
3. **No active org** — a non-staff user with no membership gets 403 `No organization membership` on every `/api/*` route but `/api/health`, whatever their `user_roles`. Until 2026-10-01 a user with `user_roles` rows fell back to the old global path and read the home org's bare keys; since the `on_user_created` trigger gives every new user a role, that meant every user who had not yet provisioned an org (`AUTH-NO-ORG-LEGACY-SESSION`). The global path (`user_roles → roles.permissions`, no org fields on the session) now applies only with `ORG_SCOPING_ENABLED` off.

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

- **Staff only, enforced elsewhere** (`/admin/customers*`) — the admin customer view (`StaffGuard`, `src/components/StaffGuard.tsx`) is gated on `session.isStaff`, not `dashboard.admin`, and reads api-gateway's `/v1/admin/orgs*` routes directly, which enforce the gateway's own `STAFF_USER_IDS` and write `admin.org_viewed` to `audit_log` there. This worker serves none of its data. See CLAUDE.md § Admin customer view.

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

## Dev tenant configuration (integration tests and dev Worker)

Moved verbatim from `CLAUDE.md` on 2026-10-06.

- Auth0 tenant: **dev** (`dev-njjmghdzm23uy0p7.us.auth0.com`), SPA `integritystudio-dashboard-dev` (`w4KMCpBAhSCnKjRlF7bWAycefJGwetya`). ROPC needs ALL of: `password` in `grant_types`, **`token_endpoint_auth_method: "none"`** (a `null` value makes the token endpoint demand client auth and every secret-less exchange fails `access_denied — Unauthorized` with an EMPTY `user_id` in the `fepft` log — the same generic error this tenant returns for a wrong password, so it is undiagnosable from the error body alone), `skip_consent_for_verifiable_first_party_clients: true` on the API, tenant default directory `Username-Password-Authentication`, and the connection enabled for the client. All set 2026-08-17; before that this suite had never run against the dev tenant. **Browser sign-in to the dev Worker** needs more than ROPC does: `https://quality-metrics-api-dev.alyshia-b38.workers.dev` (+ `/callback`) was added to the client's callbacks, logout URLs, allowed origins and web origins on 2026-10-06 — until then only the two localhost origins were listed and the first browser login there failed with "Callback URL mismatch". The same day **refresh token rotation was enabled on the client** (rotating, expiring, 30 d / 15 d idle, leeway 0): the SPA's `useRefreshTokens` asks for `offline_access`, and Auth0 issues no refresh token to a public client without rotation, so the code exchange failed (`feacft`, "Failed to exchange a Rotating Refresh Token when Refresh Token Rotation is not enabled"; the UI said "Unknown or invalid refresh token"). ROPC never needed either setting, which is why both went unnoticed. *The prior claim here — ROPC enabled on the production SPA `CNfd6xPPr2aLmvNyiearhmaLknAYvtnq` — is stale: that client has no `password` grant today.*
