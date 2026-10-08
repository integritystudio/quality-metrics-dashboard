# Quality Metrics Dashboard

v3.0.9

React 19 + Vite 8 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. **Auth: Auth0 Universal Login with role-based access control backed by Supabase DB.**

## Quick Start

```bash
npm install
npm run dev          # Vite + Hono API on :3001
```

## Authentication

The dashboard uses **Auth0 Universal Login** for sign-in and **JWKS JWT verification** on the worker. Supabase remains the application database.

- **Login**: Auth0 Universal Login redirect from `/login` (PKCE flow)
- **Token management**: Auth0 React SDK (`@auth0/auth0-react`) — silent refresh via `getAccessTokenSilently`
- **Token injection**: All data hooks include `Authorization: Bearer <token>` header
- **Worker verification**: JWT verified via Auth0 JWKS (`jose` — `createRemoteJWKSet` + `jwtVerify`), no Supabase Auth dependency
- **User lookup**: Worker looks up `public.users` by `auth0_id` using Supabase service role key
- **Validation**: Request/response types validated using Zod schemas (`src/lib/validation/auth-schemas.ts`)
- **Permissions**: Loaded from `user_roles -> roles.permissions` (database-driven RBAC); enriched into JWT via Auth0 Post-Login Action

### Permissions

Dashboard permissions are defined in `src/types/auth.ts`:

```
dashboard.read                 # Base read access
dashboard.executive            # Executive view
dashboard.operator             # Operator view
dashboard.auditor              # Auditor view
dashboard.traces.read          # Trace detail access
dashboard.sessions.read        # Session detail access
dashboard.agents.read          # Agent detail access
dashboard.pipeline.read        # Pipeline status access
dashboard.compliance.read      # Compliance pages access
dashboard.admin                # Admin access (bypasses all checks)
```

### Environment Variables

**Frontend (`.env` — generated from Doppler by running `zsh .auth0_cli`):**
```
VITE_AUTH0_DOMAIN=dev-68gg87ow4mg4kzyo.us.auth0.com
VITE_AUTH0_CLIENT_ID=CNfd6xPPr2aLmvNyiearhmaLknAYvtnq
VITE_AUTH0_AUDIENCE=https://api.integritystudio.dev
VITE_SUPABASE_URL=https://cfrbahzzklwrnmbtqojl.supabase.co   # direct PostgREST reads with the Auth0 ID token (CR62)
VITE_SUPABASE_ANON_KEY=sb_publishable_...                    # the publishable key; RLS decides what the token sees
```

The two `VITE_SUPABASE_*` values are optional: without both, `useOwnUserRow` stays disabled and
the header's account badge never renders. With them, the SPA makes its one direct database
read — its own `users` row — through `src/lib/postgrest-client.ts` with the **ID token** (the
post-login Action puts `role = authenticated` on it for this client only; the access token
has no such claim and reads as anon). Everything else still goes through the Worker.

**Worker (wrangler.toml vars + secrets):**
```
# wrangler.toml [vars]:
AUTH0_DOMAIN=dev-68gg87ow4mg4kzyo.us.auth0.com
AUTH0_AUDIENCE=https://api.integritystudio.dev

# secrets (wrangler secret put):
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   # all Worker DB access; the browser's own read uses the ID token under RLS (above)
```

> **Never set `ALLOW_TEST_BYPASS` in production.** This binding enables the `Bearer test-token` auth bypass used in worker unit tests (`makeEnv()` sets it to `'true'`). Leave the binding absent in wrangler.toml and production secrets.

### Integration Tests

`e2e/integration/` tests hit the deployed worker with real Auth0 JWTs. A permanent test account (`AUTH0_TEST_EMAIL` in Doppler `dev`) is used — Auth0 ROPC against the **dev** tenant via the `integritystudio-dashboard-dev` SPA client (`password` grant, `Username-Password-Authentication` connection). The production SPA client has no `password` grant. Test DB rows are upserted on setup and deleted on teardown; the Auth0 user is never touched.

Failures are reported to Sentry (`SENTRY_DSN` from Doppler) via `e2e/integration/sentry-reporter.ts`.

## Populating Data

`npm run populate` runs the full pipeline in one command:

| Step | Script | Output |
|------|--------|--------|
| 1. Derive | `derive-evaluations.ts` | Rule-based: tool_correctness, evaluation_latency, task_completion, over spans the cloud holds for the last 7 days (`--source=cloud --days=7 --post-days=2`, cloud-read Phase 1) — the last 2 days POSTed straight to ingest (Phase 3). No file since Phase 6, and never a record before 2026-09-28, whose D1 copies carry no id |
| 2. Judge | `judge-evaluations.ts` | LLM-based: relevance, coherence, faithfulness, hallucination, over turns the cloud lists for the last 7 days (`--source=cloud --days=7`; turn text is read from local transcripts) — POSTed straight to ingest (Phase 4) and appended to `evaluations-<date>.jsonl` |
| 3. Upload | `upload-evaluations.ts` | Ships the hooks' and `survival-fitness` records in `evaluations-*.jsonl` to the cloud `evaluations` table (the next stage reads the cloud, not these files) |
| 4. Sync | `sync-to-kv.ts` | Delta sync aggregates to Cloudflare KV (budget-based, priority: meta/agent > metrics > trends > traces) |

```bash
npm run populate -- --seed          # offline (synthetic judge scores)
npm run populate                    # full (needs a judge API key, see below)
npm run populate -- --dry-run --seed  # preview only, no writes
npm run populate -- --skip-judge    # rule-based + upload + sync
npm run populate -- --skip-sync     # derive + judge + upload
npm run populate -- --limit 5 --seed  # judge at most 5 turns
npm run populate -- --batch         # judge through the Message Batches API: 50% off, minutes not seconds
npm run populate -- --per-criterion # one call per criterion (~10x cost)
npm run populate -- --judge-days=30 # judge turns from the last 30 days instead of 7
npm run populate -- --judge-source=local  # judge discovery from local telemetry (rollback)
npm run populate -- --derive-days=14      # derive over the last 14 days instead of 7
npm run populate -- --derive-source=local # derive from local trace files (rollback)
```

**Judge credentials.** The judge prefers `LLM_JUDGE_ANTHROPIC_KEY` and falls back to
`ANTHROPIC_API_KEY`, so judge spend is attributable to its own key in the Usage and Cost
Admin API rather than blended into a shared one. With neither set, populate fails closed
(exit 1) rather than publishing synthetic scores; pass `--seed` explicitly for offline mode. The `[judge] summary:` line reports the key's variable name (never its
value) alongside real `response.usage` totals, the USD they imply, and the pre-run estimate.

**Judge cost modes.** `--batch` is the cheap default for unattended runs and is what
`../scripts/run-dashboard-pipeline.sh` passes: every token is half price, results are
matched back by `custom_id`, and the judge's per-call retry is off because a retry would
land in a later batch. Scoring is consolidated by default (JCP4): one prompt per turn
carrying the turn content once plus every applicable criterion, which measured ~10x cheaper
than one call per criterion but does not agree closely with the per-criterion scores — see
`docs/judge-agreement-2026-09-22.json`. `--per-criterion` on `judge-evaluations.ts` opts out.

**Which turns a run judges.** Turns already judged in the cloud, and turns whose results
could not be delivered, are dropped before `--limit`, which then takes the oldest pending
turns (`judge-selection.ts`). `npm run judge:parity -- --days=7` checks that the cloud and
local sources select the same turns.

Requires parent `dist/` for the sync step — run `npm run build` in the parent observability-toolkit first.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server + Hono API |
| `npm run build` | Production Vite build |
| `npm run populate` | Full data pipeline (derive + judge + upload + sync) |
| `npm run sync` | KV sync only (`--budget=450` default, `--budget=5000` for bulk) |
| `npm test` | Vitest for `src/` + `worker/` (Vite context) |
| `npm run test:scripts` | Vitest for `scripts/` (separate config; a bare `npx vitest run <path>` under `scripts/__tests__` finds no tests) |
| `npm run lint` | ESLint (`src/`, `scripts/`, `worker/`) |
| `npm run typecheck` | TS 7 `tsc --noEmit` (not bare `npx tsc`, which is TS 6) |
| `npm run typecheck:scripts` | TS 7 against `scripts/` (`tsconfig.scripts.json`); pass `-- --pretty false` to make the output greppable |
| `npm run test:e2e` | Playwright E2E tests (mocked auth, Chromium) |
| `doppler run --project integrity-studio --config dev -- npm run test:e2e:integration` | Auth0 integration tests against deployed worker |
| `npm run deploy:worker` | Deploy Cloudflare Worker |
| `npm run deploy:secrets` / `deploy:secrets:dev` | Sync Supabase secrets from Doppler to both production Workers (`--config prd`) or the dev Worker (`--config dev`); refuses a config/target mismatch |
| `npm run derive` / `judge:parity` / `derive:parity` / `upload` | Run one pipeline stage or a local/cloud parity check |
| `npm run trace-coverage` | Trace coverage report |
| `npm run dev:worker` | `wrangler dev` (local Worker) |
| `npm run filetree` | Regenerate the Project Structure section below |
| `npm run repomix` | Regenerate the repomix packs in `docs/repomix/` (gitignored) |

## Scheduling

The scheduled run is the launchd agent `ai.integritystudio.dashboard-pipeline`, which fires `../scripts/run-dashboard-pipeline.sh` at 06:00 and 18:00 local with `--limit 100 --batch` (wrapper tracked at `../scripts/launchd/`).

The pipeline is also available as an AlephAuto job at `~/code/jobs` (`sidequest/pipeline-runners/dashboard-populate-pipeline.ts`):

```bash
cd ~/code/jobs
npm run dashboard:populate             # run now
npm run dashboard:populate:seed        # run now, synthetic judge scores
npm run dashboard:populate:full        # run now, real LLM judge
npm run dashboard:populate:dry         # dry run preview
npm run dashboard:populate:schedule    # start the AlephAuto cron scheduler
```

## API Routes (Worker)

All routes except `/api/health` require `Authorization: Bearer <jwt>` header (Auth0 access token).

| Route | Auth | Description |
|-------|------|-------------|
| `GET /api/me` | ✓ | Current user session (`email`, `roles`, `permissions`, `allowedViews`) |
| `POST /api/org/switch` | ✓ | Switch the active org; returns the updated `me` payload (403 until org scoping is enabled) |
| `POST /api/logout` | ✓ | Logout + activity logging |
| `POST /api/activity` | ✓ | Log user activity event |
| `GET /api/dashboard` | ✓ | Dashboard summary (`?period=7d&role=executive`) |
| `GET /api/metrics/:name/evaluations` | ✓ | Metric evaluations (`?period=7d`) |
| `GET /api/metrics/:name` | ✓ | Metric detail |
| `GET /api/trends/:name` | ✓ | Metric trend data (`?period=7d`) |
| `GET /api/evaluations/trace/:traceId` | ✓ | Evaluations for a trace |
| `GET /api/traces/:traceId` | ✓ | Trace spans + evaluations |
| `GET /api/correlations` | ✓ | Metric correlation matrix (`?period=30d`) |
| `GET /api/degradation-signals` | ✓ | Quality degradation signals (`?period=7d`) |
| `GET /api/coverage` | ✓ | Columnar coverage matrix — metrics, inputs, `counts[metric][input]`; the grid derives status and gaps (`?period=7d&inputKey=traceId`) |
| `GET /api/pipeline` | ✓ | Populate pipeline status (`?period=7d`) |
| `GET /api/sessions/:sessionId` | ✓ | Session detail |
| `GET /api/agents` | ✓ | Cross-session agent list (all agents, sorted by invocations) |
| `GET /api/agents/detail/:agentId` | ✓ | Cross-session agent stats (RED metrics, output quality, last 20 sessions) |
| `GET /api/agents/:sessionId` | ✓ | Per-session agent activity |
| `GET /api/agents/:sessionId/graph` | ✓ | Workflow view payload (session graph without evaluations) |
| `GET /api/code-quality` | ✓ | Agent code-quality summary (survival by agent window, version rollout) |
| `GET /api/compliance/sla` | ✓ | SLA compliance (`?period=7d`) |
| `GET /api/compliance/verifications` | ✓ | Human verifications (`?period=7d`) |
| `GET /api/calibration` | ✓ | Score calibration metadata |
| `GET /api/routing-telemetry` | ✓ | Agent routing telemetry (`?period=7d`) |
| `GET /api/admin/users` | admin | List users with roles |
| `GET /api/admin/roles` | admin | List available roles |
| `POST /api/admin/users/:userId/roles` | admin | Assign role to user |
| `DELETE /api/admin/users/:userId/roles/:roleId` | admin | Remove role from user |
| `GET /api/admin/members` | org admin | List members of the active org |
| `POST /api/admin/members/:userId/role` | org admin | Change a member's role in the active org |
| `DELETE /api/admin/members/:userId` | org admin | Remove a member from the active org |
| `GET /api/admin/keys` | org admin | List the active org's API keys |
| `POST /api/admin/keys/:keyId/rotate` | org admin | Rotate an API key in the active org |
| `GET /api/health` | ✗ | Health check + last sync timestamp |

## Project Structure (192,544 tokens)

```
└── src/ (192,544 tokens)
    ├── App.tsx (7,106 tokens)
    ├── main.tsx (325 tokens)
    ├── theme.css (21,535 tokens)
    ├── types.ts (626 tokens)
    ├── vite-env.d.ts (11 tokens)
    ├── api/ (27,846 tokens)
    │   ├── api-constants.ts (3,116 tokens)
    │   ├── code-quality-summary.ts (2,328 tokens)
    │   ├── config.ts (34 tokens)
    │   ├── data-loader.ts (3,065 tokens)
    │   ├── server.ts (491 tokens)
    │   ├── parent/ (761 tokens)
    │   │   ├── bucket-utils.ts (47 tokens)
    │   │   ├── qfe-backtest.ts (64 tokens)
    │   │   ├── quality-metrics.ts (69 tokens)
    │   │   ├── quality-views.ts (45 tokens)
    │   │   ├── quality-visualization.ts (51 tokens)
    ├── ... (12 more)
    │   └── routes/ (18,051 tokens)
    │       ├── agents.ts (3,166 tokens)
    │       ├── metrics.ts (2,052 tokens)
    │       ├── quality.ts (1,469 tokens)
    │       ├── sessions.ts (4,949 tokens)
    │       ├── trends.ts (2,232 tokens)
    ├── ... (8 more)
    ├── components/ (57,037 tokens)
    │   ├── AgentActivityPanel.tsx (3,621 tokens)
    │   ├── AgentWorkflowView.tsx (2,886 tokens)
    │   ├── EvaluationTable.tsx (3,005 tokens)
    │   ├── WorkflowGraph.tsx (5,919 tokens)
    │   ├── WorkflowTimeline.tsx (3,113 tokens)
    ├── ... (55 more)
    │   ├── admin-customer/ (3,193 tokens)
    │   │   ├── CustomerCard.tsx (806 tokens)
    │   │   ├── CustomerPageScaffold.tsx (645 tokens)
    │   │   ├── DailyUsageChart.tsx (986 tokens)
    │   │   ├── NavCard.tsx (421 tokens)
    │   │   └── QuotaBar.tsx (335 tokens)
    │   └── views/ (1,683 tokens)
    │       ├── AuditorView.tsx (418 tokens)
    │       ├── ExecutiveView.tsx (732 tokens)
    │       └── OperatorView.tsx (533 tokens)
    ├── contexts/ (5,525 tokens)
    │   ├── AuthContext.tsx (1,635 tokens)
    │   ├── CalibrationContext.tsx (339 tokens)
    │   ├── KeyboardNavContext.tsx (1,716 tokens)
    │   ├── OrgContext.tsx (1,226 tokens)
    │   └── RoleContext.tsx (609 tokens)
    ├── hooks/ (10,444 tokens)
    │   ├── useAdminCustomer.ts (1,909 tokens)
    │   ├── useApiQuery.ts (1,353 tokens)
    │   ├── useDashboard.ts (573 tokens)
    │   ├── useSessionDetail.ts (1,338 tokens)
    │   ├── useTrace.ts (566 tokens)
    ├── ... (15 more)
    ├── lib/ (31,085 tokens)
    │   ├── admin-customer.ts (2,507 tokens)
    │   ├── constants.ts (3,028 tokens)
    │   ├── dashboard-file-utils.ts (1,805 tokens)
    │   ├── quality-utils.ts (4,699 tokens)
    │   ├── workflow-graph.ts (3,180 tokens)
    ├── ... (15 more)
    │   └── validation/ (5,958 tokens)
    │       ├── admin-customer-schemas.ts (1,736 tokens)
    │       ├── auth-schemas.ts (2,636 tokens)
    │       └── dashboard-schemas.ts (1,586 tokens)
    ├── pages/ (29,486 tokens)
    │   ├── AdminPage.tsx (6,354 tokens)
    │   ├── AgentCodeQualityPage.tsx (2,098 tokens)
    │   ├── EvaluationDetailPage.tsx (1,294 tokens)
    │   ├── RoutingTelemetryPage.tsx (1,838 tokens)
    │   ├── SessionDetailPage.tsx (5,920 tokens)
    ├── ... (10 more)
    │   └── admin-customer/ (5,911 tokens)
    │       ├── AdminCustomerBillingPage.tsx (838 tokens)
    │       ├── AdminCustomerEntitlementsPage.tsx (776 tokens)
    │       ├── AdminCustomerHubPage.tsx (1,282 tokens)
    │       ├── AdminCustomerQuotaPage.tsx (860 tokens)
    │       └── AdminCustomerUsagePage.tsx (2,155 tokens)
    ├── stubs/ (294 tokens)
    │   ├── auth0-e2e.ts (258 tokens)
    │   └── web-worker.ts (36 tokens)
    └── types/ (1,224 tokens)
        ├── activity.ts (109 tokens)
        ├── auth.ts (598 tokens)
        └── workflow-graph.ts (517 tokens)
```

## Production Deployment

```bash
npm run build                          # Build frontend (served by the Worker via [assets])
npx wrangler deploy                    # obs-toolkit-quality-metrics-api
npx wrangler deploy --name quality-metrics-api   # production (integritystudio.dev)
doppler run --project integrity-studio --config dev -- npx wrangler deploy --env dev
npx tsx scripts/sync-to-kv.ts \
  --budget=5000                        # Bulk sync to KV (default 450)
```

**KV sync notes:**
- Delta sync with content-hash state file (`scripts/.kv-sync-state.json`)
- Priority: meta/dashboard/agent > metrics > trends > traces
- Cloudflare free tier has daily write limits; multiple runs needed for full sync
- Traces are lowest priority — may need `--budget=5000` and multiple passes
