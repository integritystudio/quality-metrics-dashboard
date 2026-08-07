# Quality Metrics Dashboard

React 19 + Vite 8 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. Auth: Auth0 Universal Login with role-based access control backed by Supabase DB.

## Commands

```bash
npm run dev          # Vite + Hono API on :3001
npm run dev:worker   # wrangler dev (local Worker)
npm test             # Vitest — src/__tests__ + worker/__tests__
npm run test:scripts # Vitest for scripts/ (separate config)
npm run typecheck    # TS 7 — use this, NOT bare `npx tsc` (see TypeScript versions)
npm run typecheck:scripts    # TS 7 against scripts/ (tsconfig.scripts.json)
npm run lint         # ESLint (src/, scripts/, worker/)
npm run build        # Production build
npm run populate -- --seed   # Data pipeline (offline)
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
- **Styling**: No inline styles — use CSS classes defined in `src/theme.css` or component-level selectors. Never pass `style={{...}}` props.
- **React Compiler**: `babel-plugin-react-compiler` is installed but NOT configured (not wired into vite.config.ts). The compiler is inactive. For TanStack Table incompatibilities, use `// eslint-disable-next-line react-hooks/incompatible-library -- <reason>` (see `EvaluationTable.tsx:188`).

## Dependencies

Key libraries:
- **`d3-array`** — aggregation (`group`, `rollup`, `ascending`); preferred over custom groupBy
- **`p-limit`** — concurrency control for parallel operations (API calls, aggregations)
- **`recharts`** — charting; replaces custom D3 visualizations
- **`@xyflow/react`** — workflow DAG visualization
- **`jose`** — Auth0 JWKS JWT verification in worker

## Constants Architecture

Two constants files with a hard module boundary — do not cross-import:
- **`src/lib/constants.ts`** — frontend + API server shared; uses `import.meta.env` (Vite). Imported by React components, hooks, and Hono API routes.
- **`src/api/api-constants.ts`** — API server only (Node context). Imported by `src/api/routes/` and `scripts/`. Cannot be imported in Vite-rendered code.
- **`worker/index.ts`** — has its own local `Http` constants object; cannot import either file above safely.

Score display precision constants (use these, never raw `.toFixed()` literals):
- `SCORE_CHIP_PRECISION = 2` — compact chips/cells
- `SCORE_DISPLAY_PRECISION = 3` — standard display
- `SCORE_FORMAT_PRECISION = 4` — raw value formatting

## Data Pipeline (`scripts/`)

`npm run populate` runs: derive → judge → sync-to-kv

- `derive-evaluations.ts` — rule-based metrics (tool_correctness, evaluation_latency, task_completion)
- `judge-evaluations.ts` — LLM-based metrics (relevance, coherence, faithfulness, hallucination)
- `sync-to-kv.ts` — delta sync aggregates to Cloudflare KV (priority: meta/agent > metrics > trends > traces)

Requires parent `dist/` — run `npm run build` in observability-toolkit first.

**`sync-to-kv.ts` notes** (the three former gotchas were fixed 2026-07-28/29 — see the parent's [v3.1.5 changelog](../docs/changelog/3.1.5/CHANGELOG.md), not BACKLOG):
- It reads the **cloud API**, not local files — `new CloudBackend()` → `/v1/traces` + `/v1/logs`. Needs `OBTOOL_API_URL`/`OBTOOL_API_KEY` or it exits 1. (Still true.)
- Reads auto-paginate past the 1000-row server cap — `CloudBackend.fetchAllPages` follows cursors until exhausted or the caller's `limit` is hit, so aggregates are **not** capped at 1000 (`CLOUD-PAGE-CAP`). Consequence: a `count >= 1000` means "more than one page", **not** "rows were dropped" — test truncation against the `limit` you passed.
- Logs a run summary (computed/changed/unchanged/written/deferred, per-signal row counts, page-cap warning) (`SYNC-SILENT`).
- `--dry-run` no longer mutates state: `saveSyncState`, `saveLastCoverage`, and degradation writes are gated on `!dryRun`, and all three sidecars are gitignored (`SYNC-DRYRUN-STATE`).

A Workflow alternative lives at `services/kv-sync-workflow/` in the parent repo — partial coverage, not deployed.

**Test note**: `npm test` runs `src/__tests__` **and** `worker/__tests__` (Vite context). Script tests (`scripts/*.test.ts`) require parent `dist/` and are run separately with `npm run test:scripts`. CI narrows to `npm test src/` (`.github/workflows/ci.yml`, `deploy.yml`) to avoid script-test failures on the parent build dependency — so `worker/__tests__` runs locally but **not** in CI.

## Worker types

`@cloudflare/workers-types` is declared once, in root `tsconfig.json` `compilerOptions.types`. Do not re-add `/// <reference types="@cloudflare/workers-types" />` to individual files. Before 2026-07-28 there was no tsconfig declaration at all and coverage came from two stray triple-slash references — one of them in `src/__tests__/api-calibration.test.ts`, meaning production worker types were underwritten by a test file. `worker/tsconfig.json` was deleted in the same change (nothing invoked it; eslint and typecheck both use root `tsconfig.json`, and wrangler only reads `main` from `wrangler.toml`).

To verify the declaration is load-bearing: remove it from `tsconfig.json` and `npm run typecheck` should report ~14 errors (`Cannot find name 'KVNamespace'` / `'ExecutionContext'`).

## E2E (`e2e/`, chromium project)

`playwright.config.ts` starts **two** webServers — `tsx src/api/server.ts` gated on `/api/health`, and `vite` gated on the page URL. It previously ran a single `npm run dev` and waited only on vite, so specs started against a dead `/api` proxy and failed with 502s. The API port comes from `src/api/config.ts`, not a literal.

- `vite.config.ts:48` still hardcodes the proxy target `http://127.0.0.1:3001`, so setting `API_PORT` desyncs the gate from the proxy.
- Most e2e specs still fail for a **different** reason: the local API reports `hasData: false` (all 9 metrics `no_data`), so anything asserting on rendered metric content cannot pass. Seed with `npm run populate -- --seed`.
- `GET /api/agents` returns 500 locally — a real bug the readiness fix uncovered, previously masked as a 502.

## Integration Tests (`e2e/integration/`)

Run against the deployed worker with a real Auth0 JWT. Requires Doppler dev config.

- **Setup** (`setup.ts`): acquires Auth0 JWT via ROPC (`VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `AUTH0_TEST_EMAIL/PASSWORD`), upserts `public.users`, assigns `e2e-dashboard-reader` role
- **Teardown** (`teardown.ts`): removes `user_roles`, `user_activity`, `public.users` row — Auth0 user is permanent, never deleted
- **Sentry** (`sentry-reporter.ts`): captures `failed`/`timedOut` tests to Sentry (`SENTRY_DSN` from Doppler); no-ops if unset
- Auth0 tenant: `dev-68gg87ow4mg4kzyo.us.auth0.com`, `password` grant enabled on `integritystudio-dashboard` SPA (`CNfd6xPPr2aLmvNyiearhmaLknAYvtnq`); default directory set to `Username-Password-Authentication`

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
- **Vite proxy**: `/api/*` → `http://127.0.0.1:3001` — local dev auto-forwards API requests to the Hono server; no CORS config needed.

## Linting

ESLint configuration (`eslint.config.mjs`) uses `@typescript-eslint/recommendedTypeChecked` with per-context strictness:
- **`src/` and `worker/`**: strict enforcement (errors)
- **`scripts/` and `src/__tests__/`**: warnings (allow passing tests while improving code)

Run `npm run lint` to check `src/`, `scripts/`, and `worker/`. TypeScript type-aware rules enforce proper async handling, type assertions, and void floating promises.

## Deployment

Two Cloudflare Workers serve the dashboard API (same KV namespace):
- `quality-metrics-api` — production
- `obs-toolkit-quality-metrics-api` — wrangler.toml default

Deploy both after worker changes:
```bash
npx wrangler deploy
npx wrangler deploy --name quality-metrics-api
```
