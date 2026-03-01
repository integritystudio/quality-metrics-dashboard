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

## Project Structure (98,844 tokens)

```
src/
├── App.tsx                          4,178
├── main.tsx                           334
├── theme.css                        8,201
├── types.ts                           341
├── api/                            19,490
│   ├── data-loader.ts               2,243
│   ├── server.ts                      439
│   └── routes/                     16,808
│       ├── agents.ts                2,598
│       ├── compliance.ts              815
│       ├── correlations.ts            519
│       ├── coverage.ts                876
│       ├── dashboard.ts             1,332
│       ├── evaluations.ts             246
│       ├── metrics.ts               2,075
│       ├── pipeline.ts                562
│       ├── quality.ts                 709
│       ├── sessions.ts             4,406
│       ├── traces.ts                  280
│       └── trends.ts               2,390
├── components/                     41,306
│   ├── views/                       1,911
│   ├── AgentActivityPanel.tsx       5,173
│   ├── EvaluationTable.tsx          3,107
│   ├── TrendChart.tsx               2,087
│   ├── CorrelationHeatmap.tsx       1,919
│   ├── CoverageGrid.tsx            1,892
│   ├── EvaluationExpandedRow.tsx    1,676
│   ├── TrendSeries.tsx              1,616
│   ├── ConfidencePanel.tsx          1,590
│   ├── ProvenancePanel.tsx          1,546
│   ├── SpanTree.tsx                 1,536
│   ├── HealthOverview.tsx           1,277
│   ├── ScoreBadge.tsx               1,203
│   ├── AlertList.tsx                1,192
│   ├── PipelineFunnel.tsx           1,096
│   └── ... (22 more components)
├── contexts/                        1,973
│   ├── KeyboardNavContext.tsx        1,330
│   └── RoleContext.tsx                643
├── hooks/                           5,548
│   ├── useSessionDetail.ts          1,320
│   ├── useQualityLive.ts              674
│   ├── useAgentStats.ts               548
│   └── ... (10 more hooks)
├── lib/                             2,707
│   ├── quality-utils.ts             2,454
│   ├── constants.ts                   220
│   └── api.ts                          33
└── pages/                          14,755
    ├── SessionDetailPage.tsx        8,495
    ├── EvaluationDetailPage.tsx     1,392
    ├── CompliancePage.tsx             987
    ├── AgentSessionPage.tsx           879
    └── ... (5 more pages)
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
