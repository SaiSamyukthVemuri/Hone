---
type: integration subsystem
title: Payments, Stripe and appointment settlement
description: How Hone moves money — the Stripe key/mode gate, the single server-side amount authority, the claim-then-charge executor with a deterministic idempotency key, mode-matched webhook reconciliation, refunds, the practitioner-attested settlement ledger for non-card outcomes, the source gates that pin every money-moving call site, and dated production status.
tags: [payments, stripe, idempotency, webhooks, settlement, live-mode, money-safety]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-5505b485d5cc08afda1370bc
    resource: repo://app/api/stripe/webhook/route.ts
  - id: openwiki-source-e68c1485de103522e8643a92
    resource: repo://docs/06_PAYMENTS_AND_STRIPE.md
  - id: openwiki-source-7d7ee7c428a6bb9b97b5ef92
    resource: repo://docs/11_RUNBOOK.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-7653d42202d925c0d3bd5dde
    resource: repo://lib/billing/appointment-settlement.ts
  - id: openwiki-source-12b3d91a530bd1a57918950f
    resource: repo://lib/billing/authoritative-session-payment.ts
  - id: openwiki-source-a045f3d3c7a4716fae15aa41
    resource: repo://lib/billing/live-charge-reason-allowlist.ts
  - id: openwiki-source-9583846eb4538cd6cebefdc3
    resource: repo://lib/billing/payment-refund.ts
  - id: openwiki-source-7c5fe545c48470972eabb8df
    resource: repo://lib/billing/payment-webhook-reconciliation.ts
  - id: openwiki-source-c7fdf270adde5d8e16cf3718
    resource: repo://lib/billing/session-payment-charge.ts
  - id: openwiki-source-3d478ff18a4ab0a51dfea734
    resource: repo://lib/stripe/e2e-fake-guard.ts
  - id: openwiki-source-2e1e23d55fbc915391e73340
    resource: repo://lib/stripe/server.ts
  - id: openwiki-source-a421dfeda46a4aa9d2508a95
    resource: repo://scripts/check-stripe-gates.mjs
  - id: openwiki-source-52dc3e5e0c9c4b9c637f3387
    resource: repo://supabase/migrations/0187_appointment_settlement.sql
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Payments, Stripe and appointment settlement

Hone charges a client's saved card through **Stripe Connect** (direct charges on the studio's
connected account) only when a practitioner clicks to charge; there is **no automatic, background,
batch or public-triggered charge path**. Non-card outcomes (cash, e-transfer, waived, still owing)
are recorded in a separate ledger that cannot express "a card was charged".

## 1. Stripe client and mode gate

[`lib/stripe/server.ts`](../../lib/stripe/server.ts) is the only place a secret-key client is built:

- `assertStripeKeyAllowed`: the key must be `sk_test_` or `sk_live_`; a live key requires
  `STRIPE_ALLOW_LIVE_MODE === "true"`; Vercel **preview/development** must always use a test key
  ([L1-L66](../../lib/stripe/server.ts#L1-L66)).
- API version is pinned (`2026-04-22.dahlia`); bumping it is a deliberate change.
- The deployment's mode (`inferStripeLivemode()`) is the reference every charge, refund and webhook
  handler compares rows against.

## 2. The amount authority

[`lib/billing/authoritative-session-payment.ts`](../../lib/billing/authoritative-session-payment.ts#L1-L60)
is **the** server-side loader for a session payment's amount: every surface that shows or prepares
a charge — including the prepare action, which re-loads independently — resolves the price here
from current records. Lineage is enforced (live session in this studio → its linked appointment,
never "an appointment of this client" → same studio and client → service of the same studio), any
break is unresolved, and a **read failure is reported as `read_failed`**, never as an empty pricing
set that would silently fall back to a menu price.

## 3. Charging: claim, then call Stripe once

[`runSessionPaymentCharge`](../../lib/billing/session-payment-charge.ts#L1-L80)
(`lib/billing/session-payment-charge.ts`):

1. Re-derives deployment mode and requires the attempt row, card, studio settings and customer to
   match it; re-runs eligibility, card lineage and a **current card-authorization** recheck.
2. Calls `claim_session_payment_charge_attempt`, which atomically moves the row
   `ready → pending_stripe` and stamps a deterministic idempotency key
   `hone:<charge_reason>:<attemptId>:v1` ([L83-L92](../../lib/billing/session-payment-charge.ts#L83-L92),
   [L1234-L1241](../../lib/billing/session-payment-charge.ts#L1234-L1241)). The command is
   `SECURITY DEFINER`, `service_role`-only, and its latest definition is in migration `0187`
   ([`0187` L1534-L1560](../../supabase/migrations/0187_appointment_settlement.sql#L1534-L1560),
   [L1855](../../supabase/migrations/0187_appointment_settlement.sql#L1855-L1855)).
3. Creates **one** PaymentIntent (`confirm=true`) on the connected account with that key, so
   Stripe's idempotent replay covers network-error retries ([L1390-L1414](../../lib/billing/session-payment-charge.ts#L1390-L1414)).
4. Writes `succeeded` (with PaymentIntent and charge ids) or `failed` on the same row; a Stripe
   success whose local write cannot be confirmed is surfaced as "needs review", not retried.

It never refunds, never re-executes a non-`ready` row (except reconciling a stale
`pending_stripe` inside a 60-minute window), and sets no platform fee.

**Live charge reasons are allow-listed server-side:** in live mode only `session_payment` may be
prepared or executed; no-show and late-cancellation fees are on a hard hold
([`live-charge-reason-allowlist.ts` L1-L36](../../lib/billing/live-charge-reason-allowlist.ts#L1-L36)).

## 4. Webhooks (`/api/stripe/webhook`)

- Raw body, `stripe.webhooks.constructEvent` signature verification, generic 400 on any failure;
  `STRIPE_WEBHOOK_SECRET` missing throws ([route L100-L150](../../app/api/stripe/webhook/route.ts#L100-L150)).
- Idempotent event claim through `claim_stripe_event`, unique on `(account, livemode, event_id)`
  ([L195-L230](../../app/api/stripe/webhook/route.ts#L195-L230)).
- Handled: `account.updated` / `capability.updated` (account status sync), `setup_intent.succeeded`
  (stores the card), `payment_intent.succeeded` / `payment_intent.payment_failed` (reconcile
  `ready|pending_stripe` rows), `charge.refunded` (full refunds only; partial → critical alert),
  `charge.dispute.created` (critical alert only, no mutation) ([L325-L460](../../app/api/stripe/webhook/route.ts#L325-L460)).
- **Mode matching:** an event is processed only when `event.livemode` equals the deployment mode;
  a mismatched event is ignored with a warning alert, and a resolved row whose mode differs is never
  mutated ([`payment-webhook-reconciliation.ts` L110-L144](../../lib/billing/payment-webhook-reconciliation.ts#L110-L144),
  [L399-L425](../../lib/billing/payment-webhook-reconciliation.ts#L399-L425)). Metadata mismatches
  and terminal-state conflicts raise critical alerts and leave the row alone.

## 5. Refunds and receipts

`refundPaymentChargeAttempt` is a manual, practitioner-initiated, mode-aware refund of a
`succeeded` row, scoped to the practitioner's studio and reason-agnostic
([`payment-refund.ts` L1-L40](../../lib/billing/payment-refund.ts#L1-L40)). Receipts are emailed
through the shared email transport with a server-rendered PDF (fonts force-included in the build,
see [System overview](../architecture/system-overview.md)).

## 6. Settlement for non-card outcomes (migration `0187`)

`appointment_settlements` records a practitioner's attestation of how a completed appointment was
settled. `method` is limited to `paid_cash`, `paid_e_transfer`, `paid_other_external`, `waived`,
`still_owes` — **there is no `card` and no `hone` member**, so "a card was charged" is
unrepresentable there and Stripe truth stays only in `payment_charge_attempts`
([`0187` L205-L218](../../supabase/migrations/0187_appointment_settlement.sql#L205-L218)). The table
is append-only with a no-delete trigger, corrections go through `supersede_appointment_settlement`,
and the practitioner commands (`record_…`, `waive_appointment_fee`, `supersede_…`) are granted to
`authenticated` while the card reconcile and claim commands are `service_role`-only
([L339-L430](../../supabase/migrations/0187_appointment_settlement.sql#L339-L430),
[L1776-L1855](../../supabase/migrations/0187_appointment_settlement.sql#L1776-L1855)). The read side
distinguishes "nothing settled" from "could not read"
([`appointment-settlement.ts` L10-L30](../../lib/billing/appointment-settlement.ts#L10-L30)); DB proof
in [`tests/db/appointment-settlement.db.test.ts`](../../tests/db/appointment-settlement.db.test.ts).

## 7. Source gates and fakes

- [`scripts/check-stripe-gates.mjs`](../../scripts/check-stripe-gates.mjs#L1-L30) scans runtime
  source only and pins every money-moving Stripe call to an allowlisted file — e.g. exactly one
  `paymentIntents.create`, one `STRIPE_ALLOW_LIVE_MODE=true` comparison, no unclassified Stripe
  writes, every `getStripe()` bound to `const stripe`. It runs in `npm run ci` and in the production
  verifier.
- The fake Stripe used by `e2e-payment/` requires `HONE_E2E_FAKE_STRIPE=1` plus a valid run id and
  throws in any deployed runtime ([`e2e-fake-guard.ts` L30-L55](../../lib/stripe/e2e-fake-guard.ts#L30-L55)).

## 8. Production status (dated, with authority)

<!-- openwiki: broken internal link [../../docs/production/current-state.md#L797-L838] heading anchor "L797-L838" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
From [`current-state.md` L797-L838](../../docs/production/current-state.md#L797-L838) (counts dated
2026-08-23; not restated here):

- **Live-capable and production-exercised for two approved studios** (the real-customer pilot studio
  and the controlled test studio); broad self-serve live payments are **not ready**.
- Card-on-file via SetupIntent is in use; receipts are live; refunds are deployed with **zero**
  production rows; disputes are alert-only.
- Live manual no-show / late-cancellation fees are **held**.
- Settlement (`0187`, applied 2026-08-24) is **deployed and enabled but not production-exercised**
  (zero rows at post-apply verification).
- Public-booking card collection is off and unwired; deposits, packages and partial payments are not
  built.

## 9. Contradictions and open questions

1. **Stale "test mode only" headers in the webhook path.** The route header and the reconciliation
   module still describe reconciliation as test-mode only, with live events ignored and a
   `livemode = false` CHECK as backstop
   ([route L1-L50](../../app/api/stripe/webhook/route.ts#L1-L50),
   [reconciliation L15-L30](../../lib/billing/payment-webhook-reconciliation.ts#L15-L30)); the code
   now processes events matching the deployment mode
   ([L110-L144](../../lib/billing/payment-webhook-reconciliation.ts#L110-L144)), and the runbook records
<!-- openwiki: broken internal link [../../docs/11_RUNBOOK.md#L136-L136] heading anchor "L136-L136" does not exist in "../../docs/11_RUNBOOK.md". Fix the href or restore the target, then delete this comment. -->
   that `0101` dropped that CHECK ([`docs/11_RUNBOOK.md` L136](../../docs/11_RUNBOOK.md#L136-L136)).
2. **`docs/06_PAYMENTS_AND_STRIPE.md` section headings still say "test mode only"** for the prepare,
<!-- openwiki: broken internal link [../../docs/06_PAYMENTS_AND_STRIPE.md#L108-L108] heading anchor "L108-L108" does not exist in "../../docs/06_PAYMENTS_AND_STRIPE.md". Fix the href or restore the target, then delete this comment. -->
   refund and webhook-reconciliation flows ([L108](../../docs/06_PAYMENTS_AND_STRIPE.md#L108-L108),
<!-- openwiki: broken internal link [../../docs/06_PAYMENTS_AND_STRIPE.md#L223-L223] heading anchor "L223-L223" does not exist in "../../docs/06_PAYMENTS_AND_STRIPE.md". Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [../../docs/06_PAYMENTS_AND_STRIPE.md#L283-L283] heading anchor "L283-L283" does not exist in "../../docs/06_PAYMENTS_AND_STRIPE.md". Fix the href or restore the target, then delete this comment. -->
   [L223](../../docs/06_PAYMENTS_AND_STRIPE.md#L223-L223), [L283](../../docs/06_PAYMENTS_AND_STRIPE.md#L283-L283)),
   while the canonical record says live charges run for two studios.
3. **The 4 unresolved `ops_alerts`** recorded on 2026-08-23 are the 4 non-succeeded live charge
   attempts (limitation L26); whether they have since been resolved is not recorded.
