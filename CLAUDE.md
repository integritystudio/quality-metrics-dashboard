# Quality Metrics Dashboard

React 19 + Vite 6 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. Auth: Supabase JWT-based sign-in with role-based access control.

## Commands

```bash
npm run dev          # Vite + Hono API on :3001
npm test             # Vitest
npm run typecheck    # tsc --noEmit
npm run build        # Production build
npm run populate -- --seed   # Data pipeline (offline)
npm run deploy:worker        # Deploy Cloudflare Worker
```

## Architecture

- **Frontend**: `src/` — React 19 + Vite 6, React Router, Supabase Auth
- **API server**: `src/api/` — Hono server on :3001, reads from Cloudflare KV via worker
- **Worker**: `worker/index.ts` — JWT verification (Supabase), KV read-through cache, protected `/api/*` routes
- **Auth**: Supabase JWT + role-based permissions from `user_roles -> roles.permissions`
- **Validation**: Zod schemas in `src/lib/validation/` for all auth and dashboard types

## Data Pipeline (`scripts/`)

`npm run populate` runs: derive → judge → sync-to-kv

- `derive-evaluations.ts` — rule-based metrics (tool_correctness, evaluation_latency, task_completion)
- `judge-evaluations.ts` — LLM-based metrics (relevance, coherence, faithfulness, hallucination)
- `sync-to-kv.ts` — delta sync aggregates to Cloudflare KV (priority: meta/agent > metrics > trends > traces)

Requires parent `dist/` — run `npm run build` in observability-toolkit first.

## Deployment

Two Cloudflare Workers serve the dashboard API (same KV namespace):
- `quality-metrics-api` — production
- `obs-toolkit-quality-metrics-api` — wrangler.toml default

Deploy both after worker changes:
```bash
npx wrangler deploy
npx wrangler deploy --name quality-metrics-api
```
