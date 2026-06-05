# 00 Product overview

## What problem Hone solves

Independent electrologists and small permanent-hair-removal studios run their practice on some mix of: a paper agenda, a generic booking calendar (Acuity / Square Appointments), a separate consent form (paper or PDF), a separate intake form, a separate notes file, and a separate text-message thread. None of these tools know about each other. When the practitioner sits down for a session, they have to rebuild context every time: what areas were treated last visit, what settings worked, what the client tolerated, what to avoid this round, what postcare was given last time.

Hone collapses that into one practice surface where the calendar is informed by treatment memory.

## Who Hone is for

- **Solo electrologists** and small studios. The pilot is Willow Electrolysis, operated by Chloe. The product is designed to work for one practitioner first; multi-practitioner studios are a layer on top, not the core.
- **Operators** who want to onboard a client through a real intake flow once, capture consent + photo consent + card authorization once, and then have the booking / portal / consent / payment surfaces share that context every visit.
- **Clients** who book online, see their upcoming appointments, get reminders, and can manage cancellation/reschedule from their email without phoning the studio.

## What Chloe (the practitioner) can do today

| Surface | What she can do |
|---|---|
| `/dashboard` | See today's appointments and a needs-attention block (intakes awaiting review, payments readiness). |
| `/calendar` and `/calendar/[id]` | Day / week view; drag to book; drag to block; mark complete / no-show; record session blocks (treatment area + duration + settings + notes). |
| `/clients` and `/clients/[id]` | Client list, pinned notes, tags, allergies, Fitzpatrick type, intake history, session history. |
| Treatment plans (`/clients/[id]`) | Multi-area plans with timeline. Status: in-progress, paused. |
| Postcare email send | One-click send from session detail. |
| Portal messages | Send messages to a client and receive replies; mark threads reviewed. |
| Consent / e-sign | Author templates (general / treatment / policy / card authorization / photo consent); see signed history with the title + body + version snapshot. |
| Card-on-file | View whether the client has an active card and a signed card authorization. **Test mode only.** |
| Manual cancellation/no-show fee | Set fee amounts; on cancelled/no-show appointments with full evidence, prepare a `ready` attempt; then run the test charge or cancel the prepared attempt. **Test mode only.** |
| Public booking link | Shareable booking page at `/book/<studio-slug>`; configurable booking window, buffers, descriptions. |

## What clients can do today

| Surface | What they can do |
|---|---|
| `/book/<slug>` | Book a consultation (new clients) or a service (existing clients) with the studio. |
| Email from confirmation | Click `/cancel/<token>`, `/reschedule/<token>`, `/manage/<token>` to manage the appointment, with policy acknowledgement before cancelling/rescheduling, and an optional cancellation reason + note + follow-up flag (PR #144). |
| Email magic link | Sign into `/portal` to see upcoming appointments, signed forms, postcare information, and messages from the studio. |
| Portal | Reply to studio messages; sign consent / photo consent / card authorization forms; add a card on file via Stripe Elements (test mode only); see policies and cancellation/no-show terms before they commit. |
| Intake | Complete the intake wizard (one-time per studio) before the first appointment. |

## What is explicitly NOT built yet

- **Automatic charging.** Hone does not charge cards on a schedule, in batches, or without a deliberate practitioner click. Manual fee charging exists but only in test mode.
- **Refunds, dispute handling, receipts.** No code path issues a refund. No receipt or charge notice email is sent.
- **Live-mode payment.** The Stripe key gate refuses `sk_live_*` without `STRIPE_ALLOW_LIVE_MODE=true`; the `manual_fee_charge_attempts` DB row has a CHECK that pins `stripe_livemode = false`. Live charging needs a deliberate live-mode PR with legal review.
- **Auto-generated charge notices, late-cancel detection from policy text.** The system cannot mechanically decide "this cancellation crossed the late window" because the policy is free-form text; the practitioner asserts the timing classification manually (PR #145).
- **Public booking card-required flow.** The 0032 Stripe backend has the SQL for this but it stays dormant.
- **Comprehensive automated coverage.** Minimal Vitest guard/regression tests and a GitHub Actions CI job (`.github/workflows/ci.yml`, PR #154) run `typecheck`, `lint`, `build`, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR and every push to the default branch. Full Supabase-local DB integration coverage, an RLS policy suite, and browser E2E coverage are NOT yet built; manual smoke (docs/12) remains the production-readiness check.
- **Google Calendar two-way sync.** Read-only ICS feed exists at `/calendar-feed/<token>.ics` but no two-way sync.
- **Intake form builder.** Intake schema lives in code; Chloe cannot author her own intake fields yet.
- **Admin / support dashboard.** The `/admin` portal is allowlist-gated to a handful of emails and shows read-only data, not a support console.
- **Self-serve onboarding.** Studio creation is manual SQL.

## Current product moat

> Hone is not just a calendar. The moat is **treatment memory**: what was done last time, what worked, what the client tolerated, what needs caution, and what the practitioner should remember before the next visit.

Session blocks (per appointment) record area, duration, equipment settings, and notes. The next visit's quick-book and session-detail surfaces pull this history forward. Treatment plans track multi-area arcs with status. Pinned notes per client surface allergies / EpiPen / cautions in red on every relevant page. Postcare is sent from the same row that recorded the session, so it can reference what actually happened.

A booking system can be replaced. The studio's accumulated treatment memory is what makes leaving costly.

## Current launch readiness

| Capability | State |
|---|---|
| Controlled pilot at Willow Electrolysis | **Active**. Chloe runs real bookings, intake, charting (with appointment-linked sessions per PR #156/#157), postcare, portal messages, cancellation/reschedule, and an appointment timeline on every client profile. |
| Card-on-file (test mode) | **Production-deployed, exercised end-to-end** via portal SetupIntent. No live charging. |
| Manual fee charging (test mode) | **Production-deployed.** Practitioner can test-charge a `ready` attempt with full evidence stack. |
| Broad SaaS launch | **Not ready.** Self-serve onboarding, intake builder, payment legal review, refund + receipt code, and deeper automated coverage (Supabase-local DB integration, RLS policy suite, browser E2E) all required first. Minimal Vitest + GitHub Actions CI exist as of PR #154. |
| Live payment | **Not ready.** Requires legal review of Ontario CASL/PCI obligations, a deliberate live-mode PR replacing the `livemode_false_check` constraint, a stronger pending-reconciliation path (Stripe metadata search before any retry), and explicit receipt / charge-notice flows. See [docs/06](./06_PAYMENTS_AND_STRIPE.md) §8. |

## Where the line is between "Hone today" and "Hone soon"

Today: Hone is a usable practice surface for one studio. Bookings run through it. Reminders go out. Intake is captured. Consent and photo-consent live in the portal. Card-on-file persists. Manual fees can be prepared and (in test) charged.

Soon: legal review of the consent + cancellation + card-authorization wording. Real live-mode payment. Receipts and refunds. Email outbox/claim discipline. Hashed calendar feed tokens. Automated tests + CI. Then a second pilot studio.

Far: self-serve onboarding, multi-studio team accounts, mobile app, Google Calendar sync, intake builder, billing dashboard.
