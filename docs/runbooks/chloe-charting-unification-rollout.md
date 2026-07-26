# Rollout — Chloe charting correction (unified findings box, galvanic-intensity removal, pulse relabel)

**Type: CODE-ONLY. No migration. No schema change. No data backfill. No dropped column.**

## What changes

1. **One unified "Treatment observations & skin response" box** — a single merged
   multi-select chip list (observation presets + the former reaction labels),
   stored in `electrolysis_entries.observation_chips` (the canonical multi
   column going forward). The legacy `session_blocks.reaction_type` is folded in
   on load and preserved on save (see historical behavior below).
2. **Galvanic intensity %** removed as an active input (historical values kept).
3. **Pulse count** moved into the thermolysis section, relabeled **"Thermolysis
   pulse count"** (thermo + blend; pure galvanic has none).
4. **Additional notes** enlarged (~8 rows / ≥12rem).

## Historical-data behavior (conservative — no loss)

- **`reaction_type`**: never destructively backfilled. On load it is folded into
  the merged chip selection (shown as a selected chip). On save it is **preserved
  while its chip stays selected** and **cleared only when the practitioner
  explicitly deselects that reaction**. It is **never invented** from chips and a
  single value is **never guessed** from multiple selected reactions. New records
  keep `reaction_type` NULL and represent reactions as chips.
- **`galvanic_intensity_percent`**: the column and all historical values are
  preserved. **Server-authoritative write policy (final amendment):** the field
  is a fully RETIRED reading. No current form captures, hydrates, or sends it, and
  it is NOT part of the in-form "Copy settings" reusable contract (never copied,
  even from a source that still carries a value). The server is authoritative:
  - **Every NEW entry stores `NULL`** — `createTreatmentAreaWithEntryAction`, the
    `addElectrolysisEntryAction` "add another pass" path, and the "first entry
    absent" branch of `updateTreatmentAreaWithEntryAction` all set it explicitly to
    `null` and ignore any browser-supplied / forged value (verified end-to-end,
    including a forged request carrying `42`).
  - **Existing historical rows are preserved by OMISSION** — the shared reading
    column helper no longer emits `galvanic_intensity_percent`, so an UPDATE leaves
    the stored value untouched (never wiped, never round-tripped through a hidden
    browser-controlled field). Editing an unrelated field on a legacy galvanic
    entry keeps its recorded intensity exactly.
  **Display policy (Policy A — omit from clinical display, keep in raw data):**
  the deprecated reading is NO LONGER shown as a current galvanic `%` in any
  practitioner-facing clinical surface (removed from the entry-row Galvanic line;
  it was not shown in clinical summaries, previews, or print). It **remains in the
  raw data export** (`settings/data` CSV keeps the `galvanic_intensity_percent`
  column) for record integrity/history. No backfill, no null-out, no dropped
  column. (Rationale: it is no longer a current concept; showing an unlabeled
  historical `%` beside current readings would read as a live setting.)
- **Thermolysis duration display precision**: `formatSeconds` preserves the exact
  stored value to 3 decimal places, so Chloe's PicoBlend `0.733s` displays as
  "0.733 seconds" (never a lossy "0.73 seconds"). Trailing zeros are still
  trimmed; there is no float-formatting noise. DB storage + raw export were always
  exact; this closes the display gap.

## Saved-record unified presentation

The saved-record view presents reactions as ONE unified findings concept:
- New/migrated reactions render as **chips** in the entries (alongside observation
  chips) — no separate reaction section.
- **Client tolerance** stays its own clearly-labeled line.
- Un-migrated legacy data is shown **explicitly labeled as legacy**: a legacy
  `reaction_type` not yet captured as a chip renders as `Legacy skin response: X`
  (deduped — never shown when the same reaction is already a chip, so a migrated
  record never double-shows), and a legacy `reaction_notes` renders as
  `Legacy response note: …`. The old split "Client / skin response" reaction
  section is gone. Existing history stays intact.
- **Legacy free-text `comments`**: a comment token equal to a reaction word is
  **not** promoted to a coded reaction chip (no string-guessing); it stays as
  free-text, exactly as before.
- **Finalized records** are frozen by the 0119 write guard — reaction
  preserve/clear only ever happens on DRAFT sessions.

## Query & analytics behavior

- Every reaction-driven surface (Clients-needing-attention, treatment
  intelligence, clinical summary "from last visit", onboarding completeness,
  saved-record display, data export) reads the **unified representation** via one
  shared helper (`lib/sessions/reaction-unified.ts`): the union of legacy
  `reaction_type` and the canonical reaction chips in the block's **live** entries'
  `observation_chips`. Reactions are classified **only** by the explicit reaction
  labels — never guessed from ordinary observation chips.
- Reads are **set-based, studio-scoped, single embedded queries** (PostgREST
  `electrolysis_entries(observation_chips, deleted_at)` joins) — **no N+1**, no
  cross-studio leakage.
- Attention severity uses the existing reaction enum order; "No visible reaction"
  never flags and never suppresses a real reaction; multiple reactions are
  retained in summaries. The UI prevents contradictory combinations ("No visible
  reaction" is mutually exclusive with real reactions).

## Rollout order

**A.** Validate the exact PR head while DRAFT (all exact-head CI lanes green).
**B.** Independent patient-safety + data-integrity review — no unresolved P0/P1.
**C.** (Under explicit authorization) mark ready + merge to
`claude/build-hone-saas-hOex7`. Vercel auto-deploys to hone.care.
**D.** Post-deploy health: on a client with prior reactions, confirm the
"Clients needing attention" card + treatment intelligence still surface the
reaction; chart a new session, select a reaction chip, save, and confirm it
persists as a chip and surfaces on the dashboard. No destructive test.

## Rollback plan

Because the change is **code-only**, rollback is a straight code revert:

1. `git revert` the merge commit (or redeploy the previous production build).
2. Vercel redeploys the prior code. **No migration to undo, no data to restore.**

**Rollback data caveat (important):** records edited/created while the new code
was live may have reactions stored as chips in `observation_chips` (with
`reaction_type` NULL for new records). The OLD code reads `reaction_type` only,
so after a rollback a reaction captured *solely* as a chip would not surface on
the old reaction-driven surfaces until re-deployed. **No data is lost** — the
reaction remains in `observation_chips`; only the old code doesn't read it.
Prefer rolling forward (fix + redeploy) over a rollback if new-code records
already exist. There is no schema/data migration in either direction.
