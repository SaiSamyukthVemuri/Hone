# Rollout — migration 0157: whole-session "Copy areas and settings"

**Rollout model: MIGRATION-FIRST (DB-first). Application deployment must NOT
precede the migration.**

## Why DB-first (NOT app-first)

The new application code references brand-new database objects that 0157 adds:

- the commit action calls `public.copy_session_setup(...)` (service_role-only);
- the read action calls `public.whole_session_copy_source_descriptor(...)`;
- both depend on the `session_copy_operations` ledger + the private
  `_whole_session_copy_fingerprint` / `_whole_session_copy_source_id` helpers.

Production does not have these until 0157 is applied. If the application PR merged
first, the normal Vercel deploy would ship code that calls missing functions, so
the copy path would fail. **App-first is NOT safe.**

The reverse order IS safe: 0157 is purely additive — one new table + four new
functions, brand-new objects the currently-deployed application never references.
Applying it early changes no existing table, column, index, policy, grant, or the
0129/0155/0156 block/area RPCs, and backfills nothing.

## Security model (what the migration enforces)

- **`copy_session_setup` is service_role-ONLY** (revoked from `anon` +
  `authenticated`). The browser cannot call it directly; only the authenticated
  server action invokes it, passing a **server-derived** studio + practitioner id
  (never a browser-supplied id). The RPC independently re-verifies the
  practitioner is an active member.
- **Source is server-authoritative**: the RPC derives the canonical eligible
  previous session itself; a browser value cannot redirect it.
- **Target is verified under a row lock** (`FOR UPDATE`): same studio,
  electrolysis, draft (not finalized/void), not deleted, and EMPTY. The lock
  serializes every copy for one target regardless of the idempotency key, so two
  races cannot both create a batch.
- **Stale source is fail-closed**: the RPC recomputes the source fingerprint in
  the transaction and rejects if it changed since the preview — zero rows.
- **Setup-only, no performed minutes**: outcomes are never copied, and
  `minutes_performed` is deliberately excluded so today's metrics never report
  minutes that have not occurred.
- **Provenance ledger**: `session_copy_operations` records source + target +
  practitioner + request hash + source fingerprint + created ids (no clinical
  payload); written only by the RPC; member-only read.

## Rollout order

**A.** Review + validate the exact PR head while it remains DRAFT (exact-head CI
green).

**B.** Under separate, explicit migration-only authorization, apply migration
0157 to production **BEFORE** merging the application PR
(`docs/runbooks/migration-first-process.md`: list → dry-run → push → verify).

**C.** Verify in production after applying 0157:
- migration ledger advances through `0157`;
- table `public.session_copy_operations` exists with the `(target_session_id,
  idempotency_key)` UNIQUE, the two same-studio composite FKs, and member-only
  RLS (no browser insert/update/delete);
- `copy_session_setup` exists, `security definer`, and EXECUTE is FALSE for both
  `anon` AND `authenticated`, TRUE for `service_role`;
- `whole_session_copy_source_descriptor` EXECUTE is TRUE for `authenticated`,
  FALSE for `anon`; the `_whole_session_copy_*` helpers are not executable by
  `authenticated`;
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
