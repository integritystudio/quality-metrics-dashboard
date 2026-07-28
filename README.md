# Quality Metrics Dashboard

v3.0.5

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
```

**Worker (wrangler.toml vars + secrets):**
```
# wrangler.toml [vars]:
AUTH0_DOMAIN=dev-68gg87ow4mg4kzyo.us.auth0.com
AUTH0_AUDIENCE=https://api.integritystudio.dev

# secrets (wrangler secret put):
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   # all DB access — Auth0 JWTs not valid for RLS
```

> **Never set `ALLOW_TEST_BYPASS` in production.** This binding enables the `Bearer test-token` auth bypass used in worker unit tests (`makeEnv()` sets it to `'true'`). Leave the binding absent in wrangler.toml and production secrets.

### Integration Tests

`e2e/integration/` tests hit the deployed worker with real Auth0 JWTs. A permanent test account (`AUTH0_TEST_EMAIL` in Doppler) is used — Auth0 ROPC via the `integritystudio-dashboard` SPA client (`password` grant, `Username-Password-Authentication` connection). Test DB rows are upserted on setup and deleted on teardown; the Auth0 user is never touched.

Failures are reported to Sentry (`SENTRY_DSN` from Doppler) via `e2e/integration/sentry-reporter.ts`.

## Populating Data

`npm run populate` runs the full pipeline in one command:

| Step | Script | Output |
|------|--------|--------|
| 1. Derive | `derive-evaluations.ts` | Rule-based: tool_correctness, evaluation_latency, task_completion |
| 2. Judge | `judge-evaluations.ts` | LLM-based: relevance, coherence, faithfulness, hallucination |
| 3. Sync | `sync-to-kv.ts` | Delta sync aggregates to Cloudflare KV (budget-based, priority: meta/agent > metrics > trends > traces) |

```bash
npm run populate -- --seed          # offline (synthetic judge scores)
npm run populate                    # full (needs ANTHROPIC_API_KEY)
npm run populate -- --dry-run --seed  # preview only, no writes
npm run populate -- --skip-judge    # rule-based + sync only
npm run populate -- --skip-sync     # derive + judge only
npm run populate -- --limit 5 --seed  # judge at most 5 turns
```

Auto-detects missing `ANTHROPIC_API_KEY` and falls back to `--seed` mode.

Requires parent `dist/` for the sync step — run `npm run build` in the parent observability-toolkit first.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server + Hono API |
| `npm run build` | Production Vite build |
| `npm run populate` | Full data pipeline (derive + judge + sync) |
| `npm run sync` | KV sync only (`--budget=450` default, `--budget=5000` for bulk) |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:e2e` | Playwright E2E tests (mocked auth, Chromium) |
| `doppler run --project integrity-studio --config dev -- npm run test:e2e:integration` | Auth0 integration tests against deployed worker |
| `npm run deploy:worker` | Deploy Cloudflare Worker |
| `npm run deploy:secrets` | Sync secrets from Doppler to both workers |

## AlephAuto Integration

The populate pipeline is also available as an AlephAuto job at `~/code/jobs`, running twice daily via cron (6 AM / 6 PM):

```bash
cd ~/code/jobs
npm run dashboard:populate             # seed (offline)
npm run dashboard:populate:full        # real LLM judge (needs ANTHROPIC_API_KEY)
npm run dashboard:populate:dry         # dry run preview
npm run dashboard:populate:schedule    # start cron scheduler
```

See `~/code/jobs/docs/components/dashboard-populate.md` for full details.

## API Routes (Worker)

All routes except `/api/health` require `Authorization: Bearer <jwt>` header (Auth0 access token).

| Route | Auth | Description |
|-------|------|-------------|
| `GET /api/me` | ✓ | Current user session (`email`, `roles`, `permissions`, `allowedViews`) |
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
| `GET /api/coverage` | ✓ | Evaluation coverage heatmap (`?period=7d&inputKey=traceId`) |
| `GET /api/pipeline` | ✓ | Populate pipeline status (`?period=7d`) |
| `GET /api/sessions/:sessionId` | ✓ | Session detail |
| `GET /api/agents` | ✓ | Cross-session agent list (all agents, sorted by invocations) |
| `GET /api/agents/detail/:agentId` | ✓ | Cross-session agent stats (RED metrics, output quality, last 20 sessions) |
| `GET /api/agents/:sessionId` | ✓ | Per-session agent activity |
| `GET /api/compliance/sla` | ✓ | SLA compliance (`?period=7d`) |
| `GET /api/compliance/verifications` | ✓ | Human verifications (`?period=7d`) |
| `GET /api/calibration` | ✓ | Score calibration metadata |
| `GET /api/routing-telemetry` | ✓ | Agent routing telemetry (`?period=7d`) |
| `GET /api/admin/users` | admin | List users with roles |
| `GET /api/admin/roles` | admin | List available roles |
| `POST /api/admin/users/:userId/roles` | admin | Assign role to user |
| `DELETE /api/admin/users/:userId/roles/:roleId` | admin | Remove role from user |
| `GET /api/health` | ✗ | Health check + last sync timestamp |

## Project Structure (142,125 tokens)

```
└── src/ (142,125 tokens)
    ├── App.tsx (5,342 tokens)
    ├── main.tsx (325 tokens)
    ├── theme.css (19,165 tokens)
    ├── types.ts (585 tokens)
    ├── vite-env.d.ts (11 tokens)
    ├── api/ (21,521 tokens)
    │   ├── api-constants.ts (1,594 tokens)
    │   ├── config.ts (34 tokens)
    │   ├── data-loader.ts (2,453 tokens)
    │   ├── server.ts (499 tokens)
    │   └── routes/ (16,941 tokens)
    │       ├── agents.ts (2,685 tokens)
    │       ├── metrics.ts (2,059 tokens)
    │       ├── quality.ts (1,480 tokens)
    │       ├── sessions.ts (4,789 tokens)
    │       ├── trends.ts (2,253 tokens)
    ├── ... (7 more)
    ├── components/ (51,931 tokens)
    │   ├── AgentActivityPanel.tsx (3,621 tokens)
    │   ├── AgentWorkflowView.tsx (2,886 tokens)
    │   ├── EvaluationTable.tsx (2,925 tokens)
    │   ├── WorkflowGraph.tsx (5,919 tokens)
    │   ├── WorkflowTimeline.tsx (3,113 tokens)
    ├── ... (52 more)
    │   └── views/ (1,683 tokens)
    │       ├── AuditorView.tsx (418 tokens)
    │       ├── ExecutiveView.tsx (732 tokens)
    │       └── OperatorView.tsx (533 tokens)
    ├── context/ (325 tokens)
    │   └── CalibrationContext.tsx (325 tokens)
    ├── contexts/ (3,447 tokens)
    │   ├── AuthContext.tsx (1,122 tokens)
    │   ├── KeyboardNavContext.tsx (1,716 tokens)
    │   └── RoleContext.tsx (609 tokens)
    ├── hooks/ (6,312 tokens)
    │   ├── useAgentStats.ts (516 tokens)
    │   ├── useApiQuery.ts (734 tokens)
    │   ├── useMetricEvaluations.ts (384 tokens)
    │   ├── useSessionDetail.ts (1,225 tokens)
    │   ├── useTrace.ts (468 tokens)
    ├── ... (12 more)
    ├── lib/ (15,018 tokens)
    │   ├── activity-logger.ts (350 tokens)
    │   ├── constants.ts (2,776 tokens)
    │   ├── dashboard-file-utils.ts (1,669 tokens)
    │   ├── quality-utils.ts (3,853 tokens)
    │   ├── workflow-graph.ts (3,180 tokens)
    ├── ... (5 more)
    │   └── validation/ (2,062 tokens)
    │       ├── auth-schemas.ts (1,202 tokens)
    │       └── dashboard-schemas.ts (860 tokens)
    ├── pages/ (16,988 tokens)
    │   ├── AdminPage.tsx (2,316 tokens)
    │   ├── DegradationSignalsPage.tsx (897 tokens)
    │   ├── EvaluationDetailPage.tsx (1,294 tokens)
    │   ├── RoutingTelemetryPage.tsx (1,838 tokens)
    │   ├── SessionDetailPage.tsx (5,816 tokens)
    ├── ... (9 more)
    ├── stubs/ (262 tokens)
    │   ├── auth0-e2e.ts (226 tokens)
    │   └── web-worker.ts (36 tokens)
    └── types/ (893 tokens)
        ├── activity.ts (109 tokens)
        ├── auth.ts (267 tokens)
        └── workflow-graph.ts (517 tokens)
```

## Production Deployment

```bash
npm run build                          # Build frontend
npm run deploy:worker                  # Deploy API worker
npx wrangler pages deploy dist \
  --project-name=integritystudio-ai    # Deploy frontend to Pages
npx tsx scripts/sync-to-kv.ts \
  --budget=5000                        # Bulk sync to KV (default 450)
```

**KV sync notes:**
- Delta sync with content-hash state file (`scripts/.kv-sync-state.json`)
- Priority: meta/dashboard/agent > metrics > trends > traces
- Cloudflare free tier has daily write limits; multiple runs needed for full sync
- Traces are lowest priority — may need `--budget=5000` and multiple passes
