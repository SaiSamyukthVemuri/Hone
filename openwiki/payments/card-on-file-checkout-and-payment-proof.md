---
type: payment workflow
title: Card on file, checkout and payment proof
description: How a client's card gets on file (SetupIntent, Stripe-verified webhook persistence, one active card per Stripe mode, atomic replacement in 0180), the studio card-change notification, how the checkout amount is decided (F-PAY-001/F-PAY-002), quick checkout versus appointment settlement context, the read-only manual-review queue, and what the isolated e2e-payment browser lane proves.
tags: [payments, card-on-file, stripe, checkout, quick-checkout, e2e-payment]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-95692b29c28470b929823124
    resource: repo://app/(app)/appointment-settlement-actions.ts
  - id: openwiki-source-0acc2a7c09d6237a5aa20e28
    resource: repo://app/(app)/clients/%5Bid%5D/sessions/%5BsessionId%5D/payment-actions.ts
  - id: openwiki-source-723917bdd1a2b72101a3e9c8
    resource: repo://app/(app)/quick-checkout-actions.ts
  - id: openwiki-source-5505b485d5cc08afda1370bc
    resource: repo://app/api/stripe/webhook/route.ts
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
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
  - id: openwiki-source-f02252b67835ac1de853aaf8
    resource: repo://lib/billing/card-change-notification.ts
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
  - id: openwiki-source-c1c0f96c28b2d034e3556a01
    resource: repo://supabase/migrations/0059_client_payment_methods_setup_intent_unique.sql
  - id: openwiki-source-2dfa3f7bd0be8567d18f9623
    resource: repo://supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql
  - id: openwiki-source-1587182026e684666f6806a9
    resource: repo://supabase/migrations/0104_one_active_card_per_pair_per_mode.sql
  - id: openwiki-source-5596076f7b4bdc129665fe95
    resource: repo://supabase/migrations/0180_card_payment_method_replacement_integrity.sql
  - id: openwiki-source-f08cb5f9aff737afac9bb1d1
    resource: repo://tests/db/active-card-per-mode.db.test.ts
  - id: openwiki-source-9a495972747e03594fa7fa1f
    resource: repo://tests/db/card-change-notification-orchestration.db.test.ts
  - id: openwiki-source-670177f5e8a505f0dbf4aa76
    resource: repo://tests/db/card-replacement-atomicity.db.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Card on file, checkout and payment proof

This page covers the pieces around the charge engine. The engine itself (the Stripe mode gate, the amount authority,
the charge claim, webhooks, refunds and the `0187` settlement ledger) is on
[Payments, Stripe and appointment settlement](stripe-payments-and-settlement.md). Here: how a card gets on file, how
the checkout amount is decided, and what the dedicated browser lane proves.

## 1. Saving a card

**Collection** happens in the client portal through a Stripe **SetupIntent** on the studio's connected account
([`setup-intent.ts`](../../lib/stripe/setup-intent.ts#L5-L94)):

- **One Stripe customer per tuple.** `getOrCreateStripeCustomerForCardOnFile` serialises customer creation through the
  `0032` provisioning RPCs, so concurrent "Add card" clicks cannot mint two Stripe customers for one
  `(studio, client, account, mode)`.
- **No card row from the browser.** Neither helper writes `client_payment_methods`. The row is created only from
  Stripe-verified data in the `setup_intent.succeeded` webhook arm.

**Persistence** (`client_payment_methods`, migration `0058`)
([`0058` L57-L138](../../supabase/migrations/0058_client_payment_methods.sql#L57-L138),
[L192-L204](../../supabase/migrations/0058_client_payment_methods.sql#L192-L204)):

- **Lineage foreign keys.** A row must match the studio's `(account, mode)` payment settings and the client's Stripe
  customer lineage.
- **Status and history.** `status` is `active` or `removed`, with `removed_at` coupled to it by a check.
- **No direct writes.** Studio members may only SELECT; there is no authenticated INSERT, UPDATE or DELETE policy.
- **One row per SetupIntent.** `0059` makes the row unique per `(account, mode, setup_intent)`
  ([`0059` L24-L27](../../supabase/migrations/0059_client_payment_methods_setup_intent_unique.sql#L24-L27)).
- **One active card per Stripe mode.** `0058`'s partial unique index allowed one active card per `(studio, client)`.
  `0104` rescoped it to `(studio, client, stripe_livemode)` because a client may legitimately hold one active test card
  and one active live card. Without that, a live insert would have hit `23505`, which the webhook treats as idempotent
  success, and the live card would silently never land
  ([`0104` L1-L30](../../supabase/migrations/0104_one_active_card_per_pair_per_mode.sql#L1-L30); proved in
  [`active-card-per-mode.db.test.ts`](../../tests/db/active-card-per-mode.db.test.ts#L69-L87)).

**Replacement is one transaction (`0180`).** The unique index forces retire-before-insert. As two PostgREST writes, any
non-`23505` insert failure left the client with **no active card**, and a Stripe retry repeated the destructive order.
`save_client_card_on_file` closes this
([`0180` L1-L212](../../supabase/migrations/0180_card_payment_method_replacement_integrity.sql#L1-L212)):

- it is `SECURITY DEFINER`; EXECUTE is revoked from every role and granted to `service_role` only;
- it takes an advisory transaction lock per `(studio, client, mode)`;
- it re-validates customer and signature lineage;
- it retires the same-mode active card and inserts the new one together;
- it returns `inserted` or `idempotent` and raises on everything else.

The webhook surfaces a raise as a throw, so Stripe retries and the **old card stays active**
([`webhook route` L735-L780](../../app/api/stripe/webhook/route.ts#L735-L780)).
[`card-replacement-atomicity.db.test.ts`](../../tests/db/card-replacement-atomicity.db.test.ts#L88-L260) proves the
atomic swap, the failed-replacement case, idempotency, concurrent replacements, lineage refusals, and a negative control
showing that the old two-write sequence really did lose the card.

**Card authorization pointer.** A card row points at the client's signed card-authorization consent. After a fresh
`card_authorization` signature, `refresh-card-authorization-pointer.ts` moves the active card's
`card_authorization_signature_id` to the new signature, so a dispute can be answered with the authorization the client
actually signed ([L1-L30](../../lib/payment-methods/refresh-card-authorization-pointer.ts#L1-L30),
[L150-L165](../../lib/payment-methods/refresh-card-authorization-pointer.ts#L150-L165)). Migration `0077` backfilled
pointers that had gone stale
([`0077` L1-L25](../../supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql#L1-L25)).

**Card-on-file status on the dashboard** ([`card-on-file.ts`](../../lib/payment-methods/card-on-file.ts#L1-L40)):

- It keeps three states. A failed read is never rendered as "No card", because a read failure is not a client failure.
- It is scoped to the deployment's Stripe mode, so a test card under a live deployment is not "on file".
- It selects only `client_id`; no Stripe ids, brand or last4 reach the HTML.

## 2. Studio notification when a card changes

After the card row is persisted, the webhook calls `ensureCardChangeNotification` on every success branch (fresh
insert, the already-saved idempotency branch and the `23505` backstop). The call is awaited: if it throws, the webhook
releases its Stripe event claim and Stripe retries, while the saved card row stays as it is
([`card-change-notification.ts` L9-L39](../../lib/billing/card-change-notification.ts#L9-L39);
webhook [L684-L695](../../app/api/stripe/webhook/route.ts#L684-L695),
[L799-L808](../../app/api/stripe/webhook/route.ts#L799-L808)).

- **Added or replaced comes from persisted history**, never from the portal's add/replace mode: when the card just
  saved is the client's only payment-method row in that Stripe mode it is `card_added`; when an earlier row exists in
  that mode it is `card_replaced`
  ([L108-L120](../../lib/billing/card-change-notification.ts#L108-L120)).
- **Dedupe on the SetupIntent, not the Stripe event.** The key is `stripe:setup_intent:<test|live>:<id>`, matching the
  card row's own per-SetupIntent identity, so a redelivery or a second distinct event for the same SetupIntent inserts
  one notification. It is studio-wide (`practitioner_id` null) and goes through the single notification writer
  ([L148-L166](../../lib/billing/card-change-notification.ts#L148-L166); see
  [Dashboard, financials and owner capacity](../owner/dashboard-financials-and-capacity.md)).
- **Privacy.** The body carries only the client name, card brand and last4; no expiry, Stripe ids, signature id,
  email or phone. `card_removed` and `default_card_changed` are not emitted because the portal has no removal or
  default-card workflow.
- Proved against the local database in
  [`card-change-notification-orchestration.db.test.ts`](../../tests/db/card-change-notification-orchestration.db.test.ts#L147-L230)
  (one notification per SetupIntent, mode-scoped keys, a missing notification re-created on retry, card rows never
  mutated).

## 3. Deciding the checkout amount

**F-PAY-001** made the server-resolved price the only preparation amount: the prepare action had read `amount_dollars`
from the form. **F-PAY-002** then restored one operator capability without reopening that hole
([`checkout-final-amount.ts` L10-L60](../../lib/billing/checkout-final-amount.ts#L10-L60),
[L197-L300](../../lib/billing/checkout-final-amount.ts#L197-L300)). `decideCheckoutFinalAmount` applies, in order:

1. **Stale display first.** The browser sends the reference it was showing. If it differs from the freshly resolved
   reference, the request is refused with "refresh and review", never silently re-priced.
2. **Strict parse.** The final total is parsed as CAD with at most two decimals and refused above the ceiling
   (`SESSION_PAYMENT_AMOUNT_CEILING_CENTS` = 200,000 cents,
   [`session-payment-types.ts` L24](../../lib/billing/session-payment-types.ts#L24-L24)). It is never coerced or
   clamped.
3. **$0.00** returns "no charge required" and prepares nothing.
4. **Unchanged total.** Charging exactly the reference needs no owner and no reason.
5. **Changed total.** A different total requires the owner fact, derived from the authenticated practitioner and never
   from a form field, plus a *meaningful* adjustment reason, which is appended as a single-line audit note.

The browser can influence **one number** under these rules. Studio, practitioner, client, session, appointment,
service, card, signature and every Stripe id are still resolved server-side by `prepareSessionPaymentChargeAction`
in `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts` (owner fact at L150-L178).

## 4. Quick checkout and appointment settlement

**Quick checkout** ([`quick-checkout.ts` L15-L64](../../lib/billing/quick-checkout.ts#L15-L64)) resolves an
*appointment* into the same eligibility and authoritative-amount decision the session page uses, then drives the same
prepare, execute, receipt and refund actions. It never charges or writes by itself.
`getQuickCheckoutContextAction` in `app/(app)/quick-checkout-actions.ts` derives practitioner and studio server-side
(L9-L32).

- **Card charging is session-scoped.** No session means no card charge, and the resolver never invents a session; it
  points the practitioner at charting instead.
- **Settlement is a separate context.** Cash, e-transfer and waived dispositions need no session, so a completed visit
  that was never charted can still be marked paid. The settlement context is resolved first, from the appointment;
  a failed settlement read refuses up front with a reload message instead of being treated as "nothing settled"
  (`quick-checkout.ts` L136-L160).

**Settlement controls** (`app/(app)/appointment-settlement-actions.ts`, L15-L34) are thin wrappers over the three `0187`
commands. They issue no Stripe call and do not supply the quoted amount: the commands are granted to `authenticated`, so
anything the action passed could be passed by a hand-built call, and the commands re-enforce every rule and derive the
amount themselves.

## 5. Manual review

`/admin/payments/manual-review` is a **read-only** operator queue
([`payment-manual-review.ts` L1-L40](../../lib/billing/payment-manual-review.ts#L1-L40),
[L179-L192](../../lib/billing/payment-manual-review.ts#L179-L192)). It selects unresolved **critical** payment alerts
(Stripe succeeded but the local write failed, unknown retrieve outcomes, refund write failures, webhook livemode or
metadata mismatches, disputes) and `pending_stripe` attempts older than the 60-minute reconcile window. Its view models
copy only allowlisted fields, so names, notes, raw messages and card data cannot reach the page. Warning-level
reconciliation alerts stay on `/admin/ops-alerts`.

## 6. The `e2e-payment` proof lane

`playwright.payment.config.ts` runs a physically separate lane
([config L7-L42](../../playwright.payment.config.ts#L7-L42),
[L50-L59](../../playwright.payment.config.ts#L50-L59)):

- `testDir: ./e2e-payment`, its own web server started with the server-only fake-Stripe markers
  ([`payment-env.ts` L28-L35](../../e2e-payment/helpers/payment-env.ts#L28-L35)), and `reuseExistingServer: false`;
- a local production build and the local Supabase stack only, with the shared schema preflight and teardown;
- an iPad-sized touch viewport and a single worker.

The fake refuses to run in any deployed runtime (see the main payments page), so no real charge, refund, email or SMS
can leave the lane.

| Spec | Proves |
|---|---|
| `duplicate-click-payment` | a rapid duplicate click charges exactly once: one attempt, one effect |
| `two-context-concurrency-payment` | two browser contexts charging the same attempt produce one effect and one `succeeded` |
| `ambiguous-response-payment` | a committed charge whose response was lost recovers to Paid on reload, with no duplicate |
| `server-authoritative-amount` | crafted or tampered amount fields prepare nothing; a price changed after render blocks, then prepares at the new amount |
| `custom-final-amount-payment` | an owner-authored total is prepared, confirmed and charged at exactly that amount |
| `checkout-default-amount` | session detail and quick checkout prefill the same reference and name its source |
| `quick-checkout-payment` | the iPad journey from dashboard to persisted Paid |

The lane is the browser half of the proof. The database half is in `tests/db/`: `card-replacement-atomicity`,
`active-card-per-mode`, `card-change-notification`, `card-change-notification-orchestration`,
`quick-checkout-eligibility` and `appointment-settlement`.

## 7. Lifecycle state

- **Card-on-file with live/test isolation is in production use**; the measured values behind that state are in the
  canonical record ([`current-state.md` § 7. Payments and Stripe](../../docs/production/current-state.md#7-payments-and-stripe)).
- **Public-booking card collection is off and unwired**, and **deposits, packages and partial payments are not built**
  (same section).
- Charge, refund, fee-hold and settlement states are on
  [Payments, Stripe and appointment settlement](stripe-payments-and-settlement.md). Nothing on this page changes them.
