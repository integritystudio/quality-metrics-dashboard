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
| 3. Sync | `sync-to-kv.ts` | Aggregates + uploads to Cloudflare KV |

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
| `npm run sync` | KV sync only |
| `npm test` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run deploy:worker` | Deploy Cloudflare Worker |
