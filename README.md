# Quality Metrics Dashboard

v3.0.4

React 19 + Vite 8 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. **Auth: Supabase JWT-based sign-in with role-based access control.**

## Quick Start

```bash
npm install
npm run dev          # Vite + Hono API on :3001
```

## Authentication

The dashboard uses **Supabase Auth** for sign-in and **JWT verification** on the worker.

- **Login**: `/login` page with email/password sign-in
- **Session storage**: Browser localStorage (JWT + refresh token)
- **Token injection**: All data hooks include `Authorization: Bearer <token>` header
- **Worker verification**: JWT verified via Supabase `/auth/v1/user` endpoint with Zod schema validation
- **Validation**: Request/response types validated using Zod schemas (`src/lib/validation/auth-schemas.ts`)
- **Permissions**: Loaded from `user_roles -> roles.permissions` (database-driven RBAC)

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

**Frontend (.env or .env.local):**
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
```

**Worker (wrangler.toml secrets):**
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...   # admin routes only — bypasses RLS
```

> **Never set `ALLOW_TEST_BYPASS` in production.** This binding enables the `Bearer test-token` auth bypass used in worker unit tests (`makeEnv()` sets it to `'true'`). Leave the binding absent in wrangler.toml and production secrets.

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
| `npm run test:e2e` | Playwright E2E tests (mocked auth) |
| `npm run test:e2e:integration` | Integration tests against deployed worker (requires Doppler) |
| `npm run deploy:worker` | Deploy Cloudflare Worker |
| `npm run deploy:secrets` | Sync Supabase secrets from Doppler to both workers |

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

All routes except `/api/health` require `Authorization: Bearer <jwt>` header (Supabase access token).

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

## Project Structure (94,429 tokens)

```
└── src/ (94,429 tokens)
    ├── App.tsx (3,796 tokens)
    ├── main.tsx (253 tokens)
    ├── theme.css (7,616 tokens)
    ├── types.ts (321 tokens)
    ├── api/ (14,474 tokens)
    │   ├── api-constants.ts (210 tokens)
    │   ├── config.ts (30 tokens)
    │   ├── data-loader.ts (1,750 tokens)
    │   ├── server.ts (406 tokens)
    │   └── routes/ (12,078 tokens)
    │       ├── agents.ts (1,909 tokens)
    │       ├── compliance.ts (505 tokens)
    │       ├── correlations.ts (334 tokens)
    │       ├── coverage.ts (474 tokens)
    │       ├── dashboard.ts (854 tokens)
    │       ├── evaluations.ts (206 tokens)
    │       ├── metrics.ts (1,594 tokens)
    │       ├── pipeline.ts (292 tokens)
    │       ├── quality.ts (439 tokens)
    │       ├── sessions.ts (3,687 tokens)
    │       ├── traces.ts (227 tokens)
    │       └── trends.ts (1,557 tokens)
    ├── components/ (35,514 tokens)
    │   ├── AgentActivityPanel.tsx (3,003 tokens)
    │   ├── AgentWorkflowView.tsx (634 tokens)
    │   ├── CorrelationHeatmap.tsx (1,238 tokens)
    │   ├── EvaluationTable.tsx (2,299 tokens)
    │   ├── TrendChart.tsx (1,528 tokens)
    │   ├── WorkflowGraph.tsx (1,845 tokens)
    │   ├── WorkflowTimeline.tsx (2,016 tokens)
    │   ├── ... (46 more)
    │   └── views/ (1,337 tokens)
    │       ├── AuditorView.tsx (327 tokens)
    │       ├── ExecutiveView.tsx (589 tokens)
    │       └── OperatorView.tsx (421 tokens)
    ├── context/ (259 tokens)
    │   └── CalibrationContext.tsx (259 tokens)
    ├── contexts/ (2,496 tokens)
    │   ├── AuthContext.tsx (839 tokens)
    │   ├── KeyboardNavContext.tsx (1,221 tokens)
    │   └── RoleContext.tsx (436 tokens)
    ├── hooks/ (4,380 tokens)
    │   ├── useAgentStats.ts (374 tokens)
    │   ├── useApiQuery.ts (532 tokens)
    │   ├── useRoutingTelemetry.ts (280 tokens)
    │   ├── useSessionDetail.ts (898 tokens)
    │   └── ... (12 more)
    ├── lib/ (11,211 tokens)
    │   ├── activity-logger.ts (160 tokens)
    │   ├── constants.ts (1,626 tokens)
    │   ├── dashboard-file-utils.ts (641 tokens)
    │   ├── quality-utils.ts (2,807 tokens)
    │   ├── supabase-rest.ts (192 tokens)
    │   ├── supabase.ts (1,599 tokens)
    │   ├── workflow-graph.ts (1,776 tokens)
    │   └── validation/ (2,130 tokens)
    │       ├── auth-schemas.ts (895 tokens)
    │       └── dashboard-schemas.ts (1,235 tokens)
    ├── pages/ (13,720 tokens)
    │   ├── AdminPage.tsx (1,657 tokens)
    │   ├── EvaluationDetailPage.tsx (969 tokens)
    │   ├── RoutingTelemetryPage.tsx (1,458 tokens)
    │   ├── SessionDetailPage.tsx (5,216 tokens)
    │   ├── TraceDetailPage.tsx (641 tokens)
    │   ├── WorkflowPage.tsx (355 tokens)
    │   └── ... (7 more)
    ├── stubs/ (13 tokens)
    │   └── web-worker.ts (13 tokens)
    └── types/ (376 tokens)
        ├── activity.ts (74 tokens)
        ├── auth.ts (140 tokens)
        └── workflow-graph.ts (162 tokens)
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
