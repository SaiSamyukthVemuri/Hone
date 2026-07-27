# Rollout — migration 0155: inventory-backed probe lot linkage (PR #475)

> # ⚠️ CLOSED OUT — migration 0155 is APPLIED and PR #475 is MERGED (2026-07-25)
>
> **The procedure below is retained unchanged** as the auditable record of what was planned.
> Its pre-apply guardrails ("production does not have … until 0155 is applied", "do NOT apply
> 0155 as part of merging the app PR") describe a **completed** operation and must not be read
> as current instructions.
>
> | Field | Result |
> |---|---|
> | Migration | **0155 APPLIED to production 2026-07-25, migration-first** — dry-run showed only 0155 |
> | Application | **PR #475 MERGED** (merge `b3e044f`) + Vercel production deploy SUCCESS |
> | Current production migration max | **0157** |
> | Current runtime-bearing application HEAD | `96b28d62a5f3b9acd67d00b24c80caebd6a66e5d` |
> | Scope | Additive — durable, probe-specific, same-studio pointer from a charted block into `record_keeping_sterile_items` (`probe_key` + `session_blocks.probe_inventory_item_id`, composite same-studio FK, `ON DELETE SET NULL` — pointer-only). **No backfill; no existing row rewritten; no RLS/policy change.** |
> | Post-apply verification | PASS — objects present, no backfill, 0 unresolved ops alerts, `hone.care` 200 |
> | Human acceptance | **PENDING** — Chloe has not yet accepted this on-device. See [../production/known-limitations.md](../production/known-limitations.md) (L1) |

**Rollout model: MIGRATION-FIRST (DB-first). Application deployment must NOT
precede the migration.**

## Why DB-first (NOT app-first)

The new application code directly references columns that migration 0155 adds:

- `select record_keeping_sterile_items.probe_key` (charting inventory query,
  Records classification read);
- `select session_blocks.probe_inventory_item_id` (read before treatment-area
  updates, suggestions query);
- `write record_keeping_sterile_items.probe_key` (Records add/edit);
- `write session_blocks.probe_inventory_item_id` (charting create/update).

Production does not have `probe_key` or `probe_inventory_item_id` until 0155 is
applied. If the application PR merged first, the normal Vercel deploy would ship
code that selects/writes columns that do not yet exist, creating a mixed-version
window where charting edits and Records writes can fail. **App-first is NOT
safe for this change.**

The reverse order IS safe: the migration is additive (both columns nullable,
no backfill, no business-row mutation), and the NEW 0155 RPCs accept OLD
application payloads that omit `probe_inventory_item_id` (an absent
`jsonb_populate_record` key resolves to NULL — no link is fabricated and the
existing manual `probe_lot_number` + confirmation semantics are unchanged).
Proven in `tests/db/probe-inventory-linkage.db.test.ts` → "mixed-version".

## Rollout order

**A. Review & validate the exact PR head while it remains DRAFT.**
Confirm CI is green on the exact head; do not mark ready yet.

**B. Under separate, explicit migration-only authorization, apply migration 0155
to production BEFORE merging the application PR.**
Follow `docs/runbooks/migration-first-process.md` (list → dry-run → push →
verify). This step needs its own approval; it is not authorized by this PR.

**C. Verify in production after applying 0155:**
- migration ledger advances through `0155`;
- both new nullable columns exist
  (`record_keeping_sterile_items.probe_key`,
  `session_blocks.probe_inventory_item_id`);
- the `probe_key` length CHECK (`char_length <= 120`);
- the parent composite UNIQUE
  (`record_keeping_sterile_items (studio_id, id)`);
- the same-studio composite FK
  (`session_blocks (studio_id, probe_inventory_item_id)
   → record_keeping_sterile_items (studio_id, id)`)
  with **pointer-only** `ON DELETE SET NULL (probe_inventory_item_id)`;
- the partial index on `probe_inventory_item_id`;
- both RPC definitions
  (`create_session_block_with_areas`, `update_session_block_with_areas`)
  carry `probe_inventory_item_id`;
- RLS / policies are unchanged;
- no backfill occurred and no business row was mutated.

**D. Re-run / confirm exact-head CI and the pre-merge checks.**

**E. Mark the PR ready and merge the application code**, allowing the normal
Vercel deploy. By now production already has the columns, so there is no
mixed-version failure window.

**F. Read-only post-deploy health check.**
Load a charting session + the Records → Sterile Items page; confirm probe-lot
selection renders and no column-missing errors appear in logs. No writes needed.

## Guardrails

- No feature flag, cron, worker, or Google/Stripe/Willow interaction.
- `probe_lots` and `electrolysis_entries.probe_lot_id` stay dormant.
- Do NOT apply 0155 to production or any remote as part of merging the app PR;
  the migration is applied in step B under its own authorization.
