# Rollout — migration 0157: whole-session "Copy areas and settings"

**Rollout model: MIGRATION-FIRST (DB-first). Application deployment must NOT
precede the migration.**

## Phase B refresh (reconciled onto the deployed Phase A base)

This PR was refreshed onto production head `3cabdca` (Phase A charting correction,
**already deployed** to hone.care). The refresh reconciles the whole-session copy
to Phase A's current charting contract:

- **Galvanic intensity is a RETIRED reading — never copied.** `galvanic_intensity_percent`
  is removed from every whole-session-copy surface (draft/normalizer types, editable
  copy card, source-read projection, normalized spec, source fingerprint). Copy still
  carries valid galvanic mA / duration / units-of-lye / thermolysis readings / pulse.
  A copied destination entry **always stores `galvanic_intensity_percent = NULL`**:
  the `copy_session_setup` RPC inserts a **literal NULL** regardless of the spec, so
  even a forged spec carrying `galvanic_intensity_percent = 42` stores NULL. The
  source fingerprint **excludes** the field, so a historical change to only that
  retired value can't invalidate a preview. Historical source rows are untouched.
- **PicoBlend precision preserved.** The editable copy card uses galvanic mA
  `step="0.01"` and thermolysis duration `step="0.001"`, labels the pulse control
  "Thermolysis pulse count" (inside the thermolysis section), and has no galvanic
  intensity field. Chloe's exact `0.74 mA` / `0.733 s` round-trip through
  descriptor → preview → normalizer → RPC → destination DB unchanged.
- ~~**Migration 0157 remains UNAPPLIED in production** (prod migration max stays **0156**).~~
  **SUPERSEDED — 0157 was APPLIED 2026-07-27T02:01:29Z and PR #478 MERGED at 13:12:34Z
  (merge `96b28d6`); production migration max is now 0157.** 0157 was updated **in place**
  (no 0158). See the **CLOSEOUT** section at the end of this file.

~~Migration authorization for 0157 is still required and has NOT been granted.~~
**Superseded — authorization was granted and the migration-first apply was executed.**

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
  previous session itself (`_whole_session_copy_source_id`); a browser value
  cannot redirect it, and the browser's expected source id must match. VOID
  source sessions are excluded (draft + finalized remain valid); a legacy block
  (nonblank `primary_area`, no structured area) is copyable. The SAME descriptor
  gates the page panel and the commit, so page and commit never disagree.
- **Target is verified under a row lock** (`FOR UPDATE`): same studio,
  electrolysis, draft (not finalized/void), not deleted, and EMPTY. The lock
  serializes every copy for one target regardless of the idempotency key, so two
  races cannot both create a batch.
- **Source is pinned against concurrent edits**: after deriving the source the
  RPC locks the source session + all its active blocks/areas/entries `FOR UPDATE`
  (deterministic order → no deadlocks); those locks also block phantom child
  INSERTs via FK `FOR KEY SHARE` conflicts. The fingerprint is then computed
  under the locks.
- **Stale source is fail-closed**: the RPC recomputes the source fingerprint in
  the transaction and rejects if it changed since the preview — zero rows. The
  read path also re-checks the descriptor after loading source rows so a preview
  never returns rows from a different revision than its fingerprint.
- **Preview is EPHEMERAL + editable**: cards can be edited (areas, laterality,
  mode, probe, readings) entirely in component state — zero writes until the one
  explicit commit. The request hash is SHA-256 over target + source id + source
  fingerprint + specs.
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

---

# CLOSEOUT — executed 2026-07-27

**The procedure above is retained unchanged.** It remains the auditable record of what was
planned and why, and is useful for audit and incident review. This section records what
actually happened.

| Field | Result |
|---|---|
| **Migration apply** | **`0157_whole_session_copy_setup.sql` APPLIED to production 2026-07-27T02:01:29Z**, migration-first — *before* the application PR merged. Applied from the whole-session-copy worktree at PR #478 head `1dbca69`, linked to the production project after an explicit project-ref guard check. The dry-run showed **only** 0157. The apply was clean: **no notices, no warnings, no errors.** |
| **Application merge** | **PR #478 MERGED 2026-07-27T13:12:34Z**, merge commit `96b28d62a5f3b9acd67d00b24c80caebd6a66e5d`, base `claude/build-hone-saas-hOex7`, reviewed head `1dbca69f…`, expected-head-guarded. |
| **Vercel deployment** | `dpl_nZ6UBkGhK8vTAs8butVWwqNFXqmb` — status **Ready**, target production, built from `96b28d6…`, aliased to `hone.care` and `www.hone.care`. Created 13:12:37Z, 3 seconds after the merge. |
| **Final application SHA** | **`96b28d62a5f3b9acd67d00b24c80caebd6a66e5d`** — the current runtime-bearing HEAD. |
| **Final migration max** | **0157.** Hosted == repo; 157 migrations applied, each exactly once; **no `0158`+**. |
| **Review** | 5 review rounds. Round 5 closed a P1 on ledger privileges — `session_copy_operations` now has `revoke all from public, anon, authenticated` plus `grant select to authenticated`, closing TRUNCATE / REFERENCES / TRIGGER, which **RLS does not protect**. Final round: 0 P0 / 0 P1. |

## Verification results (re-verified 2026-07-27 at the current baseline)

Every item in step **C** of the procedure above was confirmed directly against production:

- **Migration ledger** advances through `0157`, applied exactly once, nothing beyond it.
- **`public.session_copy_operations` exists**, with the `(target_session_id,
  idempotency_key)` UNIQUE and two same-studio composite foreign keys.
- **Table privilege matrix** (`has_table_privilege`):

  | Role | SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER |
  |---|---|---|---|---|---|---|---|
  | `anon` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | `authenticated` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
  | `service_role` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

- **`copy_session_setup`** exists, is `SECURITY DEFINER` with `search_path=""`, and EXECUTE is
  **FALSE for both `anon` AND `authenticated`**, TRUE for `service_role`.
- **`whole_session_copy_source_descriptor`** EXECUTE is TRUE for `authenticated`, FALSE for
  `anon`.
- **`_whole_session_copy_fingerprint` and `_whole_session_copy_source_id`** are not executable
  by `authenticated` or `anon` — private helpers, service_role only.
- **No existing table, column, index, policy or grant changed; no backfill.**
- Health: `hone.care` 200, `/login` 200, `/dashboard` 307 (auth redirect). 0 unresolved
  `ops_alerts`.

## Zero-data-operation posture

**The deployment verification deliberately performed ZERO copy operations.**

- `session_copy_operations` holds **0 rows**. No real whole-session copy has ever been
  performed in production.
- Verification was **source inspection plus browser testing only** — the deployed source was
  confirmed to contain the zero-write preview, the visit-date and editable/removable cards,
  the single commit CTA, the service-role RPC call, the authenticated descriptor, the
  exclusion of galvanic intensity / minutes / outcomes, and the literal-NULL galvanic write.
- No feature flag, cron, worker, or Google / Stripe / Willow interaction was involved.
- `probe_lots` and `electrolysis_entries.probe_lot_id` remain **dormant** — neither read nor
  written.

**Consequence for documentation: whole-session copy is `DB applied + merged + deployed +
enabled + NOT production exercised`.** It must not be described as production-exercised
merely because the deployment succeeded.

## Rollback posture

- **Application:** a straight code revert of the merge commit, or redeploying the previous
  production build.
- **Migration:** 0157 is **additive** — one table plus four functions, no backfill and no
  mutation of any existing clinical object. Reverting the application leaves the DB objects
  in place and **unused**; nothing else reads or writes them. There is therefore no forced
  migration rollback, and no data to restore.
- Because the ledger has **0 rows**, a revert at this point cannot orphan or strand any
  provenance record.

## Human acceptance

**PENDING.** Chloe has not performed a real whole-session copy. The first real copy is the
outstanding gate — after it, confirm that **exactly one** ledger row appears and that the
destination records match the reviewed preview. See
[../production/known-limitations.md](../production/known-limitations.md) (L1, L2).
