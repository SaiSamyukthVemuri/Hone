# Rollout — migration 0157: whole-session "Copy areas and settings"

**Rollout model: MIGRATION-FIRST (DB-first). Application deployment must NOT
precede the migration.**

## Why DB-first (NOT app-first)

The new application code references brand-new database objects that 0157 adds:

- it calls the RPC `public.copy_session_setup(...)` on commit;
- it reads/writes the `session_copy_operations` idempotency ledger (via the RPC).

Production does not have the RPC or the ledger table until 0157 is applied. If
the application PR merged first, the normal Vercel deploy would ship code that
calls a missing function, so the commit path would fail. **App-first is NOT
safe.**

The reverse order IS safe: 0157 is purely additive — one new table + one new RPC,
brand-new objects the currently-deployed application never references. Applying it
early changes no existing table, column, index, policy, grant, or the
0129/0155/0156 block/area RPCs, and backfills nothing.

## Rollout order

**A.** Review + validate the exact PR head while it remains DRAFT (exact-head CI
green).

**B.** Under separate, explicit migration-only authorization, apply migration
0157 to production **BEFORE** merging the application PR
(`docs/runbooks/migration-first-process.md`: list → dry-run → push → verify).

**C.** Verify in production after applying 0157:
- migration ledger advances through `0157`;
- table `public.session_copy_operations` exists with the `(session_id,
  idempotency_key)` UNIQUE and member-only RLS (no browser insert/update/delete);
- RPC `copy_session_setup` exists, `security definer`, anon EXECUTE = false;
- no existing table/column/index/policy/grant changed; no backfill.

**D.** Re-run / confirm exact-head CI + pre-merge checks.

**E.** Mark the PR ready and merge the application code — normal Vercel deploy.
By now production already has the RPC + ledger, so the commit path works and
there is no missing-function window.

**F.** Read-only post-deploy health check: on an empty electrolysis chart with a
prior session, open the copy preview (confirm it renders and creates nothing),
then confirm a committed copy creates the reviewed blocks. No destructive test.

## Guardrails

- The preview is EPHEMERAL — it must create zero blocks/areas/entries/operations
  until the explicit "Add these areas to today's chart" commit.
- No feature flag, cron, worker, or Google/Stripe/Willow interaction.
- `probe_lots` and `electrolysis_entries.probe_lot_id` stay dormant.
- Do NOT apply 0157 to production or any remote as part of merging the app PR;
  it is applied in step B under its own authorization.
