# v3.0.4 (2026-03-20)

Auth hardening and backlog resolution: removed PII leakage in /api/me, consolidated auth types, and fixed route configuration issues.

## Phase 1 Implementation (Security Hardening & Session Management)

| ID | Title | Notes |
|----|----------|-------|
| AUTH-1 | Fix unsafe `AppSession` cast in `fetchAppSession` | Added VALID_PERMISSIONS Set, element-by-element validation, and type guard. Commit: 894b73b. See `src/contexts/AuthContext.tsx`. |
| AUTH-2 | Fix `RequireAuth` loading state | Changed from `null` (blank flash) to `<div className="auth-loading">`. Commit: 0963fc5. See `src/components/RequireAuth.tsx`. |
| AUTH-3 | Gate protected queries on token availability | Added immediate `AUTH_REQUIRED` error when no session; prevents tokenless requests and wasted retries. Commit: 46f2f16. See `src/hooks/useApiQuery.ts:44–49`. |
| AUTH-4 | Add automatic token refresh on 401 | Implements single refresh-and-retry on 401 response; prevents infinite retry loops on expired tokens. Commit: a3b8acf. See `src/hooks/useApiQuery.ts:54–62`. |
| AUTH-6 | Silent `appUserId` fallback on `public.users` lookup failure | Now returns 401 instead of zero-permission session. Added ID cross-check `users[0].id !== authUserId`. Commit: 6ae89a6. See `worker/index.ts:140–145`. |
| AUTH-7 | `LoginPage` doesn't restore originally requested route | Captures current path in RequireAuth, encodes as `?redirect=` param, validates with `safeRedirectPath()`. Commit: a7599cc. See `src/pages/LoginPage.tsx:8–10`, `src/components/RequireAuth.tsx`. |
| AUTH-8 | Validate `AuthTokenResponse` shape before casting | Added `isValidTokenResponse()` type guard; validates all fields before casting in `signIn()` and `refreshSession()`. Commit: ef6e26d. See `src/lib/supabase.ts:80–91`. |
| AUTH-9 | `getSession()` reads + JSON-parses `localStorage` on every query | Implemented module-level `cachedSession` with save/clear sync; cache-first pattern with 60s expiry eviction. Commit: f827358. See `src/lib/supabase.ts:29–111`. |
| AUTH-12 | Add token length check before header interpolation | Added guard `if (!session.access_token) throw new Error('AUTH_REQUIRED')` to prevent empty Bearer headers. Commit: beae4b7. See `src/hooks/useApiQuery.ts:49`. |
| AUTH-13 | Add `localhost` to CORS policy for local dev | Added `'http://localhost:5173'`, `'http://localhost:3000'` to CORS origins. Commit: beae4b7. See `worker/index.ts:14–16`. |
| AUTH-15 | Input validation on `name` path params in metrics/trends routes | Added `[\w:.-]+` / 200-char guard to `/api/metrics/:name`, `/api/trends/:name` routes; consistent with other param validation. Commit: 398d6eb. See `worker/index.ts:78–82`. |
| AUTH-16 | Add explanatory comment on CORS `allowMethods: ['GET']` | Documents read-only design and CSRF prevention rationale for future maintainers. Commit: beae4b7. See `worker/index.ts:19–21`. |
| AUTH-17 | Parallelize and timeout Supabase fetches in auth middleware | Added `AUTH_TIMEOUT_MS = 5000` with `AbortController` to all three auth fetches (JWT verify, public.users, user_roles). Commit: beae4b7. See `worker/index.ts:97–109`. |

## Fixes

| ID | Title | Notes |
|----|----------|-------|
| AUTH-5 | Remove internal user IDs from /api/me response | `authUserId` and `appUserId` are server-side only; removed from MeResponse type and worker response. Commit: 6c4b10a. See `src/types/auth.ts:23` and `worker/index.ts:124–134`. |
| AUTH-10 | Consolidate `MeResponse` and `AppSession` types | Changed `MeResponse extends AppSession` to explicit field definition. Eliminates type drift and clarifies API contract. Commit: fedb21d. See `src/types/auth.ts:23–26`. |
| AUTH-11 | Remove pathless catch-all route wrapper | Deleted redundant outer `<Route>` that could accidentally break if inner routes reordered. Commit: fedb21d. See `src/App.tsx:266`. |
| AUTH-14 | CORS `allowMethods` simplified to `['GET']` | POST verb removed from CORS config to match /api/me conversion from POST to GET. Commit: fedb21d. See `worker/index.ts:23`. |

## Workflow Visualization Backlog

| ID | Title | Notes |
|----|----------|-------|
| G5-WG4 | Remove unused `_agentMap` parameter | `_agentMap` in `buildWorkflowGraph` was unused — removed. |
| G5-WG10 | Test suite refactoring — `beforeAll` extraction | Test suite was rebuilding graph in every `it` block; refactored to extract setup to `beforeAll` or describe-scope const. |
| G5-L1 | CommonJS → ES module consistency | Test mock switched from `require('react')` to `vi.importActual` for ES module consistency. |
| G5-L2 | Empty state for workflow missing graph | Added empty state rendering when `data` present but `graph` absent in WorkflowPage. |

## Summary

- **Items resolved**: 21 (AUTH-1–4, AUTH-6–9, AUTH-12–13, AUTH-15–17, AUTH-5, AUTH-10–11, AUTH-14, G5-WG4, G5-WG10, G5-L1–L2)
- **Code changes**: 14 commits — auth phase 1 implementation with session management, token refresh, route validation, CORS hardening, and test refactoring
- **Breaking changes**: MeResponse type structure changed (removed authUserId/appUserId fields)
- **Security**: Removed PII leakage from API, type-safe permission validation, timeout protection on auth middleware, input validation on all path params
