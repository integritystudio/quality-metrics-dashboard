# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

No open items.

### API client

No open items.

### Admin customer view

No open items.

### API keys

No open items.

### Security

No open items.

### Tooling and config

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| VITE-API-URL-DOPPLER | Doppler `integrity-studio` still holds `VITE_API_URL`, which this app no longer reads | P4 | ⛔ Won't Do 2026-10-05 — the value is read by a separate repo (tcad-scraper), so it is not this app's to remove |
| TYPECHECK-SCRIPTS-HTTP1-FETCH | `npm run typecheck:scripts` fails in the parent's `src/lib/core/http1-fetch.ts(38,3)` | P3 | ⛔ Won't Do 2026-10-12 — worktree-layout artifact, clean on the main checkout; Source: session 2026-10-12, reported by Units 2 and 3 |

**VITE-API-URL-DOPPLER.** Since `e2d519b` (same-origin `/api` everywhere) this app reads no
`VITE_API_URL`. It was removed from the local `.env`, but left in Doppler `integrity-studio`.
- **Why it stayed.** tcad-scraper's production `deploy.yml` reads it from `prd`, falling back to
  `https://api.alephatx.info/api`. Deleting it would silently move that build to the fallback.
- **Unchecked.** The `dev_personal` and `stg` configs hold it too; their values were not checked.
- **Fix.** Give tcad-scraper a key of its own, or its own project, then delete `VITE_API_URL` from every
  `integrity-studio` config.

Acceptance: `doppler secrets get VITE_API_URL` fails in every `integrity-studio` config, and tcad-scraper's
production build still points at its API.
*Won't Do, 2026-10-05.* tcad-scraper's `deploy.yml` reads the `prd` value, so the key is that repo's
dependency and is left in place. `stg` no longer holds it; `prd` holds `https://api.alephatx.info/api`.

**TYPECHECK-SCRIPTS-HTTP1-FETCH.** An undici `Response` type mismatch at `../src/lib/core/http1-fetch.ts(38,3)`
reds `typecheck:scripts` with no dashboard file changed. The file lives in the parent repo; fix it there or
narrow the scripts program's view of it.
*Won't Do, 2026-10-12.* Not a code fault: `typecheck:scripts` exits 0 on the main checkout and fails only
inside `dashboard/.claude/worktrees/<name>/`, where the units ran. There `../src` is a symlink sitting in
`.claude/worktrees/`, so tsc resolves the parent file's `undici` by walking up through `dashboard/node_modules`
and gets 7.30.0 (held at 7 by this app's `overrides`, for jsdom and miniflare) instead of the parent's 8.11.2.
Undici 7's `Response` lacks `textStream`, which `@types/node`'s `undici-types` 8.9 requires. A cast in
`http1-fetch.ts` would be an unnecessary assertion on the parent's own build, and lifting the override to 8 would
move jsdom and miniflare. Put the worktree beside `dashboard/` (`../.dashboard-wt-<name>`) so `../src` is the
real parent `src/` and resolves the parent's `node_modules`.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
