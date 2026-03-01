# Quality Metrics Dashboard

React 19 + Vite 6 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry.

## Quick Start

```bash
npm install
npm run dev          # Vite + Hono API on :3001
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

| Route | Description |
|-------|-------------|
| `GET /api/dashboard` | Dashboard summary (`?period=7d&role=executive`) |
| `GET /api/metrics/:name` | Metric detail |
| `GET /api/trends/:name` | Metric trend data (`?period=7d`) |
| `GET /api/evaluations/trace/:traceId` | Evaluations for a trace |
| `GET /api/traces/:traceId` | Trace spans + evaluations |
| `GET /api/correlations` | Metric correlation matrix (`?period=30d`) |
| `GET /api/coverage` | Evaluation coverage heatmap (`?period=7d&inputKey=traceId`) |
| `GET /api/pipeline` | Populate pipeline status (`?period=7d`) |
| `GET /api/sessions/:sessionId` | Session detail |
| `GET /api/agents` | Cross-session agent list (all agents, sorted by invocations) |
| `GET /api/agents/detail/:agentId` | Cross-session agent stats (RED metrics, output quality, last 20 sessions) |
| `GET /api/agents/:sessionId` | Per-session agent activity |
| `GET /api/compliance/sla` | SLA compliance (`?period=7d`) |
| `GET /api/compliance/verifications` | Human verifications (`?period=7d`) |
| `GET /api/health` | Health check + last sync timestamp |

## Project Structure (98,587 tokens)

```
└── src/ (98,587 tokens)
    ├── App.tsx (4,178 tokens)
    ├── main.tsx (334 tokens)
    ├── theme.css (8,372 tokens)
    ├── types.ts (341 tokens)
    ├── vite-env.d.ts (11 tokens)
    ├── api/ (18,734 tokens)
    │   ├── data-loader.ts (2,243 tokens)
    │   ├── server.ts (439 tokens)
    │   └── routes/ (16,052 tokens)
    │       ├── agents.ts (2,481 tokens)
    │       ├── dashboard.ts (1,317 tokens)
    │       ├── metrics.ts (1,981 tokens)
    │       ├── sessions.ts (4,406 tokens)
    │       ├── trends.ts (2,293 tokens)
    │       └── ... (7 more)
    ├── components/ (41,289 tokens)
    │   ├── AgentActivityPanel.tsx (5,165 tokens)
    │   ├── CorrelationHeatmap.tsx (1,919 tokens)
    │   ├── CoverageGrid.tsx (1,892 tokens)
    │   ├── EvaluationTable.tsx (3,107 tokens)
    │   ├── TrendChart.tsx (2,087 tokens)
    │   ├── ... (34 more)
    │   └── views/ (1,911 tokens)
    │       ├── AuditorView.tsx (418 tokens)
    │       ├── ExecutiveView.tsx (894 tokens)
    │       └── OperatorView.tsx (599 tokens)
    ├── contexts/ (1,973 tokens)
    │   ├── KeyboardNavContext.tsx (1,330 tokens)
    │   └── RoleContext.tsx (643 tokens)
    ├── hooks/ (5,548 tokens)
    │   ├── useAgentStats.ts (548 tokens)
    │   ├── useMetricEvaluations.ts (418 tokens)
    │   ├── useQualityLive.ts (674 tokens)
    │   ├── useSessionDetail.ts (1,320 tokens)
    │   ├── useTrend.ts (428 tokens)
    │   └── ... (8 more)
    ├── lib/ (3,272 tokens)
    │   ├── api.ts (33 tokens)
    │   ├── constants.ts (785 tokens)
    │   └── quality-utils.ts (2,454 tokens)
    └── pages/ (14,535 tokens)
        ├── AgentSessionPage.tsx (879 tokens)
        ├── CompliancePage.tsx (987 tokens)
        ├── EvaluationDetailPage.tsx (1,392 tokens)
        ├── SessionDetailPage.tsx (8,275 tokens)
        ├── TraceDetailPage.tsx (862 tokens)
        └── ... (4 more)
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
