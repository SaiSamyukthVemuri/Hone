---
type: quickstart
title: Hone wiki quickstart
description: Task-routing map for coding agents working in Hone — which wiki page and source entrypoints to read for each kind of change (scheduling, waitlist, treatment memory, auth/RLS, email/SMS, migrations, CI/release), where production truth lives, how to keep lifecycle states apart, and which commands to run before and after a change with what each one does and does not prove.
tags: [quickstart, routing, workflow, production-truth, verification]
sources:
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-d76a4c2ee174d60d80d31d1d
    resource: repo://scripts/ci-plan.mjs
  - id: openwiki-source-4b59b7f9dc0acb9c398d87f2
    resource: repo://scripts/verify-changed.mjs
  - id: openwiki-source-5b4944d20634a35670ad6c22
    resource: repo://scripts/verify-prepush.mjs
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Hone wiki quickstart

Hone is a multi-tenant practice system for electrolysis studios: booking, charting, treatment memory, payments
and client communications. It runs on Next.js App Router with Supabase Postgres and RLS. Start from
[System overview](architecture/system-overview.md) for the shape, then route by task below.

## 1. Before touching anything

1. **Read the standards.** `CLAUDE.md` defers to `ENGINEERING_STANDARDS.md`. Decide the change's risk tier
   (T0–T3) first. The automated tier is a **floor, not proof**, and may never be used to de-escalate
   ([`CLAUDE.md` § Engineering standards — read this first](../CLAUDE.md#engineering-standards--read-this-first)).
2. **Separate lifecycle states.** Designed, implemented, merged, DB applied, deployed, enabled, production
   exercised and human accepted are **independent**. Never write "live". See
   [Production truth and lifecycle states](architecture/production-truth-and-lifecycle-states.md).
3. **Production truth has exactly these authorities:**

   | Question | Authority |
   |---|---|
   | which migrations production has applied | `docs/production/migration-state.json` (`hosted_migration_max`) plus `migration-ledger.md` |
   | what is running, enabled and exercised | `docs/production/current-state.md` and explicit release evidence |
   | open gaps | `docs/production/known-limitations.md`, with the status as recorded |

   A migration file, a comment, a handoff note or a test name is **not** production truth
   ([`CLAUDE.md` § Hosted state is declared, not derived](../CLAUDE.md#hosted-state-is-declared-not-derived)).
4. **No production writes or migration applies** without explicit, per-change authorization. Applied migrations
   are frozen — write a new one ([`CLAUDE.md` § 5. Production safety](../CLAUDE.md#5-production-safety)).

## 2. Route by task

| You are changing… | Read first | Then | Source entrypoints |
|---|---|---|---|
| **Booking, slots, buffers, timezones** | [Availability, slots, buffers and timezones](scheduling/availability-slots-buffers-and-timezones.md) | [Appointment write authority](scheduling/appointment-write-authority.md), [Concurrency and lock order](scheduling/concurrency-and-lock-order.md) | `lib/booking/slots.ts`, `lib/booking/tz.ts`, migrations `0152`, `0170`–`0177` |
| **Public booking, cancel, reschedule** | [Public booking, reschedule and cancellation](scheduling/public-booking-reschedule-and-cancellation.md) | [Public token routes and privacy](security/public-token-routes-and-privacy.md) | `app/book/[slug]/actions.ts`, `app/cancel`, `app/reschedule`, `app/manage` |
| **Calendar, move, practitioner capacity** | [Practitioner calendar, move/reassign and capacity](scheduling/practitioner-calendar-move-and-capacity.md) | [Concurrency and lock order](scheduling/concurrency-and-lock-order.md) | `app/(app)/calendar/*actions.ts`, migrations `0134`–`0150` |
| **Waitlist and new-client admission** | [New-client admission mode](waitlist/new-client-admission-mode.md) | [Entries and invitation lifecycle](waitlist/entries-and-invitation-lifecycle.md), [Recipient journey and booking conversion](waitlist/recipient-journey-and-booking-conversion.md) | `lib/booking/new-client-admission.ts`, `lib/booking/waitlist-invitation.ts`, `app/invitation/[token]`, migrations `0185`–`0204` |
| **Charting, sessions, blocks, entries** | [Sessions, blocks and entries](treatment-memory/sessions-blocks-and-entries.md) | [Probes, settings and record keeping](treatment-memory/probes-settings-and-record-keeping.md) | `app/(app)/clients/[id]/sessions/[sessionId]/*actions.ts`, migrations `0164`–`0169`, `0181` |
| **Treatment memory, Before Today, prep** | [Memory reads and point-of-care](treatment-memory/memory-reads-and-point-of-care.md) | — | `lib/sessions/last-treatment-loader.ts`, `charted-session.ts`, `before-today.ts` |
| **Clinical, pinned or personal notes** | [Clinical, pinned and personal notes](treatment-memory/clinical-notes-and-client-notes.md) | [Client records and profile](clients/client-records-and-profile.md) | `lib/clinical-notes/*`, `lib/client-pinned-notes/*`, `app/(app)/clients/[id]/*notes-actions.ts`, migrations `0022`, `0035`, `0126`, `0127` |
| **Treatment plans, treatment time** | [Treatment plans and treatment time](treatment-memory/treatment-plans-and-treatment-time.md) | [Sessions, blocks and entries](treatment-memory/sessions-blocks-and-entries.md) | `lib/treatment-plans/*`, `lib/treatment-time/*`, `app/(app)/clients/[id]/treatment-*-actions.ts` |
| **Client records, archive, tags, budget** | [Client records and profile](clients/client-records-and-profile.md) | [RLS, grants and SECURITY DEFINER](security/rls-grants-and-security-definer.md) | `app/(app)/clients/*`, `lib/clients/*`, `lib/budget/*`, migrations `0050`, `0183`, `0184` |
| **Auth, tenancy, multi-studio** | [Authentication, sessions and tenancy](security/authentication-sessions-and-tenancy.md) | [RLS, grants and SECURITY DEFINER](security/rls-grants-and-security-definer.md) | `middleware.ts`, `lib/supabase/middleware.ts`, `lib/supabase/queries.ts`, `app/(auth)` |
| **Grants, RLS, new definer commands** | [RLS, grants and SECURITY DEFINER](security/rls-grants-and-security-definer.md) | [Source, docs and security guards](testing/source-docs-and-security-guards.md) | `tests/security/*`, migration `0178` |
| **Email** | [Email delivery](communications/email-delivery.md) | [Cron, reminders and idempotency](communications/cron-reminders-and-idempotency.md) | `lib/email/*` |
| **SMS, consent, STOP** | [SMS consent, STOP and senders](communications/sms-consent-stop-and-senders.md) | [Recipient journey](waitlist/recipient-journey-and-booking-conversion.md) for prospects | `lib/sms/*`, `app/api/twilio/inbound-sms/route.ts` |
| **Payments** | [Stripe payments and settlement](payments/stripe-payments-and-settlement.md) | [Card on file, checkout and payment proof](payments/card-on-file-checkout-and-payment-proof.md) | `lib/billing/*`, `lib/stripe/*`, `lib/payment-methods/*`, `e2e-payment/` |
| **Portal, intake, consent forms** | [Client portal, intake and consent](portal/client-portal-intake-and-consent.md) | [Intake forms, review and assisted intake](portal/intake-forms-review-and-assisted-intake.md), [Public token routes](security/public-token-routes-and-privacy.md) | `app/portal`, `app/intake`, `lib/portal/*`, `lib/intake/*` |
| **Google Calendar** | [Google Calendar sync](integrations/google-calendar-sync.md) | — | `lib/google-calendar/*` |
| **Owner dashboard, capacity** | [Dashboard, financials and capacity](owner/dashboard-financials-and-capacity.md) | — | `app/(app)/dashboard` |
| **Studio setup, team, export, import, images** | [Onboarding, settings and data portability](studio/onboarding-settings-and-data-portability.md) | — | `app/admin/studios/new`, `app/(app)/settings/*`, `lib/export/resource-registry.ts` |
| **A migration** | [Migrations and hosted state](operations/migrations-and-hosted-state.md) | [Migration-first rollout](operations/migration-first-rollout-and-production-safety.md), [DB and migration test harness](testing/database-and-migration-test-harness.md) | `scripts/migration-state.mjs`, `tests/migrations/helpers/migration-state.ts` |
| **CI, workflows, release** | [CI workflows and risk lanes](testing/ci-workflows-and-risk-lanes.md) | [Delivery and review authority](operations/delivery-and-review-authority.md), [Browser E2E and fakes](testing/browser-e2e-suites-and-fakes.md) | `.github/workflows/*`, `scripts/classify-changes.mjs`, `scripts/browser-groups.mjs` |
| **Env flags, observability** | [Environment flags and observability](operations/environment-flags-and-observability.md) | [Public token routes](security/public-token-routes-and-privacy.md) for scrubbing | `lib/observability/*`, `instrumentation*.ts` |
| **Marketing consent, conversion tracking** | [Marketing consent and conversion tracking](integrations/marketing-consent-and-conversion-tracking.md) | [Public booking](scheduling/public-booking-reschedule-and-cancellation.md) | `lib/conversion/*`, `lib/booking/marketing-consent.ts`, `app/(app)/settings/tracking/*` |
| **UI components, dialogs, pending states** | [UI components and interaction standards](architecture/ui-components-and-interaction-standards.md) | [Browser E2E suites and fakes](testing/browser-e2e-suites-and-fakes.md) | `components/ui/*`, `components/confirm-dialog.tsx`, `DESIGN.md` |

## 3. Commands, and what they prove

| Command | What it does | What it does **not** prove |
|---|---|---|
| `npm run migration:state` (`-- --json`) | derives the repository maximum, the next free number and skipped versions from `supabase/migrations`, and reads the declared hosted maximum ([`CLAUDE.md` § 2. Migration state is DERIVED](../CLAUDE.md#2-migration-state-is-derived--never-hard-code-it)) | that anything is applied in production — hosted state is **declared**, not derived |
| `npm run ci:plan` (`-- --json` for the tier) | shows which CI lanes and browser groups the diff selects, and the baseline risk tier, using the same classifier as CI ([`scripts/ci-plan.mjs` L1-L40](../scripts/ci-plan.mjs#L1-L40)) | semantic risk — the classifier sees paths, not behaviour |
| `npm run verify:changed` | auto-runs the cheap focused checks for the diff and prints expensive lanes (DB reset, browser) as suggestions ([`scripts/verify-changed.mjs` L1-L60](../scripts/verify-changed.mjs#L1-L60)) | anything it only suggests; it never runs the whole matrix |
| `npm run verify:prepush` | after committing: no leftover tracked changes or unexpected untracked files, `HEAD` equals the working tree, `git diff --check`, no conflict markers, recently edited files are committed, migration state derives ([`scripts/verify-prepush.mjs` L62-L160](../scripts/verify-prepush.mjs#L62-L160)) | that tests pass — **it runs no tests** |
| `npm test` / `npm run ci` | the unit, static, docs and security guard lanes; `ci` adds typecheck, lint, build and the safety gates | database behaviour; production state |
| `npm run test:db` (after **one** pinned reset: `npx --yes supabase@2.102.0 db reset --local`) | real behaviour of the migrated local schema | hosted state or production ACLs |
| `npm run test:e2e` (+ `:payment`, `:mobile`, `:google`) | local browser journeys with fail-closed fakes | real providers or production |

**The delivery sequence** ([`CLAUDE.md` § 1. The delivery sequence](../CLAUDE.md#1-the-delivery-sequence--verify-the-committed-tree-not-the-working-tree)) is: stage everything → `git diff --cached
--check` → commit → `git status --porcelain` empty → `git diff HEAD --exit-code` → `npm run verify:prepush` → push.

**Green CI is not merge authorization and not deployment** ([`CLAUDE.md` § 4. CI watchers and delivery ceremony](../CLAUDE.md#4-ci-watchers-and-delivery-ceremony)).

## 4. Traps that recur in this repository

- **Revoke function grants by name from `public`, `anon`, `authenticated` **and** `service_role`.** Supabase's
  default privileges grant them all ([`CLAUDE.md` § 5. Production safety](../CLAUDE.md#5-production-safety)). See
  [RLS, grants and SECURITY DEFINER](security/rls-grants-and-security-definer.md).
- **Open your own transaction in a migration.** `supabase db push` does not wrap the file, so a bare
  `SET LOCAL lock_timeout` never arms.
- **Use the pinned Supabase CLI.** A newer `db reset` strips grants and looks like an application bug.
- **A failed clinical read is never "no history".** See
  [Memory reads and point-of-care](treatment-memory/memory-reads-and-point-of-care.md#2-the-last-treatment-loader-and-the-failure-rule).
- **The browser never chooses the tenant.** Resolve the studio with `getCurrentPractitionerWithStudio()` and let
  the command re-prove it ([Authentication, sessions and tenancy](security/authentication-sessions-and-tenancy.md)).
- **Every page here ends with "Contradictions and open questions".** Read it before trusting a comment or a doc
  that the page cites.
