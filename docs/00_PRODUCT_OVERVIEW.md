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
| Card-on-file | View whether the client has an active card and a signed card authorization. **Live + test**, mode-scoped with live/test isolation. |
| Manual cancellation/no-show fee | Set fee amounts; on cancelled/no-show appointments with full evidence, prepare a `ready` attempt; then run the charge or cancel the prepared attempt. **TEST MODE ONLY — live manual fees are on a server-side hard hold** (`lib/billing/live-charge-reason-allowlist.ts`); only `session_payment` charges live. |
| Public booking link | Shareable booking page at `/book/<studio-slug>`; configurable booking window, buffers, descriptions. |

## What clients can do today

| Surface | What they can do |
|---|---|
| `/book/<slug>` | Book a consultation (new clients) or a service (existing clients) with the studio. |
| Email from confirmation | Click `/cancel/<token>`, `/reschedule/<token>`, `/manage/<token>` to manage the appointment, with policy acknowledgement before cancelling/rescheduling, and an optional cancellation reason + note + follow-up flag (PR #144). |
| Email magic link | Sign into `/portal` to see upcoming appointments, signed forms, postcare information, and messages from the studio. |
| Portal | Reply to studio messages; sign consent / photo consent / card authorization forms; add a card on file via Stripe Elements (live or test, per the studio's Stripe mode; adding a card never charges it); see policies and cancellation/no-show terms before they commit. |
| Intake | Complete the intake wizard (one-time per studio) before the first appointment. |

## What is explicitly NOT built yet

- **Automatic charging.** Hone does not charge cards on a schedule, in batches, or without a deliberate practitioner click. Manual fee charging exists but only in test mode.
- **Dispute handling and reviewed live receipt wording.** Test-mode receipts and full-amount, owner-only refunds ARE built on the unified `payment_charge_attempts` ledger (fees inherit them since PR #196), but disputes only surface as webhook ops alerts (no dispute workflow), and — *corrected 2026-07-27* — the live receipt wording is **no longer merely drafted**: legal/accounting approval was recorded (docs/16 §17.14.2). Dispute handling genuinely remains alert-only with no dispute workflow, and no dispute has ever occurred (`stripe_disputes` = 0 rows).
- ~~**Live-mode payment.**~~ **NO LONGER TRUE — live payments ARE built and in use.** Live owner-run **session payments** are enabled for two approved studios, and **Willow Electrolysis has 6 succeeded live-mode charges (most recent 2026-07-26)**. The DB CHECK that pinned `stripe_livemode = false` on the canonical `payment_charge_attempts` ledger was **dropped by migration 0101**; only the legacy, read-only `manual_fee_charge_attempts` table still carries one. What remains genuinely **not built or held**: broad self-serve live payments (a new studio starts in test mode), public-booking card collection (off and unwired), deposits / packages / partial payments (not built), and live manual no-show / late-cancel fees (**server-side hard hold** — only `session_payment` charges live). See [production/current-state.md §7](./production/current-state.md).
- **Auto-generated charge notices, late-cancel detection from policy text.** The system cannot mechanically decide "this cancellation crossed the late window" because the policy is free-form text; the practitioner asserts the timing classification manually (PR #145).
- **Public booking card-required flow.** The 0032 Stripe backend has the SQL for this but it stays dormant.
- **Test + CI coverage (this is BUILT — listed here for orientation, not as a gap).** The Vitest suite + GitHub Actions CI (PR #154) run typecheck/lint/build/tests/safety gates on every PR. A separate `db-integration` job (PR #220/#221) applies the FULL migration chain from scratch to a local Supabase Postgres, runs real DB/RLS behavior tests (cross-studio isolation, audit immutability + triggers, clinical delete posture, double-booking constraint, claim RPCs, exposure owner tier), and runs the generated types drift check. **Browser E2E is shipped**: `playwright.config.ts` plus 58 specs under `e2e/` run as the dedicated `browser-e2e` CI job (`npm run test:e2e` runs the whole `e2e/` directory, not one spec), alongside `payment-browser-e2e`, `mobile-completion-e2e` and `google-browser-e2e` lanes. **Manual smoke (docs/12) remains complementary and is not replaced by synthetic E2E** — real Resend/Twilio sends, real Stripe Elements and real webhook delivery still need a human.
- **Google Calendar inbound-busy import and true two-way sync.** These two capabilities are genuinely unbuilt. **The rest of the Google Calendar system is NOT unbuilt** — the connection/OAuth foundation, outbound queue, event-operation layer, worker-drain route and cron registration are all built, deployed, and were exercised once under control (one real event, 2026-07-18, on a controlled test studio). It is **dormant**, not missing: every sync flag is off and Willow is not connected. A read-only ICS feed also exists at `/calendar-feed/<token>.ics`.
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
| Card-on-file (live + test) | **Production-deployed, exercised end-to-end** via portal SetupIntent, with live/test isolation. 8 stored payment methods. |
| Live session payments | **Live and in use for two approved studios.** Willow Electrolysis: **6 succeeded live-mode charges**, most recent 2026-07-26. Per-studio, after supervised onboarding + approval — **not** self-serve. |
| Manual fee charging (test mode) | **Production-deployed.** Practitioner can test-charge a `ready` attempt with full evidence stack; since PR #196 fees ride the unified `payment_charge_attempts` ledger and inherit receipts, refunds, and webhook reconciliation. |
| Broad SaaS launch | **Not ready.** The remaining gates are: **self-serve onboarding maturity** (studio creation is still operator-provisioned; practitioner signup is invite-only), the **intake-builder / self-service gap** (intake schema lives in code — a studio cannot author its own fields), **second-studio validation** (one live studio today: Willow Electrolysis), the **final deep production/security/code audit** (not yet performed against the current baseline), and **explicit controlled-rollout approval**. Test and CI coverage is NOT a remaining gate — the Vitest suite, GitHub Actions CI, the DB/RLS integration lane, the types drift check and the `browser-e2e` Playwright lane all exist. Hone is safe for the supervised Chloe/Laura pilot and supervised live session payments for approved studios; it is NOT ready for first paid customers, broad self-serve launch, or broad self-serve live payments. |
| Live payment | **Supervised live for approved studios.** Live owner-run **session** payments are live for approved studios (Willow + Sam's controlled studio) — live Connect onboarding, charges and webhook processing proven — **6 succeeded live charges on Willow through 2026-07-26**. **Refunds and disputes have ZERO production rows on this baseline** (`stripe_refunds` = 0, `stripe_disputes` = 0). Live/test isolation live; Stripe gates 15 PASS. **Still off / held:** public booking card collection, deposits / packages / partial payments, and live manual no-show / late-cancel fees (hard-held server-side). **Broad self-serve live payments are not ready** (a new studio starts test-mode; live is enabled per-studio after supervised approval). Canonical: [docs/production/current-state.md](./production/current-state.md). |

## Where the line is between "Hone today" and "Hone soon"

Today: Hone is a usable practice surface for one studio. Bookings run through it. Reminders go out. Intake is captured. Consent and photo-consent live in the portal. Card-on-file persists. Manual fees can be prepared and (in test) charged. Test-mode receipts and refunds run on the unified payment ledger. Email sends use atomic claim discipline (migration 0080). Calendar feed tokens are hashed at rest (migration 0079). Automated tests + GitHub Actions CI run on every PR, including the DB/RLS integration lane and the types drift check. Record Keeping supports per-client procedure record pulls with filtered print (PR #223); exposure incident history is owner-only (PR #222); the Dashboard tracks charting freshness (charted within 24h, PR #225); and Studio #2 setup has an internal operator runbook (docs/20, PR #224).

Soon: legal review of the consent + cancellation wording (the live receipt/card-authorization wording was approved — see docs/16 §17.14.2). Broadening live payments beyond the two supervised studios. A first production refund and a dispute-response runbook (neither path has any production rows yet). Then a second pilot studio.

*(Superseded: this line previously listed "real live-mode payment" as future work. It happened — Willow has 6 succeeded live-mode charges, most recent 2026-07-26.)*

Far: self-serve onboarding, multi-studio team accounts, mobile app, **Google Calendar inbound-busy import and true two-way synchronization** (the outbound connection, queue, worker and event-operation layers are already built, deployed and exercised once under control — only inbound/two-way remain unbuilt), intake builder, billing dashboard.
