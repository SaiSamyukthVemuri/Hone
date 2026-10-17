---
type: payment system
title: Payments, Stripe and appointment settlement
description: How Hone moves money — the Stripe key and mode gate, the single server-side amount authority, the claim-then-charge executor with a deterministic idempotency key, mode-matched webhook reconciliation, refunds and automatic receipts serialized on the same row, the practitioner-attested settlement ledger for non-card outcomes (0187), the source gates that pin every money-moving Stripe call, and each capability's lifecycle state with a pointer to the canonical record.
tags: [payments, stripe, webhooks, refunds, receipts, settlement]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-5505b485d5cc08afda1370bc
    resource: repo://app/api/stripe/webhook/route.ts
  - id: openwiki-source-e68c1485de103522e8643a92
    resource: repo://docs/06_PAYMENTS_AND_STRIPE.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-7653d42202d925c0d3bd5dde
    resource: repo://lib/billing/appointment-settlement.ts
  - id: openwiki-source-12b3d91a530bd1a57918950f
    resource: repo://lib/billing/authoritative-session-payment.ts
  - id: openwiki-source-9db2378db35af411345cdb91
    resource: repo://lib/billing/auto-payment-receipt.ts
  - id: openwiki-source-a045f3d3c7a4716fae15aa41
    resource: repo://lib/billing/live-charge-reason-allowlist.ts
  - id: openwiki-source-728e6be1ffe4df16789fd053
    resource: repo://lib/billing/payment-receipt.ts
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
  - id: openwiki-source-50a18d054b596a7ed0eeffb0
    resource: repo://next.config.ts
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-a421dfeda46a4aa9d2508a95
    resource: repo://scripts/check-stripe-gates.mjs
  - id: openwiki-source-e992a10390ffd889171e7aa3
    resource: repo://scripts/verify-production.mjs
  - id: openwiki-source-bab3af3843730021dfbc5970
    resource: repo://supabase/migrations/0101_live_payment_charge_attempts_db_readiness.sql
  - id: openwiki-source-52dc3e5e0c9c4b9c637f3387
    resource: repo://supabase/migrations/0187_appointment_settlement.sql
  - id: openwiki-source-e90287adfb8f42d0db1b3f3b
    resource: repo://tests/lib/billing/automatic-payment-receipt.test.ts
  - id: openwiki-source-23de5df90f409b220b9d7d17
    resource: repo://tests/lib/billing/payment-refund-receipt-mutual-serialization.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Payments, Stripe and appointment settlement

Hone charges a client's saved card through **Stripe Connect** (direct charges on the studio's connected account) only
when a practitioner clicks to charge. The canonical record states that there is no automatic, background, batch or
public-triggered charge path, and the source gates pin the only `paymentIntents.create` call site to the charge
executor (section 7). Non-card outcomes (cash, e-transfer, waived, still owing) are recorded in a separate ledger that
cannot express "a card was charged".

Card-on-file persistence, the checkout amount decision, quick checkout, manual review and the `e2e-payment` browser lane
are on [Card on file, checkout and payment proof](card-on-file-checkout-and-payment-proof.md).

## 1. Stripe client and mode gate

[`lib/stripe/server.ts`](../../lib/stripe/server.ts#L1-L66) is the only place a secret-key client is built:

- `assertStripeKeyAllowed`: the key must be `sk_test_` or `sk_live_`; a live key also requires
  `STRIPE_ALLOW_LIVE_MODE === "true"`; Vercel **preview** and **development** must always use a test key.
- The API version is pinned (`2026-04-22.dahlia`, [L33](../../lib/stripe/server.ts#L33-L33)); bumping it is a
  deliberate change.
- The deployment's mode (`inferStripeLivemode()`) is the reference every charge, refund and webhook handler compares
  rows against.

## 2. The amount authority

[`authoritative-session-payment.ts`](../../lib/billing/authoritative-session-payment.ts#L1-L60) is **the** server-side
loader for a session payment's amount: every surface that shows or prepares a charge, including the prepare action,
which re-loads independently, resolves the price here from current records. Lineage is enforced (live session in this
studio, then its linked appointment, never "an appointment of this client", then same studio and client, then a service
of the same studio); any break is unresolved, and a **read failure is reported as `read_failed`**, never as an empty
pricing set that would silently fall back to a menu price.

## 3. Charging: claim, then call Stripe once

`runSessionPaymentCharge` in
[`session-payment-charge.ts`](../../lib/billing/session-payment-charge.ts#L13-L62):

1. Derives the deployment mode and requires the attempt row, card, studio settings and customer to match it; re-runs
   eligibility, card lineage and a **current card-authorization** recheck.
2. Calls `claim_session_payment_charge_attempt`, which atomically moves the row `ready → pending_stripe` and stamps a
   deterministic idempotency key `hone:<charge_reason>:<attemptId>:v1`
   ([L83-L92](../../lib/billing/session-payment-charge.ts#L83-L92),
   [L1234-L1241](../../lib/billing/session-payment-charge.ts#L1234-L1241)). The command is `SECURITY DEFINER` and
   `service_role`-only; its latest definition is in migration `0187`
   ([`0187` L1534-L1560](../../supabase/migrations/0187_appointment_settlement.sql#L1534-L1560),
   [L1852-L1855](../../supabase/migrations/0187_appointment_settlement.sql#L1852-L1855)).
3. Creates a PaymentIntent (`confirm=true`) on the connected account with that key, so Stripe's idempotent replay
   covers network-error retries ([L1390-L1414](../../lib/billing/session-payment-charge.ts#L1390-L1414)).
4. Writes `succeeded` (with PaymentIntent and charge ids) or `failed` on the same row. A Stripe success whose local
   write cannot be confirmed is surfaced as "needs review", not retried.

It never refunds, never re-executes a non-`ready` row (except reconciling a stale `pending_stripe` claim no older than
the 60-minute window; an older one raises a critical manual-review alert), and sets no platform fee
([L47-L64](../../lib/billing/session-payment-charge.ts#L47-L64),
[L1345-L1360](../../lib/billing/session-payment-charge.ts#L1345-L1360)).

**Live charge reasons are allow-listed server-side:** in live mode only `session_payment` may be prepared or executed;
no-show and late-cancellation fees are on a hard hold, while test mode allows every reason
([`live-charge-reason-allowlist.ts` L1-L36](../../lib/billing/live-charge-reason-allowlist.ts#L1-L36)).

## 4. Webhooks (`/api/stripe/webhook`)

- Raw body, `stripe.webhooks.constructEvent` signature verification, a generic 400 on any failure; a missing
  `STRIPE_WEBHOOK_SECRET` throws ([route L100-L150](../../app/api/stripe/webhook/route.ts#L100-L150)).
- Each event is claimed idempotently through `claim_stripe_event`, unique on `(account, livemode, event_id)`; a
  duplicate delivery is acknowledged without reprocessing
  ([L195-L230](../../app/api/stripe/webhook/route.ts#L195-L230)).
- Handled: `account.updated` / `capability.updated` (account status sync), `setup_intent.succeeded` (stores the card),
  `payment_intent.succeeded` / `payment_intent.payment_failed` (reconcile `ready|pending_stripe` rows),
  `charge.refunded` (full refunds; a partial refund raises a critical alert), and `charge.dispute.created` (critical
  alert only, no mutation) ([L325-L460](../../app/api/stripe/webhook/route.ts#L325-L460)).
- **Mode matching:** an event is processed only when `event.livemode` equals the deployment mode; a mismatched event is
  ignored with a warning alert, and a row whose mode differs from the deployment is never mutated
  ([`payment-webhook-reconciliation.ts` L110-L144](../../lib/billing/payment-webhook-reconciliation.ts#L110-L144),
  [L399-L425](../../lib/billing/payment-webhook-reconciliation.ts#L399-L425)). Metadata mismatches and terminal-state
  conflicts raise critical alerts and leave the row alone.

## 5. Refunds and receipts

**Refunds.** `refundPaymentChargeAttempt` is a manual, practitioner-initiated, mode-aware refund of a `succeeded` row,
scoped to the practitioner's studio and agnostic of charge reason
([`payment-refund.ts` L1-L40](../../lib/billing/payment-refund.ts#L1-L40)).

**Automatic receipts** go out after a card charge from the **action layer**, not from inside the Stripe executor, so the
money path never depends on a mail server
([`auto-payment-receipt.ts` L17-L26](../../lib/billing/auto-payment-receipt.ts#L17-L26)). The design, in its own terms:

- **Gate 1, money settled:** only a charge that Stripe confirmed *and* Hone durably persisted as `succeeded` qualifies;
  `needs_manual_review` sends nothing.
- **Gate 2, a current invocation:** the invocation either committed `pending_stripe → succeeded` itself or concurrently
  reconciled the same verified charge; a replay against an already-succeeded attempt starts no receipt
  ([L45-L73](../../lib/billing/auto-payment-receipt.ts#L45-L73)).
- **The database claim is the owner:** a conditional UPDATE of `receipt_status` from NULL to `sending`, which for
  automatic delivery also requires `refund_status IS NULL` in the same statement. The refund claim carries the
  reciprocal predicate: it admits only a NULL, `sent` or `failed` receipt state, so it refuses while a receipt is
  `sending`. Both are conditional UPDATEs on the same row, so Postgres serializes them and at most one of the pair is in
  flight ([L76-L103](../../lib/billing/auto-payment-receipt.ts#L76-L103);
  [`payment-refund.ts` L386-L413](../../lib/billing/payment-refund.ts#L386-L413)).
- **Ambiguous delivery holds the claim** (no duplicate send); a definitive pre-dispatch failure may release it. The
  result is best-effort and at most one, not exactly-once and not a durable outbox, and a receipt failure never makes a
  successful charge look failed ([L106-L142](../../lib/billing/auto-payment-receipt.ts#L106-L142)).
- A practitioner can still send a receipt manually; that policy may claim a `failed` row and is not refund-gated.

Tests: [`automatic-payment-receipt.test.ts`](../../tests/lib/billing/automatic-payment-receipt.test.ts#L129-L427) and
[`payment-refund-receipt-mutual-serialization.test.ts`](../../tests/lib/billing/payment-refund-receipt-mutual-serialization.test.ts#L287-L531).
The receipt email carries a server-rendered PDF attachment sent through `sendEmailSafely`
([`payment-receipt.ts` L821-L832](../../lib/billing/payment-receipt.ts#L821-L832)); the PDF fonts are read from disk,
so the build force-includes them ([`next.config.ts` L48-L56](../../next.config.ts#L48-L56); see
[Email delivery](../communications/email-delivery.md)).

## 6. Settlement for non-card outcomes (migration `0187`)

`appointment_settlements` records a practitioner's attestation of how a completed appointment was settled. `method` is
limited to `paid_cash`, `paid_e_transfer`, `paid_other_external`, `waived` and `still_owes`; **there is no `card` and
no `hone` member**, so "a card was charged" is unrepresentable there and Stripe truth stays only in
`payment_charge_attempts` ([`0187` L205-L218](../../supabase/migrations/0187_appointment_settlement.sql#L205-L218)).

- The table is append-only with a no-delete trigger; corrections go through `supersede_appointment_settlement`
  ([L339-L430](../../supabase/migrations/0187_appointment_settlement.sql#L339-L430)).
- The practitioner commands (`record_appointment_settlement`, `waive_appointment_fee`, `supersede_…`) are granted to
  `authenticated`, while the card reconcile and claim commands are `service_role`-only
  ([L1776-L1855](../../supabase/migrations/0187_appointment_settlement.sql#L1776-L1855)).
- The read side distinguishes "nothing settled" from "could not read"
  ([`appointment-settlement.ts` L10-L30](../../lib/billing/appointment-settlement.ts#L10-L30)); database proof is in
  [`appointment-settlement.db.test.ts`](../../tests/db/appointment-settlement.db.test.ts).

## 7. Source gates and fakes

- [`scripts/check-stripe-gates.mjs`](../../scripts/check-stripe-gates.mjs#L1-L30) scans runtime source only (`app`,
  `lib`, `components`, `middleware.ts`, `next.config.ts`) and pins every money-moving Stripe call to an allowlisted file:
  exactly one `paymentIntents.create` (in the charge executor), no `charges.create` or `checkout.sessions`, the
  `STRIPE_ALLOW_LIVE_MODE=true` string only in `lib/stripe/server.ts`, a catch-all for unclassified Stripe writes, and
  every client bound as `const stripe = getStripe()` so a renamed client cannot evade the inventory
  ([L45-L162](../../scripts/check-stripe-gates.mjs#L45-L162), [L245-L258](../../scripts/check-stripe-gates.mjs#L245-L258),
  [L404-L545](../../scripts/check-stripe-gates.mjs#L404-L545)).
- It runs in `npm run ci` ([`package.json` L26](../../package.json#L26-L26)) and in the production verifier
  ([`verify-production.mjs` L357-L367](../../scripts/verify-production.mjs#L357-L367)).
- The fake Stripe used by `e2e-payment/` requires `HONE_E2E_FAKE_STRIPE=1` plus a valid run id and is refused in any
  deployed runtime ([`e2e-fake-guard.ts` L30-L55](../../lib/stripe/e2e-fake-guard.ts#L30-L55)).

## 8. Lifecycle state

All values behind these states (accounts, charge and alert figures, dates) are in
[`current-state.md` § 7. Payments and Stripe](../../docs/production/current-state.md#7-payments-and-stripe); this page
does not restate them.

| Capability | State |
|---|---|
| Card charging | live-capable and production-exercised for approved studios; broad self-serve live payments **not ready** (a new studio starts in test mode) |
| Receipts | live |
| Refunds | deployed; not production-exercised on the record's baseline |
| Disputes | alert-only |
| Live no-show / late-cancellation fees | **held** by the server-side allowlist |
| Settlement (`0187`) | deployed and enabled, **not production-exercised** |
| Public-booking card collection; deposits, packages, partial payments | off and unwired; not built |

## 9. Contradictions and open questions

1. **Stale "test mode only" comments in the money path.** The webhook route header and the reconciliation module still
   describe reconciliation as test-mode only, with live events ignored and a `livemode = false` CHECK as backstop
   ([route L1-L50](../../app/api/stripe/webhook/route.ts#L1-L50),
   [reconciliation L15-L30](../../lib/billing/payment-webhook-reconciliation.ts#L15-L30)), and the Stripe gate's
   allowlist note for `paymentIntents.create` still cites that CHECK
   ([`check-stripe-gates.mjs` L86-L107](../../scripts/check-stripe-gates.mjs#L86-L107)). The code processes events
   matching the deployment mode ([L110-L144](../../lib/billing/payment-webhook-reconciliation.ts#L110-L144)), and
   migration `0101` dropped `payment_charge_attempts_livemode_false_check`
   ([`0101` L19-L46](../../supabase/migrations/0101_live_payment_charge_attempts_db_readiness.sql#L19-L46)).
2. **`docs/06_PAYMENTS_AND_STRIPE.md` section headings still say "test mode only"** for the prepare, refund and
   webhook-reconciliation flows
   ([§ 4b](../../docs/06_PAYMENTS_AND_STRIPE.md#4b-session-payment-prepare-flow-pr-172-test-mode-only),
   [§ 4c](../../docs/06_PAYMENTS_AND_STRIPE.md#4c-session-payment-refund-flow-pr-178-test-mode-only),
   [§ 4d](../../docs/06_PAYMENTS_AND_STRIPE.md#4d-webhook-reconciliation-for-payment_charge_attempts-pr-179-test-mode-only)),
   while the canonical record states that live charges run for approved studios.
3. **Unresolved payment alerts are still untriaged.** Limitation L26 in
   [`known-limitations.md`](../../docs/production/known-limitations.md) records unresolved `ops_alerts` raised by
   non-succeeded live charge attempts, with their cause not yet determined; the repository does not record whether they
   have since been triaged or resolved.
