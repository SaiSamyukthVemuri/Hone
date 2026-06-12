# Hone

Electrolysis and laser-hair-removal practice software. Booking, intake, treatment plans, session charting, postcare, client portal, consent + e-sign, and card-on-file. Production domain: **https://hone.care**.

Built by [Saltkiln](https://saltkiln.com). Pilot studio: **Willow Electrolysis** (operator: Chloe).

## Status

| Surface | State |
|---|---|
| Public booking, new/existing client, next-available | **Production** |
| Authenticated practitioner app, calendar, charting, postcare | **Production** |
| Clinical memory: structured tolerance/reaction/caution per treatment block, next-session notes, last-session context at the point of care | **Production** (PR #190) |
| Practitioner signup | **Invite-only during the pilot** (PR #189). Magic-link login creates an account only for emails with a pending team invitation |
| Client portal (magic-link + session cookie, two-zone UX) | **Production** |
| Portal messages + replies | **Production** |
| Consent + e-sign (treatment, photo, card authorization, policy ack) | **Production**, draft template wording, **lawyer review required before live use** |
| Card-on-file (Stripe SetupIntent on connected account) | **Production, test mode only** |
| Cancellation/no-show fee charge (PaymentIntent off-session; unified onto `payment_charge_attempts` via the canonical `session-payment-charge.ts` executor since PR #196) | **Production, test mode only**. Live charging requires a deliberate live-mode PR with legal review |
| Session payment charge end-to-end: prepare, run, receipt, refund, webhook reconciliation, completion-to-billing UX (`payment_charge_attempts`) | **Production, test mode only** (PRs #171-#181; fees unified onto the same ledger in PR #196). Live payments remain blocked |
| Receipts (session-payment test receipt email) | **Production, test mode only** (PR #175) |
| Refunds (full-amount, test mode, `payment_charge_attempts`) | **Production, test mode only** (PR #178) |
| Dispute handling | **Alert-only**: `charge.dispute.created` fires a critical ops_alert (PR #179); no automated response |
| Automatic charging, batch charging, public charge flow | **Not built and not planned for this phase** |
| SMS (Twilio) | **Implemented but disabled by default** per studio toggle and per-client consent |
| Google Calendar sync, intake builder, signed-consent viewer, admin/support dashboard | **Backlog** |

## Who Hone is for

Independent electrologists and small permanent-hair-removal studios. The current pilot is Willow Electrolysis. The product framing: **a calendar is the surface; the moat is treatment memory**; what was done last time, what worked, what the client tolerated, what needs caution, and what the practitioner should remember before the next visit.

## Quick start for developers

```bash
git clone https://github.com/SaiSamyukthVemuri/Hone.git
cd Hone
npm ci
cp .env.local.example .env.local       # fill in the values
npm run dev                              # http://localhost:3000
```

Required commands before opening a PR:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run check:stripe-gates
git diff --check
```

Or the shortcut that chains the first five:

```bash
npm run ci
```

GitHub Actions runs the same set on every PR and every push to the default branch (`.github/workflows/ci.yml`, PR #154), plus a separate `db-integration` job (PR #220/#221) that applies the FULL migration chain from scratch to a local Supabase Postgres, runs the DB/RLS behavior tests (`npm run test:db`: cross-studio isolation, audit immutability + triggers, clinical delete posture, double-booking constraint, claim RPCs, exposure owner tier), and runs the generated types drift check (`npm run check:db-types`), and a separate `browser-e2e` job (PR #227) that runs the Playwright core-memory-loop spec against a local production build and the full local Supabase stack (`npm run test:e2e` locally). CI does not replace the manual smoke catalogue in [docs/12_SMOKE_TESTS.md](./docs/12_SMOKE_TESTS.md); browser flows, real Resend / Twilio sends, real Stripe Elements, and real webhook delivery still live there.

## Required services

| Service | Used for |
|---|---|
| Vercel | Hosting (Next.js 15 App Router, Node 24 runtime) |
| Supabase | Postgres + Auth (magic link) + Storage |
| Stripe | Connect Express onboarding, card-on-file (SetupIntent), test-mode manual fee charging |
| Resend | Transactional email |
| Twilio | SMS confirmations and reminders (off by default; consent-gated) |
| Upstash Redis | Rate-limit token bucket for public surfaces (optional; fails open) |
| External cron | `https://cron-job.org/` or Vercel cron hits `/api/cron/*` with `CRON_SECRET` |

Environment variables: see [`.env.local.example`](./.env.local.example) for the full list and [`docs/10_DEPLOYMENT_AND_ENV.md`](./docs/10_DEPLOYMENT_AND_ENV.md) for production setup.

## Documentation map

| File | Audience | Topic |
|---|---|---|
| [docs/00_PRODUCT_OVERVIEW.md](./docs/00_PRODUCT_OVERVIEW.md) | Anyone | What Hone is and is not |
| [docs/01_ARCHITECTURE.md](./docs/01_ARCHITECTURE.md) | Developers | Next.js + Supabase + Stripe shape |
| [docs/02_DOMAIN_MODEL.md](./docs/02_DOMAIN_MODEL.md) | Developers | Studios, clients, appointments, the rest |
| [docs/03_SECURITY_AND_PRIVACY.md](./docs/03_SECURITY_AND_PRIVACY.md) | Reviewers | Tenant isolation, RLS, token routes, portal session |
| [docs/04_BOOKING_AND_PORTAL_FLOWS.md](./docs/04_BOOKING_AND_PORTAL_FLOWS.md) | Developers + product | Public booking, portal, cancel/reschedule |
| [docs/05_CONSENT_AND_FORMS.md](./docs/05_CONSENT_AND_FORMS.md) | Developers + legal reviewer | Consent templates, signatures, photo consent |
| [docs/06_PAYMENTS_AND_STRIPE.md](./docs/06_PAYMENTS_AND_STRIPE.md) | Developers + payment reviewer | Stripe Connect, card-on-file, manual fee charging |
| [docs/07_CALENDAR_AND_AVAILABILITY.md](./docs/07_CALENDAR_AND_AVAILABILITY.md) | Developers | Availability, drag-to-book, blockouts |
| [docs/08_EMAIL_SMS_AND_CRON.md](./docs/08_EMAIL_SMS_AND_CRON.md) | Developers | Resend, Twilio, cron routes |
| [docs/09_DATABASE_AND_RLS.md](./docs/09_DATABASE_AND_RLS.md) | Developers | Migrations, RLS principles, RPC review |
| [docs/10_DEPLOYMENT_AND_ENV.md](./docs/10_DEPLOYMENT_AND_ENV.md) | Operators | Vercel, Supabase, Stripe, Twilio, env vars |
| [docs/11_RUNBOOK.md](./docs/11_RUNBOOK.md) | Operators | Post-deploy checks, SQL recipes, incident handling |
| [docs/12_SMOKE_TESTS.md](./docs/12_SMOKE_TESTS.md) | Operators + reviewers | The smoke-test catalogue |
| [docs/13_BACKLOG_AND_DECISIONS.md](./docs/13_BACKLOG_AND_DECISIONS.md) | Anyone | Decision log + ranked backlog |
| [docs/14_AI_HANDOFF.md](./docs/14_AI_HANDOFF.md) | Future AI agents | Read-this-first for any AI continuing the work |
| [docs/15_DOCS_MAINTENANCE.md](./docs/15_DOCS_MAINTENANCE.md) | Maintainers | When to update which doc |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Contributors | Branching, PR discipline, review expectations |
| [.github/pull_request_template.md](./.github/pull_request_template.md) | Every PR | Required checklist (PR #147) |

## Warnings

- **Do not flip live payments.** Live mode is structurally blocked: the Stripe key gate refuses `sk_live_*` unless `STRIPE_ALLOW_LIVE_MODE=true`, and the canonical `payment_charge_attempts` ledger (plus the legacy, read-only `manual_fee_charge_attempts` table) has a CHECK constraint that pins `stripe_livemode = false`. All of it must be deliberately altered in a reviewed live-mode PR; controlled live payment enablement has not started.
- **Do not enable auto-charge.** No automatic, background, batch, or public-triggered charge path exists. Charging is one manual practitioner click on a `ready` attempt. Anything different is a new design that needs review.
- **Do not bypass RLS or security review.** Every public route, token route, RPC grant, and `SECURITY DEFINER` function in this repo was chosen carefully. See [docs/03](./docs/03_SECURITY_AND_PRIVACY.md) before changing.
- **Do not expose tokenized routes to analytics.** PR #142 removed Vercel Analytics from `/portal/verify/[token]`, `/cancel/[token]`, `/reschedule/[token]`, `/manage/[token]`, `/intake/[token]`, `/calendar-feed/[token]` structurally. Adding analytics to those subtrees re-leaks the token to a third party.
- **Do not claim signatures are legally binding.** Consent + e-sign produces an evidence-friendly record. Enforceability under Ontario law depends on lawyer-reviewed wording.
- **Do not store raw card data, CVC, or Stripe `client_secret`.** Stripe holds the card; Hone stores brand, last4, expiry, and Stripe ids.

## Documentation maintenance rule

Every PR that changes product behavior, data model, security posture, payment behavior, env config, routes, cron, email/SMS, legal copy, or operational behavior **must update the relevant docs in the same PR**. The `.github/pull_request_template.md` checklist enforces this at review time. See [docs/15_DOCS_MAINTENANCE.md](./docs/15_DOCS_MAINTENANCE.md) for the map of "which doc to update for which change."

A PR is not complete if it changes behavior but leaves docs stale.
