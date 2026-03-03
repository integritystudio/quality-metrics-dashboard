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

## Project Structure (99,298 tokens)

```
└── src/ (99,298 tokens)
    ├── App.tsx (3,939 tokens)
    ├── main.tsx (332 tokens)
    ├── theme.css (11,394 tokens)
    ├── types.ts (421 tokens)
    ├── vite-env.d.ts (11 tokens)
    ├── api/ (18,659 tokens)
    │   ├── config.ts (72 tokens)
    │   ├── data-loader.ts (2,235 tokens)
    │   ├── server.ts (421 tokens)
    │   └── routes/ (15,931 tokens)
    │       ├── agents.ts (2,494 tokens)
    │       ├── compliance.ts (693 tokens)
    │       ├── correlations.ts (410 tokens)
    │       ├── coverage.ts (748 tokens)
    │       ├── dashboard.ts (1,274 tokens)
    │       ├── evaluations.ts (264 tokens)
    │       ├── metrics.ts (1,960 tokens)
    │       ├── pipeline.ts (450 tokens)
    │       ├── quality.ts (639 tokens)
    │       ├── sessions.ts (4,418 tokens)
    │       ├── traces.ts (298 tokens)
    │       └── trends.ts (2,283 tokens)
    ├── components/ (40,476 tokens)
    │   ├── AgentActivityPanel.tsx (3,945 tokens)
    │   ├── CorrelationHeatmap.tsx (1,756 tokens)
    │   ├── CoverageGrid.tsx (1,710 tokens)
    │   ├── EvaluationTable.tsx (2,969 tokens)
    │   ├── TrendChart.tsx (1,969 tokens)
    │   ├── ... (50 more)
    │   └── views/ (1,657 tokens)
    │       ├── AuditorView.tsx (403 tokens)
    │       ├── ExecutiveView.tsx (721 tokens)
    │       └── OperatorView.tsx (533 tokens)
    ├── contexts/ (1,986 tokens)
    │   ├── KeyboardNavContext.tsx (1,336 tokens)
    │   └── RoleContext.tsx (650 tokens)
    ├── hooks/ (5,389 tokens)
    │   ├── useAgentSession.ts (261 tokens)
    │   ├── useAgentStats.ts (516 tokens)
    │   ├── useApiQuery.ts (472 tokens)
    │   ├── useMetricEvaluations.ts (368 tokens)
    │   ├── useQualityLive.ts (598 tokens)
    │   ├── useSessionDetail.ts (1,329 tokens)
    │   ├── useTrend.ts (359 tokens)
    │   └── ... (7 more)
    ├── lib/ (4,970 tokens)
    │   ├── constants.ts (1,993 tokens)
    │   ├── quality-utils.ts (2,563 tokens)
    │   ├── routes.ts (105 tokens)
    │   └── symbols.ts (309 tokens)
    └── pages/ (11,721 tokens)
        ├── AgentSessionPage.tsx (732 tokens)
        ├── AgentsPage.tsx (292 tokens)
        ├── CompliancePage.tsx (790 tokens)
        ├── CorrelationsPage.tsx (713 tokens)
        ├── CoveragePage.tsx (458 tokens)
        ├── EvaluationDetailPage.tsx (1,273 tokens)
        ├── PipelinePage.tsx (561 tokens)
        ├── SessionDetailPage.tsx (6,125 tokens)
        └── TraceDetailPage.tsx (777 tokens)
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
