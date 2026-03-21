# Quality Metrics Dashboard

v3.0.4

React 19 + Vite 6 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. **Auth: Supabase JWT-based sign-in with role-based access control.**

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
- **Worker verification**: JWT verified via Supabase `/auth/v1/user` endpoint
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
```

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
| `npm run deploy:worker` | Deploy Cloudflare Worker |

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
| `GET /api/dashboard` | ✓ | Dashboard summary (`?period=7d&role=executive`) |
| `GET /api/metrics/:name` | ✓ | Metric detail |
| `GET /api/trends/:name` | ✓ | Metric trend data (`?period=7d`) |
| `GET /api/evaluations/trace/:traceId` | ✓ | Evaluations for a trace |
| `GET /api/traces/:traceId` | ✓ | Trace spans + evaluations |
| `GET /api/correlations` | ✓ | Metric correlation matrix (`?period=30d`) |
| `GET /api/coverage` | ✓ | Evaluation coverage heatmap (`?period=7d&inputKey=traceId`) |
| `GET /api/pipeline` | ✓ | Populate pipeline status (`?period=7d`) |
| `GET /api/sessions/:sessionId` | ✓ | Session detail |
| `GET /api/agents` | ✓ | Cross-session agent list (all agents, sorted by invocations) |
| `GET /api/agents/detail/:agentId` | ✓ | Cross-session agent stats (RED metrics, output quality, last 20 sessions) |
| `GET /api/agents/:sessionId` | ✓ | Per-session agent activity |
| `GET /api/compliance/sla` | ✓ | SLA compliance (`?period=7d`) |
| `GET /api/compliance/verifications` | ✓ | Human verifications (`?period=7d`) |
| `GET /api/health` | ✗ | Health check + last sync timestamp |

## Project Structure (114,279 tokens)

```
└── src/ (114,279 tokens)
    ├── App.tsx (4,156 tokens)
    ├── main.tsx (332 tokens)
    ├── theme.css (11,825 tokens)
    ├── types.ts (431 tokens)
    ├── vite-env.d.ts (11 tokens)
    ├── api/ (20,007 tokens)
    │   ├── api-constants.ts (513 tokens)
    │   ├── config.ts (72 tokens)
    │   ├── data-loader.ts (2,517 tokens)
    │   ├── server.ts (502 tokens)
    │   └── routes/ (16,403 tokens)
    │       ├── agents.ts (2,571 tokens)
    │       ├── dashboard.ts (1,268 tokens)
    │       ├── metrics.ts (2,066 tokens)
    │       ├── sessions.ts (4,679 tokens)
    │       ├── trends.ts (2,279 tokens)
    ├── ... (7 more)
    ├── components/ (43,931 tokens)
    │   ├── AgentActivityPanel.tsx (3,985 tokens)
    │   ├── CorrelationHeatmap.tsx (1,880 tokens)
    │   ├── EvaluationTable.tsx (3,013 tokens)
    │   ├── TrendChart.tsx (2,060 tokens)
    │   ├── WorkflowGraph.tsx (2,484 tokens)
    ├── ... (50 more)
    │   └── views/ (1,683 tokens)
    │       ├── AuditorView.tsx (418 tokens)
    │       ├── ExecutiveView.tsx (732 tokens)
    │       └── OperatorView.tsx (533 tokens)
    ├── context/ (343 tokens)
    │   └── CalibrationContext.tsx (343 tokens)
    ├── contexts/ (3,277 tokens)
    │   ├── AuthContext.tsx (906 tokens)
    │   ├── KeyboardNavContext.tsx (1,751 tokens)
    │   └── RoleContext.tsx (620 tokens)
    ├── hooks/ (5,411 tokens)
    │   ├── useAgentStats.ts (516 tokens)
    │   ├── useApiQuery.ts (509 tokens)
    │   ├── useMetricEvaluations.ts (384 tokens)
    │   ├── useSessionDetail.ts (1,331 tokens)
    │   ├── useTrace.ts (372 tokens)
    ├── ... (10 more)
    ├── lib/ (10,832 tokens)
    │   ├── constants.ts (2,963 tokens)
    │   ├── quality-utils.ts (3,724 tokens)
    │   ├── supabase.ts (1,626 tokens)
    │   ├── symbols.ts (309 tokens)
    │   ├── workflow-graph.ts (2,105 tokens)
    ├── ... (1 more)
    ├── pages/ (13,238 tokens)
    │   ├── AgentSessionPage.tsx (791 tokens)
    │   ├── CompliancePage.tsx (792 tokens)
    │   ├── EvaluationDetailPage.tsx (1,304 tokens)
    │   ├── SessionDetailPage.tsx (6,423 tokens)
    │   ├── TraceDetailPage.tsx (803 tokens)
    ├── ... (6 more)
    ├── stubs/ (36 tokens)
    │   └── web-worker.ts (36 tokens)
    └── types/ (449 tokens)
        ├── auth.ts (227 tokens)
        └── workflow-graph.ts (222 tokens)
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
