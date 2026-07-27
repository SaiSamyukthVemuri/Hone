# Rollout — migration 0156: conditional numbing notes

> # ⚠️ CLOSED OUT — migration 0156 is APPLIED and PR #477 is MERGED (2026-07-26)
>
> **The procedure below is retained unchanged** as the auditable record of what was planned.
> Its pre-apply guardrails ("production does not have … until 0156 is applied", "do NOT apply
> 0156 as part of merging the app PR") describe a **completed** operation and must not be read
> as current instructions.
>
> | Field | Result |
> |---|---|
> | Migration | **0156 APPLIED to production 2026-07-26, migration-first** — dry-run showed only 0156 |
> | Application | **PR #477 MERGED** (merge `8ed61ae`) + Vercel production deploy SUCCESS |
> | Current production migration max | **0157** |
> | Current runtime-bearing application HEAD | `96b28d62a5f3b9acd67d00b24c80caebd6a66e5d` |
> | Scope | Additive — one nullable `session_blocks.numbing_notes` column plus both atomic RPCs taught to carry it. **No backfill; no existing row rewritten; no RLS/policy change.** |
> | Post-apply verification | PASS — objects present, no backfill, 0 unresolved ops alerts, `hone.care` 200 |
> | Human acceptance | **PENDING** — Chloe has not yet accepted this on-device. See [../production/known-limitations.md](../production/known-limitations.md) (L1) |

**Rollout model: MIGRATION-FIRST (DB-first). The application deployment must NOT
precede the migration.**

## Why DB-first (NOT app-first)

The new application code selects and writes `session_blocks.numbing_notes`:

- charting reads `block.numbing_notes` to reopen an edit with the note populated;
- the create/update treatment-area actions write `numbing_notes` (via the atomic
  RPCs) whenever the saved numbing status is `used`.

Production does not have the `numbing_notes` column until 0156 is applied. If the
application PR merged first, the normal Vercel deploy would ship code that
selects/writes a column that does not yet exist, creating a mixed-version window
where charting create/update could fail. **App-first is NOT safe.**

The reverse order IS safe: 0156 is additive (one nullable column, no default, no
backfill, no RLS/policy/trigger change), and the NEW 0156 RPCs accept OLD
application payloads that omit `numbing_notes` — `jsonb_populate_record` resolves
an absent key to NULL, so no note is fabricated and all existing `numbing_status`
behaviour is unchanged. Proven in `tests/db/numbing-notes.db.test.ts`
("old-app payload").

## Rollout order

**A.** Review + validate the exact PR head while it remains DRAFT (exact-head CI
green).

**B.** Under separate, explicit migration-only authorization, apply migration
0156 to production **BEFORE** merging the application PR. Follow
`docs/runbooks/migration-first-process.md` (list → dry-run → push → verify). This
step needs its own approval.

**C.** Verify in production after applying 0156:
- migration ledger advances through `0156`;
- `session_blocks.numbing_notes` exists, `text`, nullable, no default;
- `count(*) where numbing_notes is not null` = 0 (no backfill);
- both RPC definitions (`create_/update_session_block_with_areas`) contain
  `numbing_notes`;
- RLS / policies unchanged; no new trigger; no business-row mutation.

**D.** Re-run / confirm exact-head CI + pre-merge checks.

**E.** Mark the PR ready and merge the application code — the normal Vercel
production deploy. By now production already has the column, so there is no
mixed-version failure window.

**F.** Read-only post-deploy health check: load a charting session; select
"Numbing used" and confirm the notes field appears; confirm no column-missing
errors in logs. No writes needed.

## Guardrails

- No feature flag, cron, worker, or Google/Stripe/Willow interaction.
- `probe_lots` and `electrolysis_entries.probe_lot_id` stay dormant.
- Do NOT apply 0156 to production or any remote as part of merging the app PR;
  the migration is applied in step B under its own authorization.
