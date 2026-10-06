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

Filed 2026-09-30. Paths outside this repo are in IntegrityLandingPage (`~/code/is-public-sites/IntegrityLandingPage`).

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ADMIN-API-KEY-ROTATION | A UI on `AdminPage` that lets an admin rotate their own API keys, through a same-origin worker route | P2 | Reopened 2026-10-05; fixed by option (b), the worker calls the function as a service. Code done, nothing deployed |

**ADMIN-API-KEY-ROTATION.** Nobody can rotate an `obtk_` key without an operator today. The only
rotation done so far was by hand: insert an `api_keys` row, PUT its `apikey:<sha256>` record into
the obtool-api `AUTH` KV, then revoke the old row and DELETE its record. So a leaked key stays live
until someone with database and Cloudflare access acts. The backend half already exists:
`supabase/functions/api-keys-rotate` (rotates one of the caller's own active keys and returns the
new plaintext token once) and `api-keys-list`. No app calls `api-keys-rotate` today, so this UI
would be its first consumer; only the toolkit's e2e suite exercises it.

*Blockers, in `api-keys-rotate/index.ts`.* Fix these in IntegrityLandingPage before exposing the
function to users, or the UI hands them to everyone with a key:
1. **The new key can land in another org.** It takes its org from the caller's
   `organization_memberships … .limit(1)` (~84-92), an arbitrary membership, not the old key's
   `organization_id`, which the old-key select (~95-101) does not even read. A user in two orgs who
   rotates gets a key that ingests into, and reads from, the other tenant.
2. **A failed rotation leaves the user with no key.** The old row is revoked and its KV record
   deleted (~113-126) *before* the new key is inserted (~133-148); neither result is checked. If
   the insert fails, the response is 500 and the user has no working key. Create and sync the new
   key first, then revoke the old one.
3. **A failed KV write still reports success.** If the new record's PUT fails (~171-181), the
   response is 201 with a `warning`, the new key does not authenticate, and the old one is already
   gone. With item 2's order fixed, this should fail and leave the old key in place.
Also confirm that the function's `KV_NAMESPACE_ID` secret names the `AUTH` namespace. Doppler's
`KV_NAMESPACE_ID` holds the *dashboard* namespace, so copying it from there would break every
rotation silently.

*Decided 2026-09-30:*
- **Only admins rotate, by design.** The UI lives on `AdminPage`, behind `dashboard.admin`
  (`AdminGuard`, `App.tsx`). The function rotates only the caller's own keys, so rotating another
  member's key is out of scope.
- **A same-origin worker route** (e.g. `POST /api/admin/keys/:keyId/rotate`), not a call from the
  SPA. A direct call would be cross-origin, and the function's CORS allows only
  `authorization, x-client-info, apikey, content-type`, so `apiFetch` with an active org would fail
  the preflight on `X-Org-Id` (the ADMIN-CV-API-CLIENT trap). Through the worker the SPA uses
  `apiFetch` as usual (`useAdminFetch`).

*The route:*
- **Gate it on the server.** `AdminGuard` only hides the page. Use `orgAdminScope(c)`
  (`worker/index.ts`), which the member routes already use: `dashboard.admin` plus an active org,
  else 403. `dashboard.admin` is an org-scoped grant, so allow only keys whose `organization_id` is
  the active org. An admin of one org must not rotate their key in an org where they are only a
  member. Check this against `api_keys` with the service key before forwarding.
- **Call `api-keys-rotate` as a service.** *Superseded 2026-10-05; this bullet said to forward the
  user's bearer token, which Supabase cannot verify (see Reopened below).* The worker sends its
  service key and the verified user's id; it never forwards the user's token.
- **Audit it** with `logAuditEvent` (`key.rotate`, old and new key ids, never the token), as the
  member routes do.
- **Return the token in the response only.** The worker sets `no-store` on `/api/*` already; it must
  not log or cache the token.

*UI:*
- List the caller's active keys: prefix (`obtk_ab12cd34…`), name, tier and created date, plus last
  used if `api-keys-list` returns it.
- Rotate each key behind a confirm that says the old key stops working immediately (the function
  has no grace period) and names what to update, e.g. `OBTOOL_API_KEY` wherever the hooks read it.
- Show the new token exactly once, with a copy button. Keep it out of `localStorage` and out of the
  React Query cache: use a mutation's result, not a query, and drop it when the user leaves the page.
- Errors stay visible in the row. Since 099c7b9 the admin tables stay mounted across reloads.
- Styles come from `theme.css` classes, not inline `style`.

*Reopened 2026-10-05.* Marked done 2026-10-04 on code that passes its tests but cannot work in
production. The route step "first confirm that the Supabase gateway accepts this app's Auth0
token" was skipped, and it does not.
- **What landed.** IntegrityLandingPage 7f35b4f1 fixes all three blockers in `api-keys-rotate`.
  Dashboard 24d47cd adds `GET /api/admin/keys`, `POST /api/admin/keys/:keyId/rotate` (gated by
  `orgAdminScope`, checked against the active org, audited as `key.rotate`), the keys section on
  `AdminPage`, and tests.
- **Why it fails.** Read from the Supabase Management API on 2026-10-05, project
  `cfrbahzzklwrnmbtqojl` has **no third-party auth providers**, and the deployed `api-keys-rotate`
  has `verify_jwt: true`. The route forwards the user's Auth0 token, so Supabase's gateway rejects
  it before the function runs, and every rotation returns an error. The worker tests mock the
  function, so they cannot see this.
- **`verify_jwt = false` was not a fix on its own.** The old handler's `getJwtSub` base64-decoded
  the token's payload and trusted `sub` without checking a signature, so it relied entirely on the
  gateway's check. Turning that check off without changing the handler would have let anyone forge
  a token carrying another user's Auth0 id, revoke that user's keys and be handed a new one. The
  fix below turns it off only together with removing that path and requiring a service key.
- **Decided 2026-10-05: (b), the worker calls the function as a service.** Rejected: (a), enabling
  Auth0 as a Supabase third-party provider. That is project-wide, so Auth0 tokens would reach
  PostgREST and RLS, where today all access goes through the service key.
  - **Function** (IntegrityLandingPage, uncommitted): `api-keys-rotate` is split into
    `handler.ts` and `index.ts`, like `api-keys-create`.
    - It requires a service-level key on every request (the same Auth-admin capability check as
      `api-keys-create` and `api-keys-set-status`). It takes `{ keyId, userId }` and no longer
      reads any JWT.
    - `supabase/config.toml` sets `verify_jwt = false`, which Supabase documents for
      server-to-server calls with `sb_secret_` keys.
    - 21 tests in `supabase/tests/edge-functions/api-keys-rotate.test.ts`: the fake backend
      learned PostgREST and KV `DELETE`, and a mutation check confirmed the credential and
      rollback tests fail when those paths are broken.
  - **Worker** (this repo): the route sends `serviceRoleHeaders` (the `dashboard_worker`
    `sb_secret_` key) and `{ keyId, userId: appUserId }`. `admin-keys.test.ts` pins that the
    user's token is never forwarded.
  - **e2e** (observability-toolkit `services/e2e/api-key-auth.e2e.ts`): test 5 rotates through a
    `rotateKey` helper with `SUPABASE_PROVISIONING_KEY`, as `createKey` does. It will fail
    against dev until the dev function is redeployed.
  - Also fixed the two lint errors 24d47cd left. A rotate response with no token now shows an
    error instead of nothing (`RotateKeyResponseSchema`).
- ✅ **`KV_NAMESPACE_ID` checked 2026-10-05.** Supabase CLI `secrets list` digests, matched by sha256:
  production's names production `AUTH` (`b5a89aed…`), and dev's names dev `AUTH` (`0b323a37…`).
  `CLOUDFLARE_ACCOUNT_ID` matches the account in both projects, and `CLOUDFLARE_API_TOKEN` is set.
  The Doppler `prd` Supabase token cannot read function secrets (`edge_functions_secrets_read`);
  the CLI's own login can.
- **To ship, in order:**
  1. ✅ Check `KV_NAMESPACE_ID` (above).
  2. ✅ Deploy `api-keys-rotate` to dev (`tumhmtshahktumhqqamk`, needs the CLI's keychain login; the
     Doppler `prd` token cannot reach dev) and run the toolkit's `api-key-auth` e2e under Doppler
     `dev`. Live as version 10 since 2026-10-05 19:02Z, `verify_jwt: false` (`supabase functions
     list`). The e2e ran 2026-10-05: 11 passed, none skipped, including rotate (5), old token 401
     (6) and new token 200 (7) against the deployed dev function and dev API Worker.
  3. ✅ Deploy it to production (`cfrbahzzklwrnmbtqojl`). Live as version 30 since 2026-10-05
     19:05Z, `verify_jwt: false`, six minutes after 982605cd.
  4. ✅ for production: CI's deploy of `b62012d` (2026-10-06 04:16Z) shipped both production
     Workers, and the route's service call (2015571, fc47e66) predates it. Unchecked: the dev
     Worker, which deploys by hand and is not needed for the acceptance below.
  5. Rotate a real key from `/admin` and check the acceptance bullets below. A user's action:
     the old key stops working at once, so update `OBTOOL_API_KEY` wherever it is read.
- **Acceptance below is unmet.** Rotation works against the real dev function (step 2), but none
  has run through the production dashboard yet.

Acceptance:
- A user rotates one of their keys. The new token authenticates against obtool-api
  (`GET /v1/traces` → 200) and the old one is refused (401).
- The new key belongs to the same org as the old one (blocker 1).
- The route answers 403 to a session without `dashboard.admin`, to one with no active org, and for
  a key outside the active org. A worker test pins all three.
- Each rotation writes one `key.rotate` audit row, with no token in it.
- A rotation that fails at any step leaves the old key working and shows an error (blockers 2-3).
- The token appears once and is not found in `localStorage` or the query cache afterwards.
- `AdminPage.test.tsx` covers success, refusal, network error and cancel, using new routes in its
  fake worker.

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
