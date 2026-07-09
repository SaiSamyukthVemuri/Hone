# Chloe Feedback — Shipped Status

Maps Chloe's (Willow) feedback items to their current status as of 2026-07-09. Status keys:
**Shipped** (live) · **Default OFF/manual** (live but opt-in) · **Later** (deferred) ·
**Out of scope** (intentionally not building now). Reconciled against
[../production/release-changelog.md](../production/release-changelog.md).

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
