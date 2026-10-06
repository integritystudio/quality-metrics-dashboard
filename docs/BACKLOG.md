# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

No open items.

### Behaviour

No open items.

### Workflow page

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

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.9](changelog/3.0.9/CHANGELOG.md) (2026-10-05).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
