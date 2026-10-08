# Quality Metrics Dashboard

React 19 + Vite 8 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. Auth: Auth0 Universal Login with role-based access control backed by Supabase DB.

## Commands

```bash
npm run dev          # Vite + Hono API on :3001
npm run dev:worker   # wrangler dev (local Worker)
npm test             # Vitest — src/__tests__ + worker/__tests__
npm run test:scripts # Vitest for scripts/ (separate config)
npm run typecheck    # TS 7 — use this, NOT bare `npx tsc` (see TypeScript versions)
npm run typecheck:scripts    # TS 7 against scripts/ (tsconfig.scripts.json); add `-- --pretty false` for greppable output
npm run lint         # ESLint (src/, scripts/, worker/)
npm run build        # Production build
npm run populate -- --seed   # Data pipeline (offline, synthetic judge scores)
npm run populate             # Data pipeline (real judge; needs LLM_JUDGE_ANTHROPIC_KEY or ANTHROPIC_API_KEY)
npm run test:e2e             # Playwright, chromium project (Auth0 stubbed; see E2E)
npm run sync                 # KV sync only (--budget=450 default)
npm run deploy:worker        # Deploy Cloudflare Worker
doppler run --project integrity-studio --config dev -- npm run test:e2e:integration  # Auth0 integration tests
```

## TypeScript versions (7 + 6 side-by-side)

Two TypeScripts are installed because typescript-eslint throws at import on TS >= 7 ([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)):
- `typescript7` (`npm:typescript@^7.0.2`) — compiles; used by the `typecheck` scripts
- `typescript` (`npm:@typescript/typescript6@^6.0.2`) — TS 6 API re-export; what `require('typescript')` gives typescript-eslint

**`npx tsc` is TS 6, not 7** — npm gave the `tsc` bin to the TS 6 package. Run `npm run typecheck`, which calls `node node_modules/typescript7/bin/tsc` explicitly. (`npx tsc6` is also TS 6.) Collapse back to one `typescript` dep once typescript-eslint supports TS 7.

The parent observability-toolkit is unaffected — it has its own `node_modules` on TS 6 and builds independently.

## Architecture

- **Frontend**: `src/` — React 19 + Vite 8, React Router, Auth0 React SDK (`@auth0/auth0-react`)
- **API server**: `src/api/` — Hono server on :3001, reads from Cloudflare KV via worker
- **Worker**: `worker/index.ts` — Auth0 JWKS JWT verification via `jose`, KV read-through cache, protected `/api/*` routes
- **Auth**: Auth0 Universal Login + role-based permissions from Supabase `user_roles -> roles.permissions` (all DB access via service role key). See [docs/auth/user-authentication.md](docs/auth/user-authentication.md)
  - **Default role = `provisioned-dashboard-viewer`** (all views, non-admin). Assigned two ways: the `on_user_created`/`assign_default_role()` DB trigger on signup, and `grantDashboardAccess` in the api-provisioning-receiver worker at API-key provisioning (insert-or-ignore dedupes). Replaced the former `read` role (PROV-RBAC, 2026-07-17).
  - **Migration caveat**: the migration capturing this (`IntegrityLandingPage/supabase/migrations/20260717000000_provisioned_dashboard_viewer_default_role.sql`) was authored to mirror a state already applied directly to **prd**, so it has NOT been run through the migration tooling (it's a no-op on prd). Applying migrations to other environments (staging/fresh) will bring them into line there.
- **Validation**: Zod schemas in `src/lib/validation/` for all auth and dashboard types
- **Org scoping** (`ORG_SCOPING_ENABLED = "true"` in `wrangler.toml`): `OrgContext.tsx` holds the active org and `OrgSwitcher.tsx` changes it through `POST /api/org/switch`, which persists `default_organization_id` and returns an updated `me` payload. `src/lib/org-rbac.ts` maps an org membership role to a dashboard role and that role to its permissions.
- **Styling**: No inline styles — use CSS classes defined in `src/theme.css` or component-level selectors. Never pass `style={{...}}` props.
- **React Compiler**: `babel-plugin-react-compiler` is installed but NOT configured (not wired into vite.config.ts). The compiler is inactive. If `react-hooks/incompatible-library` flags a TanStack Table hook, suppress it with `// eslint-disable-next-line react-hooks/incompatible-library -- <reason>` (none are needed since the v9 migration).

## Dependencies

Key libraries:
- **`d3-array`** — aggregation (`group`, `rollup`, `ascending`); preferred over custom groupBy
- **`p-limit`** — concurrency control for parallel operations (API calls, aggregations)
- **`recharts`** — charting; replaces custom D3 visualizations
- **`@xyflow/react`** — workflow DAG visualization
- **`jose`** — Auth0 JWKS JWT verification in worker

## Constants Architecture

Two constants files with a hard module boundary — do not cross-import:
- **`src/lib/constants.ts`** — frontend + API server shared. Imported by React components, hooks, and Hono API routes.
- **`src/api/api-constants.ts`** — API server only (Node context). Imported by `src/api/routes/` and `scripts/`. Cannot be imported in Vite-rendered code.
- **`worker/index.ts`** — has its own local `Http` constants object; cannot import either file above safely.

Score display precision constants (use these, never raw `.toFixed()` literals):
- `SCORE_CHIP_PRECISION = 2` — compact chips/cells
- `SCORE_DISPLAY_PRECISION = 3` — standard display
- `SCORE_FORMAT_PRECISION = 4` — raw value formatting

## Data Pipeline (`scripts/`)

`npm run populate` runs: derive → judge → upload → sync-to-kv

Per-stage detail, exit codes and history: [`docs/data-pipeline.md`](docs/data-pipeline.md). The rules:

- **`derive-evaluations.ts`** — rule-based metrics (tool_correctness, evaluation_latency, task_completion). Reads `/v1/traces` over 7 days and POSTs the last 2 (`--source=cloud --days=7 --post-days=2`, `DERIVE_DEFAULT_*` in `pipeline-stages.ts`); writes no file. Never posts a record dated before 2026-09-28 (`DERIVE_NO_REPOST_BEFORE_MS`; older D1 rows have no `evaluation_id`, so a re-post duplicates). Backfill with `--date=`/`--days=`. Exit 10 (`DERIVE_EXIT_INPUT_DRIFT`) means a hooks-side rename, not a flake.
- **`judge-evaluations.ts`** — LLM metrics (relevance, coherence, faithfulness, hallucination). Consolidated scoring (one call per turn) is the default; `--per-criterion` costs ~10x, `--batch` halves it. Key precedence `LLM_JUDGE_ANTHROPIC_KEY` → `ANTHROPIC_API_KEY`. Discovery is `--source=cloud --days=7`; turn text stays local. Dedup runs before `--limit`, keyed per criterion and per judge model. On the per-criterion path faithfulness and hallucination come from one QAG sweep and **do not sum to 1**.
- **`upload-evaluations.ts`** — ships the records only it delivers (`hook:stop-session-summary`, `hook:stop-quality-evaluation`, `survival-fitness`) to the cloud `evaluations` table over the HMAC webhook. **Load-bearing**: sync reads the cloud, so skipping it leaves the dashboard on `no_data` while every stage reports success. Needs `INJECT_HMAC_SECRET`. Dedup uses a content fingerprint plus `evaluationId`; the id keeps `spanId` and the fingerprint does not, so don't swap them.
- **`sync-to-kv.ts`** — delta sync aggregates to Cloudflare KV (priority: meta/agent > metrics > trends > traces).
- **Exit codes 6–11 are soft**: `populate` retries network failures (~30 min) and carries on to the next stage. Re-running any stage is safe; ingest drops ids the org already has.

**Segment judge series on producer, judge model and date.** `dashboard:judge-consolidated` and `dashboard:judge-evaluations` (the record's `evaluator` field) score faithfulness and hallucination differently, and everything else on the record is identical. Records before 2026-09-22 all carry `dashboard:judge-evaluations` whichever path produced them. The judge model is a top-level `judgeModel` field since 2026-09-30.

Full run with its Doppler env: `bash ../scripts/run-dashboard-pipeline.sh`. **A launchd agent does schedule it** — `ai.integritystudio.dashboard-pipeline` fires the wrapper at 06:00 and 18:00 local with `--limit 100` and `--batch` (`~/.local/bin/dashboard-pipeline.sh`, tracked at `../scripts/launchd/`); the long-dead state described by `DASHBOARD-PIPELINE-DEAD` ended when that agent was loaded. `--dry-run` prices a run without spending, and its estimate quotes list rates, so it reads high against a `--batch` run's actuals.

Requires parent `dist/` — run `npm run build` in observability-toolkit first.

**`sync-to-kv.ts` notes** (the three former gotchas were fixed 2026-07-28/29 — see the parent's [v3.1.5 changelog](../docs/changelog/3.1.5/CHANGELOG.md), not BACKLOG):
- It reads the **cloud API**, not local files — `new CloudBackend()` → `/v1/traces` + `/v1/logs`. Needs `OBTOOL_API_URL`/`OBTOOL_API_KEY` or it exits 1. (Still true.)
- Reads auto-paginate past the 1000-row server cap — `CloudBackend.fetchAllPages` follows cursors until exhausted or the caller's `limit` is hit, so aggregates are **not** capped at 1000 (`CLOUD-PAGE-CAP`). Consequence: a `count >= 1000` means "more than one page", **not** "rows were dropped" — test truncation against the `limit` you passed.
- Logs a run summary (computed/changed/unchanged/written/deferred, per-signal row counts, page-cap warning) (`SYNC-SILENT`).
- `--dry-run` no longer mutates state: `saveSyncState`, `saveLastCoverage`, and degradation writes are gated on `!dryRun`, and all three sidecars are gitignored (`SYNC-DRYRUN-STATE`).

A Workflow alternative lives at `services/kv-sync-workflow/` in the parent repo — partial coverage, not deployed.

**Test note**: `npm test` runs `src/__tests__` **and** `worker/__tests__` (Vite context). Script tests (`scripts/*.test.ts`) require parent `dist/` and are run separately with `npm run test:scripts`. CI narrows to `npm test src/` (`.github/workflows/ci.yml`, `deploy.yml`) to avoid script-test failures on the parent build dependency — so `worker/__tests__` runs locally but **not** in CI.

## Admin customer view (`/admin/customers`)

A staff-only clone of the Flutter customer dashboard (IntegrityLandingPage `lib/pages/{dashboard,billing_status,usage_summary,quota_status,entitlements}_page.dart`) for **any** org: hub, Billing, Usage, Quota, Entitlements (ADMIN-CUSTOMER-VIEW, 2026-10-06). Read-only by construction — no portal, checkout or key routes are ever called.

- **It reads api-gateway, not this app's worker.** `src/lib/gateway.ts` calls `GET /v1/admin/orgs` and `/v1/admin/orgs/:id/{billing-status,usage/summary,quota/status,entitlements}` on `VITE_API_GATEWAY_URL` (Doppler: `prd` → `https://api.integritystudio.dev`, which is also the code default; `dev` → `api-gateway-dev`; `deploy.yml` exports the prd value beside the `VITE_AUTH0_*` ones, and a dev Worker build needs `doppler run --config dev -- npm run build` so the dev tenant and dev gateway are embedded together) with `Authorization` only — never through `apiFetch`, whose `X-Org-Id` the gateway's CORS refuses and which means nothing there (the viewed org is in the path). Same Auth0 token, same audience, no second login. Those gateway routes are IntegrityLandingPage CR63 (`workers/api-gateway/src/routes/admin.ts`); they are unmetered and enforce `STAFF_USER_IDS` themselves.
- **Gate = `isStaff`, never `dashboard.admin`** (`StaffGuard`, `StaffCustomersLink`): every customer org owner holds `dashboard.admin` under org scoping. The client gate is presentation; the gateway's list is the enforcement, and the two `STAFF_USER_IDS` lists (this repo's `wrangler.toml`, the gateway's) drift unless changed together.
- **The org is the URL**: `/admin/customers?org=<id>` on the hub, `/admin/customers/<id>/<screen>` on the screens, so reloads and deep links work and sub-pages return to the hub with the org kept (`PageShell` `backHref`/`backLabel`, defaults unchanged for every other caller). Choosing an org on the hub never calls `POST /api/org/switch`; the Observability card does, deliberately — it is how staff reach a non-member org's observability at all.
- **Parity is pinned, not assumed**: `src/lib/admin-customer-strings.ts` + `-constants.ts` hold every shared string and threshold with its Dart citation; `admin-customer-parity.test.ts` fails if either side moves. Deliberate deviations: org name + id in every header, the billing CTA as a read-only label, and a "Quota not initialized" line on the uninitialized quota. **The Usage page follows the Flutter page as it is after CR52** (usage bar from the enforced quota, 30 s poll of both reads, a plan-less quota refused so the last accepted one stays) — the backlog's "always `monthlyUnitsQuota: 0`" quirk predates that and is stale.
- **Hooks use `useQuery` directly**, keyed `['admin-customer', …]`, with `DashboardService`'s error wording and retry policy (`GatewayError`; two retries on 500/504/transport, none otherwise). Tests: `admin-customer-{helpers,schemas,hooks,parity}.test.*`, `AdminCustomerPages.test.tsx` (real query stack, real `OrgProvider`, memory router, fake gateway in `__tests__/support/fake-gateway.ts`), and `e2e/admin-customers.spec.ts` (gateway answered by `page.route`; `.env.test` points `VITE_API_GATEWAY_URL` at an unroutable host so a miss is loud).

## Worker types

`@cloudflare/workers-types` is declared once, in root `tsconfig.json` `compilerOptions.types`. Do not re-add `/// <reference types="@cloudflare/workers-types" />` to individual files, and there is no `worker/tsconfig.json` (eslint and typecheck use the root one). Removing the declaration should make `npm run typecheck` report ~14 errors (`Cannot find name 'KVNamespace'`).

## E2E (`e2e/`, chromium project)

`playwright.config.ts` starts **two** webServers — `tsx src/api/server.ts` gated on `/api/health`, and `vite --mode test` gated on the page URL. It previously ran a single `npm run dev` and waited only on vite, so specs started against a dead `/api` proxy and failed with 502s. The API port comes from `src/api/config.ts`, not a literal.

- The Vite proxy target also comes from `src/api/config.ts`, so `API_PORT` moves the health gate and the proxy together.
- **`--mode test` is load-bearing**: `src/lib/auth0.ts` throws at import without `VITE_AUTH0_*`, and plain `vite` loads `.env` — untracked, so present only on developer machines. Test mode loads the tracked `.env.test` placeholders, which suffice because the SDK is stubbed under `VITE_E2E=1`.
- **Never wrap an e2e run in `doppler run`** — the webServer's `tsx` child then never binds its port, and Playwright does *not* fail the health gate: it proceeds, and every API-backed spec fails against a dead proxy (`ECONNREFUSED 127.0.0.1:3001`). Export `OBTOOL_API_URL`/`OBTOOL_API_KEY` via `doppler secrets get … --plain` instead.
- Seven specs assert on rendered metric content and **skip themselves** when `/api/health` reports `hasData: false` (worker-scoped fixture in `e2e/fixtures.ts`). Expect **36 passed / 7 skipped**.
- **Lifting the skips needs evaluations in the cloud table**, not KV: `hasData` is `checkHealth()` asking the cloud API for ≥1 evaluation in 7 days. A plain `npm run populate` under `doppler run` does it after a few minutes (ingest → R2 → `*/5` flush → D1), but writes **production** telemetry unless `DEV_ORG_ID` scopes it. `--seed` does not lift them honestly: its synthetic scores land in real aggregates. Detail: [`docs/data-pipeline.md`](docs/data-pipeline.md#e2e-data-skips-and-the-pipeline).

## Integration Tests (`e2e/integration/`)

Run against the deployed worker with a real Auth0 JWT. Requires Doppler dev config.

- **Setup** (`setup.ts`): acquires Auth0 JWT via ROPC (`VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `AUTH0_TEST_EMAIL/PASSWORD`), upserts `public.users`, assigns `e2e-dashboard-reader` role
- **Teardown** (`teardown.ts`): removes `user_roles`, `user_activity`, `public.users` row — Auth0 user is permanent, never deleted
- **Sentry** (`sentry-reporter.ts`): captures `failed`/`timedOut` tests to Sentry (`SENTRY_DSN` from Doppler); no-ops if unset
- Auth0 tenant: **dev** (`dev-njjmghdzm23uy0p7.us.auth0.com`), SPA `integritystudio-dashboard-dev` (`w4KMCpBAhSCnKjRlF7bWAycefJGwetya`). The production SPA has no `password` grant.
- ⚠️ **A misconfigured client fails with the same `access_denied — Unauthorized` as a wrong password.** ROPC needs `token_endpoint_auth_method: "none"` (not `null`), the `password` grant, consent skip on the API and the connection enabled. Browser sign-in to the dev Worker also needs its origin in the client's URLs and refresh token rotation on. Full settings and symptoms: [`docs/auth/user-authentication.md` § Dev tenant configuration](docs/auth/user-authentication.md#dev-tenant-configuration-integration-tests-and-dev-worker).

## Parent boundary (`src/api/parent/`)

All parent observability-toolkit code enters through three sanctioned surfaces — everything else is an eslint `no-restricted-imports` **error** (relative `dist/` paths banned everywhere; `@parent` banned outside these files):

- **`src/api/parent/*.ts`** — re-export-only runtime barrels (Node-only), one per parent module, named after it (`quality-metrics.ts`, `error-sanitizer.ts`, `query-traces.ts`, …). Routes and `data-loader.ts` import from these, never from `@parent` directly. Tests mock the barrel path (`vi.mock('../api/parent/quality-metrics.js', …)`) — no vite virtual-module tricks needed.
- **`src/types.ts`** — the type facade. All parent *types* re-export here (`EvaluationResult`, `TraceSpan`, `LogRecord`, `StepScore`, `MetricTrend`, …); frontend and API code import types from it, keeping type-only deps out of the runtime barrels.
- **`src/lib/validation/dashboard-schemas.ts`** — the Zod schema boundary (pre-existing).

`scripts/` are excepted: they may use `@parent` directly (their tsconfig/vitest configs alias it), but relative `dist/` paths are banned there too. Package deep-imports like `@xyflow/react/dist/style.css` are unaffected. Adding a new parent dependency = add one line to the matching barrel (or a new barrel named after the parent module) or to `types.ts` — the whole parent surface is greppable in one directory.

## Aliases & Stubs (`src/stubs/`)

- **`@parent`** → `../dist` — imports from the parent observability-toolkit build, allowed only in the boundary files above. Run `npm run build` in `..` first or tests will fail without the `parentDistStub` vite plugin (active in Vitest only), which stubs `@parent` to empty modules when `../dist` is absent (standalone CI).
- **`web-worker`** → `src/stubs/web-worker.ts` — always aliased; prevents bundler errors for worker imports.
- **`VITE_E2E=1`** → stubs `@auth0/auth0-react` with `src/stubs/auth0-e2e.ts` for Playwright E2E runs.
- **Vite proxy**: `/api/*` → the local Hono server (`src/api/config.ts`), or a deployed Worker when `API_PROXY_TARGET` is set (shell or `.env`; no `VITE_` prefix, so it never reaches the bundle). The SPA always calls `/api` on its own origin, so neither the Worker nor the local server allows a localhost CORS origin.

## Linting

ESLint configuration (`eslint.config.mjs`) uses `@typescript-eslint/recommendedTypeChecked` with per-context strictness:
- **`src/` and `worker/`**: strict enforcement (errors)
- **`scripts/` and `src/__tests__/`**: warnings (allow passing tests while improving code)

Run `npm run lint` to check `src/`, `scripts/`, and `worker/`. TypeScript type-aware rules enforce proper async handling, type assertions, and void floating promises.

## Deployment

Three Cloudflare Workers serve the dashboard API. The two production ones share a KV namespace:
- `quality-metrics-api` — production
- `obs-toolkit-quality-metrics-api` — wrangler.toml default
- `quality-metrics-api-dev` — dev, from the `[env.dev]` block; own KV namespace and the **dev** Auth0 tenant (`dev-njjmghdzm23uy0p7`)

Deploy all three after worker changes. **Each deploy uploads whatever `dist/` holds as the SPA**, and the tenant is baked in at build time, so build under the matching Doppler config first — a production build deployed to `--env dev` serves a SPA that logs in to the production tenant while the dev Worker verifies against the dev one (every browser login then 401s; seen 2026-10-08):
```bash
doppler run --project integrity-studio --config prd -- npm run build
npx wrangler deploy
npx wrangler deploy --name quality-metrics-api
doppler run --project integrity-studio --config dev -- npm run build
doppler run --project integrity-studio --config dev -- npx wrangler deploy --env dev
```

`AUTH0_DOMAIN` is a plaintext var, so it does **not** follow `--config dev` — that is the entire reason `[env.dev]` exists. See the parent repo's CLAUDE.md § Deployment — Dashboard Workers.
