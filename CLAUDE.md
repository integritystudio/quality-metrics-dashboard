# Quality Metrics Dashboard

React 19 + Vite 8 dashboard with Hono API, backed by a Cloudflare Worker. Displays 7 quality metrics derived from Claude Code session telemetry. Auth: Auth0 Universal Login with role-based access control backed by Supabase DB.

## Commands

```bash
npm run dev          # Vite + Hono API on :3001
npm test             # Vitest
npm run typecheck    # tsc --noEmit
npm run build        # Production build
npm run populate -- --seed   # Data pipeline (offline)
npm run deploy:worker        # Deploy Cloudflare Worker
doppler run --project integrity-studio --config dev -- npm run test:e2e:integration  # Auth0 integration tests
```

## Architecture

- **Frontend**: `src/` — React 19 + Vite 8, React Router, Auth0 React SDK (`@auth0/auth0-react`)
- **API server**: `src/api/` — Hono server on :3001, reads from Cloudflare KV via worker
- **Worker**: `worker/index.ts` — Auth0 JWKS JWT verification via `jose`, KV read-through cache, protected `/api/*` routes
- **Auth**: Auth0 Universal Login + role-based permissions from Supabase `user_roles -> roles.permissions` (all DB access via service role key). See [docs/auth/user-authentication.md](docs/auth/user-authentication.md)
- **Validation**: Zod schemas in `src/lib/validation/` for all auth and dashboard types
- **Styling**: No inline styles — use CSS classes defined in `src/theme.css` or component-level selectors. Never pass `style={{...}}` props.
- **React Compiler**: Active via `babel-plugin-react-compiler`. Libraries incompatible with it (e.g., `useReactTable`) require `// eslint-disable-next-line react-compiler/react-compiler` suppression with a comment explaining why.

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

## Integration Tests (`e2e/integration/`)

Run against the deployed worker with a real Auth0 JWT. Requires Doppler dev config.

- **Setup** (`setup.ts`): acquires Auth0 JWT via ROPC (`VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `AUTH0_TEST_EMAIL/PASSWORD`), upserts `public.users`, assigns `e2e-dashboard-reader` role
- **Teardown** (`teardown.ts`): removes `user_roles`, `user_activity`, `public.users` row — Auth0 user is permanent, never deleted
- **Sentry** (`sentry-reporter.ts`): captures `failed`/`timedOut` tests to Sentry (`SENTRY_DSN` from Doppler); no-ops if unset
- Auth0 tenant: `dev-68gg87ow4mg4kzyo.us.auth0.com`, `password` grant enabled on `integritystudio-dashboard` SPA (`CNfd6xPPr2aLmvNyiearhmaLknAYvtnq`); default directory set to `Username-Password-Authentication`

## Deployment

Two Cloudflare Workers serve the dashboard API (same KV namespace):
- `quality-metrics-api` — production
- `obs-toolkit-quality-metrics-api` — wrangler.toml default

Deploy both after worker changes:
```bash
npx wrangler deploy
npx wrangler deploy --name quality-metrics-api
```
