# Phase 4: Legacy Schema Cleanup — Implementation Guide

Parent roadmap: [`docs/roadmap/users.md`](users.md) (Phase 4 open items at lines 735–738)

Last updated: 2026-03-21

---

## Status

| Task | Type | Status |
|------|------|--------|
| Verify `public.users.id` = `auth.users.id` alignment | SQL (read-only) | [ ] Pending |
| Rename `auth0_id` → `identity_subject` | DB migration | [ ] Pending |
| Drop `user_profiles.role` column | DB migration | [ ] Pending |
| AppSession code simplification (optional) | TypeScript | [ ] Optional |

**Execution order**: verify ID alignment first → rename `auth0_id` → drop `user_profiles.role`.
Do not run destructive steps before verification passes.

---

## Audit Summary

### What was audited

All TypeScript source files, Zod schemas (`src/lib/validation/auth-schemas.ts`), worker routes (`worker/index.ts`), and frontend components were scanned for references to `auth0_id`, `user_profiles`, and any direct auth-to-app user mapping logic.

### Findings

| Column | Table | Code References | Action |
|--------|-------|-----------------|--------|
| `auth0_id` | `public.users` | Zero — not in any `.ts` file, schema, or route | DB-only rename; no code changes needed |
| `role` | `user_profiles` | Zero — `user_profiles` not queried anywhere | DB-only column drop; no code changes needed |
| `auth_user_links` | (never created) | N/A — documented as contingency only | No action needed |

### ID alignment finding

`worker/index.ts:131` queries `public.users` with `id=eq.${authUserId}`, where `authUserId` comes from the Supabase `auth.users` JWT. This assumes `public.users.id = auth.users.id` for all rows.

`AppSession` (`src/types/auth.ts`) tracks `authUserId` and `appUserId` as separate fields. In the current worker flow they will be equal if IDs are aligned — but the schema supports them diverging. Verify before removing the distinction.

---

## Task 1: Verify ID Alignment

Run this query against the Supabase DB (read-only). It returns any `public.users` rows whose `id` does not match an `auth.users` row with the same `id`.

```sql
-- Returns rows where public.users.id has no matching auth.users record.
-- If this returns zero rows, IDs are fully aligned.
select
  u.id,
  u.email,
  u.created_at
from public.users u
left join auth.users au on au.id = u.id
where au.id is null
order by u.created_at;
```

**Expected result**: zero rows. If any rows are returned, those users were created before Supabase Auth became canonical. Resolve them manually before proceeding.

Secondary check — confirm no `auth.users` row has a mismatched `public.users` record:

```sql
-- Returns auth users with no matching public.users row.
-- These users can authenticate but have no app record (they would be rejected at the worker).
select
  au.id,
  au.email,
  au.created_at
from auth.users au
left join public.users u on u.id = au.id
where u.id is null
order by au.created_at;
```

Both queries should return zero rows before proceeding.

---

## Task 2: Rename `auth0_id` to `identity_subject`

No TypeScript changes are required. `auth0_id` has zero code references. `PublicUserSchema` in `src/lib/validation/auth-schemas.ts` only selects `id`, `email`, `created_at`, `updated_at` — the column is not projected or parsed anywhere.

### Verify first

```sql
-- Confirm auth0_id exists and check current nullability/usage.
select
  column_name,
  data_type,
  is_nullable,
  column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name = 'auth0_id';
```

Check for any non-null values:

```sql
select count(*) as populated_rows
from public.users
where auth0_id is not null;
```

### Rename

```sql
alter table public.users
  rename column auth0_id to identity_subject;
```

### Verify after

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name = 'identity_subject';
```

Should return one row. Also confirm `auth0_id` no longer exists:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'users'
  and column_name = 'auth0_id';
```

Should return zero rows.

---

## Task 3: Drop `user_profiles.role`

No TypeScript changes are required. `user_profiles` is not queried anywhere in the codebase. RBAC is sourced exclusively from `user_roles` joined to `roles.permissions`.

### Verify first

Confirm `role` exists and that the column has no unexpected dependencies (views, functions):

```sql
select
  column_name,
  data_type,
  is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_profiles'
  and column_name = 'role';
```

Check for any populated values before dropping:

```sql
select count(*) as rows_with_role
from public.user_profiles
where role is not null;
```

Check for dependent views:

```sql
select
  dependent_ns.nspname as dependent_schema,
  dependent_view.relname as dependent_view
from pg_depend
join pg_rewrite on pg_depend.objid = pg_rewrite.oid
join pg_class as dependent_view on pg_rewrite.ev_class = dependent_view.oid
join pg_class as source_table on pg_depend.refobjid = source_table.oid
join pg_attribute on
  pg_depend.refobjid = pg_attribute.attrelid
  and pg_depend.refobjsubid = pg_attribute.attnum
join pg_namespace dependent_ns on dependent_view.relnamespace = dependent_ns.oid
join pg_namespace source_ns on source_table.relnamespace = source_ns.oid
where source_table.relname = 'user_profiles'
  and pg_attribute.attname = 'role'
  and source_ns.nspname = 'public';
```

Should return zero rows. If any views depend on this column, drop or redefine them first.

### Drop

```sql
alter table public.user_profiles
  drop column role;
```

### Verify after

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'user_profiles'
  and column_name = 'role';
```

Should return zero rows.

---

## Optional: AppSession Code Simplification

This is safe to do **only after** Task 1 confirms full ID alignment.

Currently `AppSession` (`src/types/auth.ts`) carries both `authUserId` and `appUserId`. In `worker/index.ts`, the middleware sets both fields — but if `public.users.id` is always equal to `auth.users.id`, `appUserId` is redundant.

The worker already queries `public.users` with `id=eq.${authUserId}` and then sets `appUserId = userResult.data.id`. They are the same value.

**If you choose to simplify:**

1. Remove `appUserId` from `AppSession` in `src/types/auth.ts`.
2. In `worker/index.ts`, replace all `appUserId` references with `authUserId`. The `user_roles` query at line 156 uses `user_id=eq.${appUserId}` — update to `authUserId`.
3. Remove the `appUserId` variable from the middleware closure.
4. Remove `appUserId` from the `c.set('session', ...)` call at line 189.

**Do not do this** if the verification in Task 1 returns any misaligned rows. In that case, keep `appUserId` as a distinct field that stores the actual `public.users.id` value retrieved from the DB.

---

## Testing and Verification

After each migration, run the full worker test suite:

```bash
cd dashboard && npm test
```

Confirm the worker still authenticates correctly end-to-end:

1. Sign in via the dashboard login page
2. Verify `/api/me` returns `200` with correct `roles`, `permissions`, `allowedViews`
3. Verify a protected route (e.g. `/api/dashboard`) returns `200` for a user with `dashboard.read`
4. Verify a route returns `403` for a user without the required permission
5. Check Supabase logs for any column-not-found errors after the rename/drop

TypeScript compilation should remain clean throughout — neither column is referenced in any `.ts` file:

```bash
npx tsc --noEmit
```

No changes to Zod schemas are expected. `PublicUserSchema` selects only `id`, `email`, `created_at`, `updated_at` and is unaffected by either migration.
