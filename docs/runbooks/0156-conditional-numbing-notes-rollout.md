# Rollout — migration 0156: conditional numbing notes

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
