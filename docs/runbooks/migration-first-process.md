# Runbook — Migration-First Process

**Audience: operator (Sam).** How to ship a schema change to production safely. This is the
process actually used for migrations 0108–0112. Nothing here changes app behavior; it is a
procedure.

## Principle

**Production DB schema must be a superset of what the deployed code needs — always apply the
migration to production BEFORE the code that depends on it deploys.** A merged PR whose code
references a column/table not yet in production produces a 500.

## When migration-first is REQUIRED

- The PR adds/changes a column, table, constraint, RLS policy, index, or RPC **that deployed
  code reads or writes**.
- Examples this wave: 0108 (chips column written by charting), 0109 (time-format column read),
  0110 (postcare delivery mode read/written by settings), 0111 (access-events written by the
  send/verify paths), 0112 (horizon CHECK — the settings UI lets an owner pick a value the old
  CHECK would reject on save).

## When NO migration is needed

- UI-only / code-only PRs (e.g. #363–369, #371 this wave): no schema change, merge-and-deploy
  normally. Confirm with `git diff --name-only BASE...HEAD | grep supabase/migrations` = empty.

## The sequence (list → dry-run → apply → verify → merge → deploy)

Run from the repo root with the Supabase CLI linked to the **production** project.

1. **Confirm the linked project is production.** `supabase projects list` → the `linked`
   project is the intended production project (Hone).
2. **List.** `supabase migration list --linked` → confirm the remote max is the expected
   current max (e.g. 0111) and the new migration (e.g. 0112) shows as **local-only / pending**.
3. **Dry-run.** `supabase db push --linked --dry-run` → it must print **exactly** the one new
   migration filename and nothing else.
4. **STOP if the dry-run shows anything other than the single expected migration.** Do not
   apply. Investigate (a stray local migration, a mismatched branch, an out-of-order file).
5. **Apply.** `supabase db push --linked`.
6. **Verify** (all read-only — see "Verifier steps" below): remote max advanced to the new
   number; the new object exists with the intended shape (columns/CHECK/RLS/policies/grants);
   existing rows unchanged; `node scripts/verify-production.mjs` passes (or only the known
   local Upstash INCOMPLETE); `node scripts/check-stripe-gates.mjs` = 15 PASS; no new
   critical/error ops alerts.
7. **Merge** the PR only after verification passes. Vercel deploys the production branch HEAD.
8. **Post-deploy check:** remote max unchanged (no accidental extra migration); no new
   critical/error ops alerts; the feature reads/writes the new schema correctly.

For a code-only PR, skip 2–7 and just merge-and-deploy.

## Stop conditions (do not proceed)

- Dry-run shows more than the single expected migration → STOP.
- Linked project is not the intended production project → STOP.
- Verifier reports any FAIL (an INCOMPLETE that is only the local Upstash reminder heartbeat
  is acceptable) → STOP and resolve before merge.
- Stripe gates are not 15 PASS → STOP.

## Verifier steps (read-only)

- `supabase migration list --linked` — remote max.
- `supabase db query --linked "..."` — inspect the new column/CHECK/constraint/RLS/policy/grant
  via `information_schema` / `pg_constraint` / `pg_policies` (never write data to verify;
  inspect the constraint definition instead of inserting probe rows on a live table).
- `node scripts/verify-production.mjs` — production health check.
- `node scripts/check-stripe-gates.mjs` — 15 PASS.
- ops alerts: `select count(*) from public.ops_alerts where severity in ('critical','error')
  and created_at > now() - interval '1 hour'`.

## Rollback considerations

- **Prefer additive, idempotent, backward-compatible migrations** (`drop constraint if
  exists` then `add`; `add column if not exists`), so applying is safe and the *old* code
  keeps working against the new schema. This makes the migration itself effectively
  forward-compatible with the currently-deployed code.
- **Code rollback:** revert the PR merge and redeploy (the additive schema stays; old code
  runs fine against it). Do NOT reflexively roll back the migration.
- **Schema rollback** is rarely safe on a live DB (dropping a column loses data). If a
  migration is wrong, prefer a new corrective migration (as 0074 corrected 0073) over a manual
  down-migration.

## ⚠️ The 0108 code-before-schema incident (why this order matters)

For **0108 (observation chips)**, code that *writes* the new `observation_chips` column was
merged/deployed **before** the migration was applied to production, which briefly broke
production charting writes (the column did not yet exist → 500 on write). **Lesson: for any
column the deployed code WRITES, the migration MUST be applied to production BEFORE the code
merge.** 0109/0110/0111/0112 all followed migration-first correctly after this.

Read-safe columns are more forgiving: code that only *reads* a not-yet-present column via
`select *` typically degrades gracefully (undefined → default), so a read-only column is
break-safe pre-migration — but the safe default is still migration-first for everything.
