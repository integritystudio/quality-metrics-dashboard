# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

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
| PHASE6-LOCAL-RETIREMENT | Retire `--source=local` and the parity tools after the rollback release | P3 | Source: session 2026-10-06 scripts audit |

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

**PHASE6-LOCAL-RETIREMENT.** The cloud-read roadmap (`../../docs/roadmap/dashboard-cloud-read-migration.md:166`) keeps
`--source=local` for one release after the 2026-10-04 default flip, then deletes it. That release removes ~900 lines:
`derive-parity.ts`, `judge-parity.ts`, `trace-coverage.ts` (or keep it as a shipper-health check — decide),
`account-stamps.ts` (apart from what judge option A needs), derive's `loadLocalSpans`, and the judge's local discovery and
`_loadExistingKeys`, plus their tests. Do not start before the rollback window closes.
- **Gate status, 2026-10-07.**
  - **Rollback release: not yet.** The flip shipped in the parent's v3.1.26 migration (2026-10-04), and the next
    release, 4.0.0, is still in progress.
  - **Exit check 2: passed.** Window 2026-09-30 to 10-06, read via `/v1/evaluations?evaluator=` per
    `OBTOOL_API_KEY*` under Doppler `prd`, compared with non-canary local records by event time:

    | Producer | D1 (`OBTOOL_API_KEY` + `_ALYSHIA_LEDLIE` + `_INVENTORY_AI`) | Local |
    |---|---|---|
    | `dashboard:judge-consolidated` | 686 + 3,346 + 174 = 4,206 | 4,206 |
    | `hook:stop-quality-evaluation` | 79 + 240 + 48 = 367 | 367 |
    | `hook:stop-session-summary` | 16 + 103 + 10 = 129 | 129 |
    | `survival-fitness` | 17 + 0 + 0 = 17 | 17 |
    | derive (`rule`) | 15,405 + 20,854 + 501 | no file since Phase 6 |

  - **Exit check 1: passed, 2026-10-09.** Run against `prd` from an empty `TELEMETRY_DIR` with the scheduled run's
    flags (`--limit 100 --batch`); the judge ran under option A, since option B (Phase 5) is undecided. derive posted
    22,314 records, the judge 704 (100 turns, $0.98 at batch rate), upload sent 0 (`skipped[too-old=704]`: the judge's
    records carry turn time, so the 36 h guard drops them, as the roadmap says), sync wrote 310 keys, exit 0.
    All 704 judge rows were in D1 42 min after the post (`dashboard:judge-consolidated` 344 → 902 and 2,520 → 2,666
    per key; judged turns 433 → 533), 146 of them at 27 min: each 100-record POST is one R2 object and the flush
    drains 100 objects per signal per 5 min, so a run's ~230 derive objects clear before the judge's 8.
    - **Side effect.** derive wrote a fresh `.calibration-state.json` from its 7-day window, without
      `handoff_correctness` and `task_completion` (the host's file carries them from earlier runs), and sync published
      it as `meta:calibration`. Reverted the same hour with `npm run sync` from the host's dir. An empty-dir machine
      publishes a narrower calibration than the host.
    - **Found on the way.** `LLM_JUDGE_ANTHROPIC_KEY` in Doppler `prd` returns `401 invalid x-api-key`: the 2026-10-08
      07:11 scheduled run judged fine, the 18:00 run and every one since exit 3 with `NO SCORES PRODUCED`.
      `ANTHROPIC_API_KEY` in the same config still works, and the check's judge ran with it. Rotate the judge key.
  - **Constraint from JUDGE-BACKFILL-FLAG.** `--backfill` was kept, so `_loadExistingKeys` and the parts of
    `account-stamps.ts` it uses stay, or backfill moves to cloud dedup first.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.11](changelog/3.0.11/CHANGELOG.md) (2026-10-09).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
