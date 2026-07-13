# Willow workflow overnight remediation — audit + execution plan

Base: production HEAD `6a2e64074871b92069d4dea795a9d9e167820d97`, migration max `0127`.
Read-only audit via parallel探针; each item: current behaviour → source of truth →
root cause → migration → chosen implementation → PR → status. No production data
was read into this doc (no PHI).

Migration ownership (sequencing rule): the multi-area/laterality work owns **0128**
(child table) **and 0129** (atomic write RPCs — the delete-then-insert app write
was a data-loss risk, corrected to two SECURITY DEFINER functions). Disinfactant
notifications, if pursued, therefore take **0130** on their own branch. No two
unrelated branches share a number.

---

## 1. Observation-chip confidence (complaint #1) — SHIPPED (no migration)

- **Source of truth:** `lib/observation-chips.ts` (canonical labels + aliases +
  strict verify), `lib/constants.ts` `COMMON_COMMENTS`, chip toggles in
  `block-setup-form.tsx` (~1342) + `simplified-entry-form.tsx` (~397), free-text
  `comments` textarea below each.
- **Root cause:** NOT data loss (chips persist to `observation_chips`, free text to
  `comments`, proven post-PR#411). It's a confidence gap: nothing between the chips
  and the note tells the practitioner what will be saved.
- **Fix:** new `components/selected-observations.tsx` read-out ("`a · b · c`" or "No
  observations selected"), rendered adjacent to the chips in both forms; the free-text
  box relabelled **Additional notes** with placeholder "Add any details not covered by
  the observations above". Chips still save only to `observation_chips`; free text only
  to `comments`. `aria-pressed` unchanged; `aria-live="polite"` summary.
- **PR:** chips+vocab (this PR). **Migration:** none.

## 9. Observation-vocabulary cleanup (complaint #9) — SHIPPED (no migration)

- **Source of truth:** `COMMON_COMMENTS` had jargon-only `"Erythema"` + `"Slight edema"`.
- **Fix:** canonical labels → `"Redness (erythema)"`, `"Slight swelling (edema)"` (one
  option per concept, plain + medical). Legacy stored `"Erythema"`/`"Slight edema"`
  resolve via new exact-token aliases in `OBSERVATION_CHIP_ALIASES` (also `redness`,
  `slight swelling`). **No backfill, no row rewrite.** Clinically-distinct laser chips
  (`Follicular erythema`/`Follicular edema`) are untouched (exact-token, not substring).
- **PR:** chips+vocab (this PR). **Migration:** none.

## 2 + 3. Multiple areas under one settings block + structured laterality (complaints #2, #3) — IMPLEMENTED (PR #417), migrations 0128 + 0129

- **Source of truth:** `session_blocks` has single `primary_area` + block-level `side`
  (`0039`: center/left/right/bilateral/n a) + `custom_area_detail`; per-entry
  `electrolysis_entries.areas text[]` (`0017`). One block = one area + one side today.
- **Root cause:** block-level `side` cannot express Left cheek + Right sideburn in ONE
  settings block; there is no per-area laterality.
- **Selected implementation (additive, non-destructive):** new child table
  `session_block_areas (id, block_id, studio_id, area, side, custom_detail, position,
  created_at)` — one row per treated area, each with its own laterality; same-studio
  composite FK to `session_blocks (id, studio_id)`, RLS via `is_studio_member`. Read
  paths prefer child rows and **fall back to legacy** `primary_area`/`side`/`areas[]`
  when none exist. New saves write child rows. Display/print/history/export render
  combined labels ("Left cheek", "Right sideburn", "Bilateral cheeks"). "Apply this side
  to all" shortcut. Product language: "New treatment area" → "Add settings block /
  Add areas with different settings". **Migration 0128.**
- **PR:** #417 (`claude/willow-multi-area-charting-ui`, owns 0128 + 0129).
  **Status:** IMPLEMENTED + CI-green. 0128 applied + deployed (schema foundation);
  **0129 (atomic write RPCs) pending migration-first apply then merge** (approval-
  gated). `components/multi-area-editor.tsx` ("Areas treated with these settings",
  add-never-replace, per-area laterality, apply-to-all); the atomic RPCs write
  block + projection + the complete area set in one transaction with optimistic
  concurrency; the shared `blockAreasLabel()` resolver renders **every** area +
  laterality on **all** surfaces (charting, history, summaries, treatment-memory,
  records, clinical export, photos, search); full iPad release E2E. No backfill;
  legacy records render unchanged.

## 6. Probe-lot inventory selector (complaint #6) — IMPLEMENTED (PR #417, no migration)

- **Source of truth:** `record_keeping_sterile_items` (`0085`) holds probe lots;
  `session_blocks.probe_lot_number` is the charted snapshot; `getProbeLotSuggestions`
  + `resolveProbeLotSuggestion` already suggest the last-used lot per probe;
  block-setup-form free-text lot input (~1002) + confirm (`0095`).
- **Selected implementation:** a searchable selector sourced from ACTIVE sterile-item
  probe-lot records for the studio (RLS-scoped), preserving the free-text snapshot on
  the block (archiving inventory never changes charted history) + manual override;
  preselect only when exactly one active lot; clear "No active probe lots" empty state.
  Likely **no migration** (snapshot column exists; optional inventory-id link is a small
  additive column if we choose to store it).
- **PR:** #417. **Status:** IMPLEMENTED + CI-green (no migration). Source of truth =
  `record_keeping_sterile_items` probe rows (the dormant legacy `probe_lots` table is
  NOT used). `lib/record-keeping/probe-lot-inventory.ts` (active = not past expiry;
  expired stays selectable but flagged + last; dedup; suggest only the single active
  or a last-used active — never silently pick) + `components/probe-lot-select.tsx`
  (searchable; manual entry always available; "No active probe lots found" empty
  state + inventory link; iPad-friendly). Saved lot stays the free-text snapshot on
  `session_blocks.probe_lot_number` (no FK), written in the same atomic mutation as
  the areas — archiving/expiring a lot never rewrites past charting.

## 4. Compact payment panel (complaint #4) — DESIGNED (no migration)

- **Source of truth:** payment card component on the session page + `lib/billing/*`
  actions; renders PaymentIntent/charge/account/attempt ids, raw responses, full receipt
  email, failure codes.
- **Selected implementation:** compact card (Paid/Ready/Failed/Refunded + amount +
  concise date + "Receipt sent"/masked destination); technical fields owner-only behind
  a collapsed "Technical payment details". **No change to payment execution.** All values
  retained in storage/audit. **No migration.**
- **PR:** willow-payment-checkout-ux. **Status:** deferred; designed.

## 5. Quick checkout (complaint #5) — DESIGNED (no migration)

- **Source of truth:** existing prepare → confirm → execute → receipt session-payment
  actions (`lib/billing/session-payment-charge.ts` + action files); dashboard "today"
  surfaces + calendar appointment actions.
- **Selected implementation:** a "Checkout" entry point from today's schedule/dashboard/
  calendar opening a compact modal that REUSES the existing prepare/confirm/execute/
  receipt actions (no new Stripe logic, no bypass, idempotency + mode isolation +
  connected-account routing preserved). **No migration.**
- **PR:** willow-payment-checkout-ux. **Status:** deferred; designed.

## 7. Client-page outside-hours booking parity (complaint #7) — DESIGNED (no migration)

- **Source of truth:** `app/(app)/clients/[id]/BookAppointment.tsx` + `booking-actions.ts`;
  the calendar quick-book flow already has an owner-only outside-hours override.
- **Selected implementation:** reuse the calendar override contract (same server param +
  owner check + audit metadata) from the client-page Book flow; explicit warning + off by
  default; non-owners never get it; public booking cannot pass it. **No migration.**
- **PR:** client-booking-outside-hours-parity. **Status:** deferred; designed.

## 8. Disinfectant notification-centre integration (complaint #8) — DESIGNED, migration 0130

- **Source of truth:** `record_keeping_disinfectants` (`0096`: `discard_due_date`,
  `date_discarded`); read-time alert only today. `practitioner_notifications` (`0070`) —
  **no DB CHECK on `event_type`** (allowlist in
  `lib/notifications/practitioner-notifications.ts`), server-only insert via
  `createAdminClient`, **no dedup column**; standard cron-secret pattern in
  `app/api/cron/*`.
- **Selected implementation:** a focused authenticated cron route (registered/invoked only
  after approval) scans due disinfectants → inserts owner-visible notifications
  (approaching/due/overdue) linking to the record, **no PHI**; new event types go in the
  helper allowlist (no CHECK change). Idempotency + repeated-cycle correctness need a
  durable dedup key + resolved-at → **migration 0130** adds `dedup_key text` +
  `resolved_at timestamptz` + a partial unique `(studio_id, dedup_key) where dedup_key is
  not null and resolved_at is null`. Replacement/discard resolves prior alerts; a new
  cycle can alert again. Takes **0130** (0129 is now the areas atomic-write RPCs).
- **PR:** disinfectant-notifications (own branch). **Status:** deferred; designed.

---

## Delivery order (this run)

1. **chips+vocab** (complaints #1, #9) — no migration — SHIPPED first (highest value,
   lowest risk, fully testable without Docker-only schema).
2. Remaining streams are designed above with concrete, additive, non-destructive plans and
   explicit migration ownership; they are larger (schema + form rework + cron) and are
   pursued as separate focused/stacked PRs. Anything not completed by morning is captured
   here with enough detail to implement directly, per the "document the blocker and
   continue" rule.

No hosted migration is applied and no PR is merged in this run; each migration apply and
merge remains approval-gated.
