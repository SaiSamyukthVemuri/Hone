# Chloe Feedback — Shipped Status

Maps Chloe's (Willow) feedback items to their status. Status keys:
**Shipped** (deployed + enabled) · **Deployed — acceptance pending** (shipped but Chloe has
not yet tested it) · **Default OFF/manual** (deployed but opt-in) · **Later** (deferred) ·
**Deferred by product decision** · **Out of scope**. Reconciled against
[../production/current-state.md](../production/current-state.md) and
[../production/capability-register.md](../production/capability-register.md).

> **"Shipped" does not mean "accepted".** Everything in the 2026-07-27 section below is
> deployed and enabled in production, but **Chloe has not performed on-device acceptance
> testing of any of it.**

## 2026-07-25 → 2026-07-27 wave — deployed, acceptance PENDING

| Feedback | Status | Where | Notes |
|---|---|---|---|
| Treatment observations and skin response should be **one** thing, not two | **Deployed — acceptance pending** | PR #479 (code-only) | One unified *Treatment observations & skin response* multi-select. Reaction-driven analytics consume the unified representation; legacy `reaction_type` is folded in so historical rows still surface |
| Galvanic intensity is not a setting I use | **Deployed — acceptance pending** | PR #479 | `galvanic_intensity_percent` **retired** from current writes and ordinary display; forged specs ignored. **Historical values preserved — the column was not dropped.** `galvanic_ma` and `galvanic_duration_seconds` remain active readings |
| Thermolysis duration `0.733` was displaying as `0.73` | **Deployed — acceptance pending** | PR #479 | Exact 3-decimal display: `0.733 seconds`, never a lossily rounded `0.73`. Trailing zeros trimmed |
| Pulse count belongs with thermolysis | **Deployed — acceptance pending** | PR #479 | Relabeled **Thermolysis pulse count**, moved inside the thermolysis section, in both charting forms |
| Additional notes box is too small | **Deployed — acceptance pending** | PR #479 | Larger, resizable notes field |
| Copy areas & settings from the last session | **Deployed — acceptance pending, NEVER USED** | PR #478 + migration 0157 | Editable ephemeral preview, zero writes before an explicit commit, one atomic commit, idempotency + provenance ledger. Minutes and outcomes are **never** copied; galvanic intensity forced to literal NULL. **`session_copy_operations` holds 0 rows — no real copy has ever been performed** |
| Optional note about numbing when numbing was used | **Deployed — acceptance pending** | PR #477, migration 0156 | Free-text, no length cap; shown and kept **only** when `numbing_status='used'` |
| Probe lot should link to my actual inventory | **Deployed — acceptance pending** | PR #475, migration 0155 | Durable same-studio pointer into `record_keeping_sterile_items`; no production block carries a link yet |
| Charting usability polish (collapsed add-block CTA, larger notes) | **Deployed — acceptance pending** | PR #476 (code-only) | Opening or cancelling the add-block form performs **zero writes** |
| Notification when a client adds or replaces a card | **Shipped** | PR #472, migration 0154 | Idempotent on the mode-scoped SetupIntent |
| Bullets in Personal Notes | **Shipped** | PR #471 | Plain text, no rich-text/HTML |
| Create a treatment plan from an appointment | **Shipped** | PR #470 | Deep-links to the existing create form; zero auto-create |
| Pick my own service colours | **Shipped** | PR #469, migration 0153 | Six approved colours; rose/red reserved for clinical caution |
| Edit a pinned note in place | **Shipped** | PR #468 | Optimistic concurrency on the original text |
| 11:30 slot / smart scheduling | **Shipped** | PR #467 | Backward-packed slot anchor + source-aware conflicts |
| Manual-override booking blocked next to an existing appointment | **Shipped** | PR #465, migration 0152 | Actual overlap stays a **hard** constraint; the configured buffer became **soft** and owner-overridable |
| **Direct new-client consultation booking route** | **Deferred by product decision (2026-07-27)** | — | Not built, **not a launch blocker**, not the next engineering task |

---

## Earlier waves (status as of 2026-07-09 unless noted)

| Feedback | Status | Where | Notes |
|---|---|---|---|
| Treatment observation chips were unreliable | **Shipped** | PR #357, migration 0108 | Structured toggle chips; legacy chips backfilled from `comments` on edit |
| Client-facing times should be 12-hour, not military | **Shipped** | PR #358 (SMS), #359 (0109 studio preference), #361/#362 (calendar modal + cards/drag) | Studio 12h/24h preference, default 12h; machine values stay 24h |
| Postcare should send automatically | **Default OFF / manual** | PR #360, migration 0110 | Auto-send is opt-in per studio (`postcare_delivery_mode`); default `manual`; fail-soft; needs Resend key + postcare text |
| Booking drawer should let me book the exact time I clicked / override | **Shipped** | PR #363 | No booking-validation weakening |
| Calendar is unusable, especially on mobile ("circle around the calendar") | **Shipped (redesigned)** | PR #380 (mobile), #381–#383 (desktop) | **Mobile = single-day vertical timeline** (replaced the sideways-scrollable week grid): date strip, prev/next day, tap-to-book, now-line, floating +. **Desktop:** in-context appointment preview (#381), Google-style toolbar (#382), one clean vertical scroll (#383). Earlier patches (#364 scroll/rail) superseded. |
| Let me edit blocked time from the calendar | **Shipped (owner-only)** | PR #365 | Owner-gated server-side; members read-only. Member-own blocked-time editing = **Later** |
| Postcare auto-send setting was hard to find | **Shipped** | PR #375 | Nav "Forms & Policies" → "Forms & Postcare"; removed stale "no auto-send" copy. Setting + behavior unchanged (still default `manual`, owner-only) |
| Charting: aftercare should be prompted, not just optional | **Shipped** | PR #384 | Non-blocking prompt at "Done charting" when the aftercare stamp is missing; **never blocks** (emergency-safe); "Mark aftercare explained" or "Continue without marking" |
| Charting: treatment area should be validated (not free-text typos) | **Shipped** | PR #385 | Server-side canonical validation (flat `AREAS` incl. "Full face" + explicit "Other"/custom); **legacy rows preserved, never rewritten** |
| Charting: probe lot should be tied to inventory, not arbitrary text | **Shipped (partial)** | PR #386 | A `probe_lot_id` must be a well-formed UUID in the studio's own inventory; free-text/manual lot preserved + honestly labeled manual (never "verified"). Requiring inventory for all studios = **Later** |
| Client overview: "I want to see what we did last time" | **Shipped** | PR #389 | A scannable, retrospective **Last visit** card near the top of the Client Overview tab: date/modality/performer/duration, aftercare-explained status, areas + settings/probe/tolerance/response, and the last-visit watch/next-visit note, with an **Open session** link to the full session notes. **Reuses the existing single-last-session summary** (`buildLastSessionSummary` output + shared render helpers) — **no new clinical model, no AI summary, no migration** (production max stays **0113**); no payment/email/SMS/query behavior change. Clinical-first (no price); the forward-looking BeforeToday prep card and the Sessions-tab "Last treatment" card are unchanged. Live on Client Overview. Merge SHA `ae0fa47`. |
| Charting: "let me remove one pass from a multi-pass area if I entered it by mistake" | **Shipped** | PR #391, migration 0114 | **"Remove pass"** on each pass (electrolysis **and** laser) — a confirmation ("Remove this pass from the active treatment record? Other passes for this area will stay.") + optional reason. It is an **audited SOFT-delete, not a hard delete**: the row is preserved and stamped `deleted_at`/`deleted_by`/`delete_reason` (mirrors the `session_blocks` pattern). **Only the selected pass is removed** — other passes, the treatment area/block, the session, the appointment, the client, and photos all stay untouched. Removed passes are **hidden from every active view** (charting, Last Visit, Treatment Intelligence, session history, exports). Guards: active practitioner, session∈studio∈client (cross-studio rejected), no double-remove. No payment/email/SMS/env change; no RLS weakening. Applied **migration-first** (0114 before merge). Merge SHA `5012612`. |
| Easier to get clients into the portal | **Shipped** | PR #366 (send/copy link + rate limits), #367 (email CTA + login copy) | Reuses hashed/single-use/60-min issuance; token-free copy URL |
| See whether a client received/used portal access + what's pending | **Shipped** | PR #370, migration 0111 | Practitioner status card: last sent / last seen / pending tasks / recent activity |
| Upload multiple treatment photos at once | **Shipped** | PR #368 | Per-file validate + EXIF strip + per-file status; no silent partial failure |
| Marketing/analytics consent block is too big/conversion-hostile | **Shipped** | PR #369 | Compact label + collapsed detail; default unchecked; consent-send logic unchanged |
| Go back to the previous suggested availability, not just forward | **Shipped** | PR #371 | Client-side history; stepping back re-validates that day's slots |
| More booking-horizon options (1–12 months) | **Shipped** | PR #372, migration 0112 | CHECK widened to 1–12; default 3; existing studios unchanged |
| Custom horizon like "6 weeks" (weeks/days) | **Later** | — | Deferred (PR C); 1–12 months likely covers the immediate need — revisit after Chloe tests the new setting. Would need a schema change (a days/unit column) |

## Payments — what IS live vs out of scope

- **Live owner-run session payments** — **LIVE for approved studios** (Willow + Sam's
  controlled studio): live Connect onboarding, charges, refunds, webhooks proven; live/test
  isolation live. **Broad self-serve live-payment rollout is not complete** (a new studio
  starts test-mode; live is enabled per-studio after supervised approval).
- **Public booking card collection / deposits / packages / partial payments / live manual
  no-show + late-cancel fees** — still OFF / hard-held; each needs a dedicated PR + approval.

## Intentionally out of scope for now (with reasons)

- **Broad-SaaS SMS (A2P/10DLC, per-studio sender)** — pilot scale only; a later hardening item.
- **Referral/conversion analytics** — the tracking framework exists but is inert per studio;
  not the next priority per the 2026-07-08 audit.
- **Self-serve studio signup / per-studio intake builder** — product epics, not near-term.

## Follow-ups worth noting to Chloe

- Portal **verify** page copy — **RESOLVED** (PR #377): now says "1 hour" (matches the real TTL).
- Postcare auto-send is available but **off by default** — turning it on for Willow needs the
  pre-enable checks (Resend key + aftercare text) in the current-state doc.

## Remaining optional (none started; not a commitment)

- **Charting:** treatment-plans multi-area canonical validation (same rule as #385); legacy
  electrolysis-entry area path; real observation-chip vocabulary (awaiting the list).
- **Calendar:** desktop **Day view** + **agenda/list** view; mobile **bottom sheets** +
  **swipe-to-change-day** + mobile appointment preview.
- **Member-own blocked-time editing** (currently owner-only).
- **Later:** referral/conversion analytics (framework inert per studio); broad SaaS SMS
  hardening (A2P/10DLC, per-studio sender strategy).
