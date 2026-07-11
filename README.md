# Hone

Electrolysis and laser-hair-removal practice software. Booking, intake, treatment plans, session charting, postcare, client portal, consent + e-sign, and card-on-file. Production domain: **https://hone.care**.

Built by [Saltkiln](https://saltkiln.com). Pilot studio: **Willow Electrolysis** (operator: Chloe).

## Status

> **Canonical, regularly-reconciled state:** [docs/production/current-state.md](./docs/production/current-state.md)
> (production migration max **0120** as of 2026-07-11 = Clinical Record Phase 2 corrections/amendments backend; Phase 1 finalization (0119, PR #399) + Phase 2 backend (0120, PR #400) are **merged + deployed but dormant** — both clinical flags default OFF for all studios and the corrections/amendments **customer workflow is parked**; PR #402 shipped amendment-path reliability/observability only, no migration) ·
> [migration ledger](./docs/production/migration-ledger.md) ·
> [release changelog](./docs/production/release-changelog.md) ·
> [migration-first runbook](./docs/runbooks/migration-first-process.md). This table is a
> summary; when it and current-state disagree, current-state + the live verifier win.

| Surface | State |
|---|---|
| Public booking, new/existing client, next-available | **Production** |
| Authenticated practitioner app, calendar, charting, postcare | **Production** |
| Clinical memory: structured tolerance/reaction/caution per treatment block, next-session notes, last-session context at the point of care | **Production** (PR #190) |
| Clinical record: finalization boundary (Phase 1, 0119/#399) + corrections/amendments backend (Phase 2, 0120/#400) + amendment-path reliability/observability (#402) | **Deployed but DORMANT** — both flags OFF for all studios; Phase 1 was production-exercised on a controlled test studio; Phase 2 **customer workflow is parked** and not approved for Willow |
| Practitioner signup | **Invite-only during the pilot** (PR #189). Magic-link login creates an account only for emails with a pending team invitation |
| Client portal (magic-link + session cookie, two-zone UX) | **Production** |
| Portal messages + replies | **Production** |
| Consent + e-sign (treatment, photo, card authorization, policy ack) | **Production**, draft template wording, **lawyer review required before live use** |
| Card-on-file (Stripe SetupIntent on connected account) | **Production** — live for approved studios + test mode; live/test card isolation is live |
| Owner-run **session payment** charge (PaymentIntent off-session; canonical `session-payment-charge.ts` executor / `payment_charge_attempts` ledger, PR #196) | **Production — supervised live for approved studios** (Willow + Sam's controlled studio; live charges + webhooks proven). A new studio starts test-mode and is enabled per-studio after supervised onboarding; **broad self-serve live payments are not ready** |
| Manual cancellation / no-show fee charge | **Test mode works; live is HARD-HELD server-side** (`lib/billing/live-charge-reason-allowlist.ts`) — only `session_payment` charges live; enabling live manual fees needs a dedicated PR + approval |
| Receipts (session-payment receipt email) | **Production** — live + test (PR #175) |
| Refunds (full-amount, `payment_charge_attempts`) | **Production** — **live refunds proven** for approved studios + test (PR #178) |
| Dispute handling | **Alert-only**: `charge.dispute.created` fires a critical ops_alert (PR #179); no automated response |
| Automatic charging, batch charging, public charge flow | **Not built and not planned for this phase** |
| SMS (Twilio) | **Implemented, pilot scale**, disabled by default per studio toggle + per-client consent. Broad-SaaS SMS (A2P/10DLC, sender strategy, rate-limiting) not built |
| Treatment observation chips (structured charting toggles) | **Production** (PR #357, migration 0108) |
| Studio 12h/24h time-format preference | **Production** (PR #359, migration 0109; default 12h) |
| Postcare automation (auto-send on completion) | **Production, default OFF / manual** (PR #360, migration 0110; opt-in per studio, fail-soft, skipped if Resend key / postcare text missing) |
| Calendar/booking usability (drawer override + exact clicked-time, internal scroll + mobile sticky rail, owner-only blocked-time editing, calendar 12h) | **Production** (PRs #361–#365) |
| Client portal: practitioner send / copy login URL + resend rate limits | **Production** (PR #366; reuses hashed/single-use/60-min issuance) |
| Portal CTA in confirmation + reminder emails; login-copy fix | **Production** (PR #367; token-free `/portal/login?studio=slug`) |
| Multiple photo upload (per-file validate + EXIF strip + per-file status) | **Production** (PR #368; UI-only) |
| Compact marketing-consent UI on public booking | **Production** (PR #369; default unchecked, never prechecked, consent-send logic unchanged) |
| Client portal access events + practitioner status card | **Production** (PR #370, migration 0111; append-only, no token/PII) |
| Public booking previous/next availability navigation | **Production** (PR #371; client-side) |
| Public booking horizon 1–12 months | **Production** (PR #372, migration 0112; default 3, existing studios unchanged) |
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

- **Live payments are enabled ONLY for approved studios, supervised.** Supervised live owner-run **session payments** are live for approved studios (Willow + Sam's controlled studio) — live Connect onboarding, charges, refunds, and webhooks proven; live/test isolation live. **Do not enable live payments for a new/unapproved studio** outside the supervised onboarding + approval process. Still off/held product-wide: **public booking card collection** (off), **deposits / packages / partial payments** (not built), **live manual no-show / late-cancel fees** (hard-held server-side — only `session_payment` charges live). **Broad self-serve live-payment rollout is not complete.** See [docs/production/current-state.md](./docs/production/current-state.md) for the canonical posture.
- **Do not enable auto-charge.** No automatic, background, batch, or public-triggered charge path exists. Charging is one manual practitioner click on a `ready` attempt. Anything different is a new design that needs review.
- **Do not bypass RLS or security review.** Every public route, token route, RPC grant, and `SECURITY DEFINER` function in this repo was chosen carefully. See [docs/03](./docs/03_SECURITY_AND_PRIVACY.md) before changing.
- **Do not expose tokenized routes to analytics.** PR #142 removed Vercel Analytics from `/portal/verify/[token]`, `/cancel/[token]`, `/reschedule/[token]`, `/manage/[token]`, `/intake/[token]`, `/calendar-feed/[token]` structurally. Adding analytics to those subtrees re-leaks the token to a third party.
- **Do not claim signatures are legally binding.** Consent + e-sign produces an evidence-friendly record. Enforceability under Ontario law depends on lawyer-reviewed wording.
- **Do not store raw card data, CVC, or Stripe `client_secret`.** Stripe holds the card; Hone stores brand, last4, expiry, and Stripe ids.

## Documentation maintenance rule

Every PR that changes product behavior, data model, security posture, payment behavior, env config, routes, cron, email/SMS, legal copy, or operational behavior **must update the relevant docs in the same PR**. The `.github/pull_request_template.md` checklist enforces this at review time. See [docs/15_DOCS_MAINTENANCE.md](./docs/15_DOCS_MAINTENANCE.md) for the map of "which doc to update for which change."

A PR is not complete if it changes behavior but leaves docs stale.
