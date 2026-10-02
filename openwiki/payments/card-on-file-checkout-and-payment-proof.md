---
type: product workflow
title: Card on file, checkout and payment proof
description: How a client's card is saved (portal SetupIntent, webhook-only persistence, the per-mode one-active-card invariant and the atomic 0180 replacement command), how checkout and quick checkout decide the amount (server-resolved reference, owner-only authored totals, stale-display refusal), the settlement and manual-review surfaces around a charge, the three-state card-on-file read, and what the isolated fake-Stripe e2e-payment lane proves in a real browser.
tags: [payments, stripe, card-on-file, checkout, quick-checkout, settlement, e2e, idempotency]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
sources:
  - id: openwiki-source-95692b29c28470b929823124
    resource: repo://app/(app)/appointment-settlement-actions.ts
  - id: openwiki-source-0acc2a7c09d6237a5aa20e28
    resource: repo://app/(app)/clients/%5Bid%5D/sessions/%5BsessionId%5D/payment-actions.ts
  - id: openwiki-source-723917bdd1a2b72101a3e9c8
    resource: repo://app/(app)/quick-checkout-actions.ts
  - id: openwiki-source-5505b485d5cc08afda1370bc
    resource: repo://app/api/stripe/webhook/route.ts
  - id: openwiki-source-e8d958ad8c2f96d87132ab97
    resource: repo://e2e-payment/ambiguous-response-payment.spec.ts
  - id: openwiki-source-131c6052b75883a5bf4ba58c
    resource: repo://e2e-payment/custom-final-amount-payment.spec.ts
  - id: openwiki-source-55b61d2eb34831af6bca36f2
    resource: repo://e2e-payment/duplicate-click-payment.spec.ts
  - id: openwiki-source-165ef1836c4e56d6f1aaeeb5
    resource: repo://e2e-payment/helpers/payment-env.ts
  - id: openwiki-source-73bffe3e94b6899ec34d3e92
    resource: repo://e2e-payment/server-authoritative-amount.spec.ts
  - id: openwiki-source-ee50fec5f731893ed54b5e69
    resource: repo://e2e-payment/two-context-concurrency-payment.spec.ts
  - id: openwiki-source-46172e60f6bb23cbe05a72bc
    resource: repo://lib/billing/checkout-final-amount.ts
  - id: openwiki-source-68bb6b846e47cf96819f7a3c
    resource: repo://lib/billing/payment-manual-review.ts
  - id: openwiki-source-d51143e9a94e2c6c7391fc6e
    resource: repo://lib/billing/quick-checkout.ts
  - id: openwiki-source-758ce8a38b70c754da75958f
    resource: repo://lib/billing/session-payment-types.ts
  - id: openwiki-source-d40318959676bce8ba125238
    resource: repo://lib/payment-methods/card-on-file.ts
  - id: openwiki-source-792169026b7173c06b3173ae
    resource: repo://lib/payment-methods/refresh-card-authorization-pointer.ts
  - id: openwiki-source-d5690164325f270934260b22
    resource: repo://lib/stripe/setup-intent.ts
  - id: openwiki-source-04358e0b11ae8f1adeeffe33
    resource: repo://playwright.payment.config.ts
  - id: openwiki-source-64c02e7fa87b8a6af48e4bdf
    resource: repo://supabase/migrations/0058_client_payment_methods.sql
  - id: openwiki-source-2dfa3f7bd0be8567d18f9623
    resource: repo://supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql
  - id: openwiki-source-1587182026e684666f6806a9
    resource: repo://supabase/migrations/0104_one_active_card_per_pair_per_mode.sql
  - id: openwiki-source-5596076f7b4bdc129665fe95
    resource: repo://supabase/migrations/0180_card_payment_method_replacement_integrity.sql
  - id: openwiki-source-f08cb5f9aff737afac9bb1d1
    resource: repo://tests/db/active-card-per-mode.db.test.ts
  - id: openwiki-source-670177f5e8a505f0dbf4aa76
    resource: repo://tests/db/card-replacement-atomicity.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
---

# Card on file, checkout and payment proof

This page covers the pieces around the charge engine. The engine itself is on
[Payments, Stripe and appointment settlement](stripe-payments-and-settlement.md): the Stripe mode gate,
the amount authority, the charge claim, webhooks, refunds and the `0187` settlement ledger. Here: how a
card gets on file, how the checkout amount is decided, and what the dedicated browser lane proves.

## 1. Saving a card

**Collection** happens in the client portal through a Stripe **SetupIntent** on the studio's connected
account ([`setup-intent.ts`](../../lib/stripe/setup-intent.ts#L1-L94)):

- **Stripe customer.** `getOrCreateStripeCustomerForCardOnFile` serialises customer creation through
  the `0032` provisioning RPCs. Concurrent "Add card" clicks therefore cannot mint two Stripe customers
  for one `(studio, client, account, mode)`. A missing client email is refused (`P0002`).
- **No card row from the browser.** Neither helper writes `client_payment_methods`. The row is created
  only from Stripe-verified data in the `setup_intent.succeeded` webhook arm.

**Persistence** (`client_payment_methods`, `0058`)
([`0058` L57-L204](../../supabase/migrations/0058_client_payment_methods.sql#L57-L204)):

- **Lineage foreign keys.** Rows must match the studio's `(account, mode)` payment settings and the
  client's Stripe customer lineage.
- **Status and history.** `status` is `active` or `removed`, with `removed_at` coupled by a check.
  `last4` and expiry are checked.
- **No direct writes.** Authenticated members may only SELECT. There is no authenticated write policy.
- **One active card per mode.** `0058`'s partial unique index allowed one active card per
  `(studio, client)`. `0104` rescoped it to `(studio, client, stripe_livemode)`, because a client may
  legitimately hold one active test card and one active live card. Without that, a live insert would
  have hit `23505`, which the webhook treats as idempotent success, and the live card would silently
  never land ([`0104`](../../supabase/migrations/0104_one_active_card_per_pair_per_mode.sql)).
- **One row per SetupIntent.** `0059` makes the row unique per `(account, mode, setup_intent)`.

**Replacement is one transaction (`0180`).** The unique index forces retire-before-insert. As two
PostgREST writes, any non-`23505` insert failure left the client with **zero active cards**, and a
Stripe retry repeated the destructive order. `save_client_card_on_file` fixes this
([`0180` L1-L212](../../supabase/migrations/0180_card_payment_method_replacement_integrity.sql#L1-L212)):

- it is `SECURITY DEFINER` with `search_path = ''`, and EXECUTE is revoked from every role and granted
  to `service_role` only;
- it takes an advisory transaction lock per `(studio, client, mode)`;
- it re-validates customer and signature lineage (`22023`);
- it retires the same-mode active card and inserts the new one together;
- it returns `inserted` or `idempotent` and raises on everything else.

The webhook surfaces a raise as a throw, so Stripe retries and the **old card stays active**
([`webhook route` L735-L780](../../app/api/stripe/webhook/route.ts#L735-L780)).
`tests/db/card-replacement-atomicity.db.test.ts` proves the atomic swap, the failed-replacement case,
idempotency, concurrent replacements, lineage refusals, and a negative control showing the old
two-write sequence really did lose the card.

**Card authorization pointer.** A card row points at the client's signed card-authorization consent.
After a fresh `card_authorization` signature, `refresh-card-authorization-pointer.ts` updates the
active card's pointer to the new signature, so a dispute can be answered with the authorization the
client actually signed. `0077` backfilled cards whose pointer had gone stale.

**Card-on-file status on the dashboard** ([`card-on-file.ts`](../../lib/payment-methods/card-on-file.ts#L1-L40)):

- It keeps three states. A failed read is never rendered as "No card", because a read failure is not a
  client failure.
- It is mode-scoped, so a test card under a live deployment is not "on file".
- It selects only `client_id`. No Stripe ids, brand or last4 reach the HTML.

## 2. Deciding the checkout amount

**F-PAY-001** made the server-resolved price the only preparation amount: the prepare action had read
`amount_dollars` from the form. **F-PAY-002** then restored one operator capability without reopening
that hole ([`checkout-final-amount.ts`](../../lib/billing/checkout-final-amount.ts#L10-L60),
[L197-L300](../../lib/billing/checkout-final-amount.ts#L197-L300)):

1. **Stale display first.** The browser sends the reference it was showing. If it differs from the
   freshly resolved reference, the request is refused with "refresh and review", never silently
   re-priced.
2. **Strict parse.** The final total is parsed as CAD with at most two decimals and refused above the
   ceiling (`SESSION_PAYMENT_AMOUNT_CEILING_CENTS` = 200,000). It is never coerced or clamped.
3. **$0.00** returns "no charge required" and prepares nothing.
4. **Unchanged total.** Charging exactly the reference needs no owner and no reason.
5. **Changed total.** A different total requires `actorIsOwner`, derived from the authenticated
   practitioner. No form field carries it. The total also needs a *meaningful* adjustment reason, which
   is appended as a single-line audit note.

The browser can influence **one number** under these rules. Studio, practitioner, client, session,
appointment, service, card, signature and every Stripe id are still resolved server-side
(`prepareSessionPaymentChargeAction` in `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts`).

**Quick checkout** ([`quick-checkout.ts`](../../lib/billing/quick-checkout.ts#L1-L64)) resolves an
*appointment* into the same eligibility and authoritative-amount decision the session page uses, then
drives the same prepare, execute, receipt and refund actions. It never charges or writes by itself.
Card charging is session-scoped: no session means no card charge, and the resolver never invents a
session. **Settlement** (cash, e-transfer, waived) is a separate context that needs no session, so a
completed visit that was never charted can still be marked paid in cash.
`getQuickCheckoutContextAction` derives practitioner and studio server-side
(`app/(app)/quick-checkout-actions.ts`).

**Settlement controls** (`app/(app)/appointment-settlement-actions.ts`) are thin wrappers over the
three `0187` commands (`record_…`, `waive_appointment_fee`, `supersede_…`):

- They issue no Stripe call.
- They do not decide the quoted amount. The command derives it, because the commands are granted to
  `authenticated` and anything the action passes could be passed by a hand-built call.

## 3. When something goes wrong: manual review

`/admin/payments/manual-review` is a **read-only** operator queue
([`payment-manual-review.ts`](../../lib/billing/payment-manual-review.ts#L1-L40)). It selects unresolved
**critical** payment alerts, such as:

- Stripe succeeded but the local write failed;
- unknown retrieve outcomes;
- refund write failures;
- webhook livemode or metadata mismatches;
- disputes.

It also selects `pending_stripe` rows older than the 60-minute reconcile window. Its view models copy
only allowlisted fields, so names, notes, raw messages and card data cannot reach the page. Warning-level
reconciliation alerts stay on `/admin/ops-alerts`.

## 4. The `e2e-payment` proof lane

`playwright.payment.config.ts` runs a physically separate lane
([config](../../playwright.payment.config.ts#L7-L62)):

- `testDir: ./e2e-payment`, its own web server with the fake-Stripe markers (`HONE_E2E_FAKE_STRIPE=1`
  plus a run id), and `reuseExistingServer: false`;
- a local production build and the local Supabase stack only;
- the shared schema preflight and teardown;
- an iPad-sized touch viewport and a single worker.

The fake throws in any deployed runtime (see the main payments page), so no real charge, refund, email
or SMS can leave the lane.

| Spec | Proves |
|---|---|
| `duplicate-click-payment` | a rapid duplicate click charges exactly once: one attempt, one effect |
| `two-context-concurrency-payment` | two browser contexts charging the same attempt produce one effect and one `succeeded` |
| `ambiguous-response-payment` | a committed charge whose response was lost recovers to Paid on reload, with no duplicate |
| `server-authoritative-amount` | a crafted `amount_dollars`, an appended duplicate field or a tampered expected reference prepares nothing; a price changed after render blocks, then prepares at the new amount |
| `custom-final-amount-payment` | an owner-authored total is prepared, confirmed and charged at exactly that amount |
| `checkout-default-amount` | session detail and quick checkout prefill the same reference and name its source; a client-specific price wins and says so |
| `quick-checkout-payment` | the iPad journey from dashboard to persisted Paid |

The lane is the browser half of the proof. The database half is in `tests/db/`:

- `card-replacement-atomicity.db.test.ts`;
- `active-card-per-mode.db.test.ts`;
- `quick-checkout-eligibility.db.test.ts`;
- `appointment-settlement.db.test.ts`.

## 5. Status and limits

Production facts (two approved live studios, refunds deployed with zero production rows, fees held,
settlement not production-exercised) are on the main payments page, from `current-state.md`. Nothing
on this page changes them. Card collection on public booking is **off and unwired**. Deposits, packages
and partial payments are **not built**.
