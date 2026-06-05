# 06 Payments and Stripe

## 1. Current payment status

| Capability | State |
|---|---|
| Stripe Connect Express onboarding | **Production**, test mode |
| Card-on-file via SetupIntent on connected account | **Production**, test mode |
| Test-mode manual cancellation/no-show fee charge | **Production**, test mode |
| Automatic charging | **Not built** |
| Batch charging | **Not built** |
| Public booking card-required flow | **Schema present (migration 0032), code dormant** |
| Refunds | **Not built** |
| Receipts / charge-notice email | **Not built** |
| Dispute handling | **Not built** |
| Live mode | **Blocked** by three independent guards (see §3) |

## 2. Stripe Connect model

Studios onboard via **Stripe Connect Express**. Each studio gets a connected account on Stripe's side; `studio_payment_settings` stores the connected-account id and status. Cards are saved on the connected account (not on the platform); charges are direct charges on the connected account.

**Why direct charge instead of platform charges:**

- The pilot is one studio in one country; platform fees / tax handling are out of scope.
- The PCI burden stays on Stripe.
- The Hone side never sees a `customer` or `payment_method` on the platform; every Stripe call carries `{ stripeAccount }` to scope the request to the connected account.

**Why SetupIntent on the connected account:**

- Card-on-file is for future-use charging by the studio. The PaymentMethod must live on the connected account so the later PaymentIntent has access.
- Customers (`client_stripe_customers`) are per-`(client, studio, account, livemode)`.

## 3. Live-mode guards

Three independent guards stack. All three must be deliberately altered for live charging.

1. **Key gate.** `lib/stripe/server.ts:assertStripeKeyAllowed` refuses any `sk_live_*` secret unless `STRIPE_ALLOW_LIVE_MODE=true`. Vercel Preview / Development MUST use `sk_test_*` regardless of the flag.
2. **Code gate.** `inferStripeLivemode()` short-circuits `lib/billing/manual-fee-charge.ts:runManualFeeCharge` to `live_mode_blocked` before any Stripe call when the env is live.
3. **DB CHECK.** `manual_fee_charge_attempts.stripe_livemode` is CHECK-pinned to `false`. A row cannot persist `true` until a deliberate migration drops or replaces the constraint.

## 4. Card-on-file flow (portal SetupIntent)

Gating order (PR #158 clarifies what the client sees in each state):

1. Studio has no active `card_authorization` template → portal shows `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."` No Add card surface.
2. Template exists; client has NOT signed → portal shows the unsigned template in "Review and sign forms" AND a calm placeholder in the card section: `"Card authorization needed before adding a card."` with a `Review card authorization` deep-link to the signing form. No Add card surface.
3. Template signed; no active card → portal shows `"You have signed card authorization. You can now add a card on file. No charge will be made when you add a card."` plus the Add card form.
4. Active card → portal shows the read-only card summary plus Replace card.

The practitioner-side `PaymentMethodCard` on the client profile mirrors the same four states with practitioner-actionable copy so Chloe can read out exactly what to ask the client to do next.

```
client opens /portal -> "Add card" entry
  -> portal verifies a signed card_authorization signature exists
  -> createCardSetupIntentAction
       resolve portal session -> (studio_id, client_id)
       find or claim Stripe Customer mapping via client_stripe_customers
         (uses migration 0032 RPCs: create_or_claim_stripe_customer_provisioning,
          complete_stripe_customer_provisioning)
       create SetupIntent on connected account with metadata + off_session usage
       return { setupIntentId, clientSecret } to the browser
  -> PortalPaymentMethodForm
       Stripe Elements binds the card
       stripe.confirmCardSetup(clientSecret, { payment_method: { card } })
  -> Stripe webhook: setup_intent.succeeded
       handleSetupIntentSucceeded validates metadata + lineage
       INSERT into client_payment_methods with safe fields only:
         brand, last4, exp_month, exp_year,
         stripe_account_id, stripe_livemode, stripe_customer_id,
         stripe_payment_method_id, stripe_setup_intent_id,
         card_authorization_signature_id, status='active'
       webhook also pre-flips any prior active row to status='removed'
       partial unique (studio_id, client_id) WHERE status='active' enforces
         one-active-card-per-(studio,client)
```

The PAN and CVC never touch Hone's servers or DB. The `client_secret` is consumed by the portal browser code once and never persisted.

### Replace card (PR #151)

The same flow handles the Replace card path. When a client already has an active card on file:

- The portal "Your info" zone shows `PortalCardOnFileCard` with the read-only summary AND a "Replace card" button.
- Clicking Replace mounts the existing `PortalPaymentMethodForm` in `mode='replace'`; the server action does NOT branch on mode (it derives state from the DB).
- The same SetupIntent / webhook chain runs. The PR #135 `setup_intent.succeeded` handler:
  - SELECTs first against `(studio, client, account, mode, setup_intent_id)` for idempotency (short-circuits re-delivery).
  - UPDATEs any existing `status='active'` row for the `(studio, client)` pair to `status='removed'` with `removed_at = now()`.
  - INSERTs the new active row with the new `stripe_payment_method_id`, `stripe_setup_intent_id`, and the same `card_authorization_signature_id`.
  - The partial unique `(studio, client) WHERE status='active'` (migration 0058) is the structural backstop.

Result: exactly one active card per `(studio, client)`; the prior row stays as `status='removed'` (audit trail; never hard-deleted). No PaymentIntent, no charge, no refund, no live-mode change.

## 5. Webhook configuration

Endpoint: `/api/stripe/webhook` (route handler).

**Listens on the connected-account webhook**, not the platform webhook. This is the fix from an earlier issue where the original webhook was configured on the wrong account type. The signing secret must match the connected-account webhook's secret (`STRIPE_WEBHOOK_SECRET`).

Events handled:

| Event | Handler |
|---|---|
| `account.updated` | Sync connected-account status onto `studio_payment_settings` via `sync_studio_account_status` RPC. Preserves first-completion timestamp via coalesce. |
| `capability.updated` | Same handler as `account.updated`. |
| `setup_intent.succeeded` | Insert `client_payment_methods` row with safe metadata. See §4. |
| `setup_intent.setup_failed` | Record sanitized failure code on `stripe_events.payload_summary`. No DB write to `client_payment_methods`. |
| Every other event class | Recorded with `ignoredInPhase1: true` summary, no side effect. PaymentIntent events from the manual fee charge path are intentionally NOT handled by the webhook; the synchronous action records the result (see §6). |

Every event is claimed via `claim_stripe_event` (migration 0032 RPC) BEFORE any business logic, so a retried webhook delivery does not double-process.

## 6. Manual fee protection stack (PR #145)

`manual_fee_charge_attempts` (migration 0064) records one practitioner-prepared fee attempt per `(appointment, charge_type)` with full evidence FKs.

### Evidence gates

A row can reach `status='ready'` only when all six checks pass:

1. **Appointment status / type allowlist.** `cancelled → late_cancel`, `no_show → no_show`. Anything else blocks (PR #145 pre-merge fix replaced the asymmetric one-direction checks with a positive allowlist).
2. **Active card on file.** `client_payment_methods` row, `status='active'`, matching `(studio, client, livemode=false)`, non-null `card_authorization_signature_id`.
3. **Signed card authorization.** `client_consent_signatures` row scoped to same `(studio, client)`.
4. **Policy acknowledgement.** Most recent `appointment_policy_acknowledgements` row for the appointment.
5. **Fee amount.** `studios.<type>_fee_cents` non-NULL AND `> 0`. The eligibility helper blocks both NULL and 0 (PR #145 pre-merge fix added the `> 0` requirement; the DB CHECK still allows 0 for settings-clearing semantics, but a 0-cent attempt can never reach `ready`).
6. **No existing active attempt.** No row in `('ready', 'pending_stripe', 'succeeded')` for the same `(appointment, charge_type)`.

### Duplicate protection

Partial unique index `manual_fee_charge_attempts_active_per_appt_type` on `(appointment_id, charge_type) WHERE status IN ('ready', 'pending_stripe', 'succeeded')`. Catches the double-click and two-tab races.

### Internal note

Required, 1..1000 chars. The DB CHECK enforces the length range; the action enforces required.

### Timing classification

`timing_classification = 'practitioner_asserted'` for v1. Hone cannot mechanically decide "this cancellation crossed the late window" because `cancellation_policy_text` is free-form. The card UI shows: "Timing classification is manual for this version. Confirm this appointment qualifies under the policy before preparing the charge."

A future PR adding structured threshold settings (e.g. `studios.cancellation_window_hours`) can flip the value to `'system_derived'`. The column CHECK already allows that value.

## 7. Test-mode manual fee charge (PR #146)

Action: `chargeManualFeeAttemptAction` in `app/(app)/calendar/[id]/manual-fee-actions.ts`. Helper: `lib/billing/manual-fee-charge.ts:runManualFeeCharge`.

### Concurrency contract

```
1. Resolve practitioner + studio from session.
2. Re-run getManualFeeChargeEligibility server-side.
3. loadCardAndVerifyLineage re-checks card / customer / connected-account
     ids match the attempt row's snapshot.
4. claim_manual_fee_charge_attempt RPC:
     FOR UPDATE row lock
     ready -> pending_stripe atomically
     stamp stripe_idempotency_key = "hone:manual-fee:<attempt_id>:v1"
     return result code (claimed / already_pending / already_succeeded /
       not_ready / not_authorized / not_found)
5. stripe.paymentIntents.create({
     amount, currency,
     customer: card.stripe_customer_id,
     payment_method: card.stripe_payment_method_id,
     confirm: true,
     off_session: true,
     description: `Manual fee for appointment <id>`,
     metadata: { hone_studio_id, hone_appointment_id, hone_client_id,
                 hone_manual_fee_charge_attempt_id, hone_charge_type,
                 hone_environment: "test" },
   }, { stripeAccount: card.stripe_account_id, idempotencyKey });
6. On success: UPDATE attempt to succeeded with PI id, latest_charge,
   stripe_status, charged_at.
   On StripeError: UPDATE to failed with sanitized code + message + PI id.
   On unknown error AFTER claim: leave pending_stripe, return
     needs_manual_review (do not blind retry).
```

### Pending recovery

When the RPC returns `already_pending`:

| State | Action |
|---|---|
| `stripe_payment_intent_id` set | `paymentIntents.retrieve(id, undefined, { stripeAccount })`. Write `succeeded` / `failed` based on retrieved status. |
| `stripe_payment_intent_id` null AND claim age ≤ 60 min | Retry `paymentIntents.create` with the same deterministic idempotency key. Stripe's 24h idempotency window replays the prior response if it landed. |
| `stripe_payment_intent_id` null AND claim age > 60 min | Return `needs_manual_review`. Refuse to blindly retry past safe window even though Stripe's idempotency might technically still apply within 24h. |

### Authentication-required (off-session SCA)

`paymentIntents.create({ confirm: true, off_session: true })` can return a PI in `requires_action` status, or throw a `StripeCardError` with `code='authentication_required'`. Both paths are handled:

- The attempt is marked `failed` with the sanitized code and message.
- The practitioner sees: "The saved card requires customer authentication and could not be charged off-session in this test flow."
- The action does NOT auto-fall-back to an on-session flow. No client email is sent.

### Status machine (test-mode only)

| From | To | Path |
|---|---|---|
| `ready` | `pending_stripe` | RPC claim |
| `pending_stripe` | `succeeded` | Synchronous write or reconcile |
| `pending_stripe` | `failed` | Synchronous write or reconcile |
| `pending_stripe` | `pending_stripe` | Reconciliation no-op (`processing` or unknown error after claim) |
| `ready` | `cancelled` | `cancelManualFeeChargeAttemptAction` (no Stripe call) |
| `succeeded` | `succeeded` | Idempotent click; action short-circuits via `already_succeeded` |

Refused: `ready → succeeded/failed`, `failed → anything`, `cancelled → anything`, `blocked → anything`, `pending_stripe → cancelled`.

## 8. Stripe grep gates

Current expected values. The PR template (`.github/pull_request_template.md`, PR #147) reproduces these:

```
charges.create:
  Must be zero. Current policy is PaymentIntents only.

checkout.sessions:
  Must be zero unless an explicit Checkout PR.

refunds.create:
  Must be zero unless an explicit refund PR.

set_studio_require_card_on_file:
  Must be zero unless an explicit card-required booking PR.

STRIPE_ALLOW_LIVE_MODE=true:
  Must be zero unless an explicit live-mode PR.

paymentIntents.create:
  Exactly one existing occurrence is allowed today:
    lib/billing/manual-fee-charge.ts

  That occurrence is allowed only because it is the test-mode manual fee
  charge path and is behind:
    - practitioner auth
    - evidence recheck via getManualFeeChargeEligibility
    - lineage recheck via loadCardAndVerifyLineage
    - claim_manual_fee_charge_attempt RPC (FOR UPDATE, conditional
      UPDATE, idempotency key stamp in one transaction)
    - deterministic idempotency key hone:manual-fee:<attempt_id>:v1
    - connected-account context { stripeAccount }
    - inferStripeLivemode() test-mode gate
    - manual_fee_charge_attempts_livemode_false_check DB CHECK

  Any new paymentIntents.create occurrence is high-risk and must be
  explicitly reviewed.
```

**Do not say** `paymentIntents.create` should be zero. The one allowed occurrence is the legitimate test-mode manual fee path; deleting it would break the feature.

## 9. Live charging requirements

When a live-mode PR is opened (it is not opened today), it must do all of the following. Cherry-picking is not safe.

1. **Lawyer review of consent + cancellation + card-authorization wording** under Ontario law (CASL / PIPEDA / PCI / contract enforceability).
2. **Draft and add a receipt / charge-notice email template** that is sent on a successful charge. Include amount, last4, date, the studio's contact, and a way to dispute.
3. **Add a refund code path.** The 0032 backend has `stripe_refund_attempts` + `stripe_refunds` tables; a live PR must add the action that uses them, with the same atomic-claim + duplicate-protection pattern as the charge path.
4. **Add a live webhook handler** for `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.*`. Each handler must match on the `hone_manual_fee_charge_attempt_id` metadata, claim via `claim_stripe_event`, and update the matching attempt row.
5. **Strengthen pending reconciliation.** Replace the "trust Stripe idempotency within 60 minutes" path with `paymentIntents.search` by metadata before any retry. The Stripe idempotency window is 24 hours; live mode must never depend on that being long enough.
6. **Manual smoke against a live test charge** with refund.
7. **Deliberately replace `manual_fee_charge_attempts_livemode_false_check`** with the live-mode equivalent. The migration must be reviewed.
8. **Never enable auto-charge** in the same PR as live mode. Manual click stays manual.

## 10. Do-not-do section

- Do not call `charges.create`. Use PaymentIntents.
- Do not use `checkout.sessions`. Off-session direct charge only.
- Do not use platform customers / platform PaymentMethods. Every Stripe call carries `{ stripeAccount }`.
- Do not store card number, CVC, or `client_secret`. Hone reads brand/last4/expiry/Stripe ids only.
- Do not retry a stale `pending_stripe` attempt past the 60-minute reconciliation window without metadata-based PI discovery (not built today).
- Do not flip live mode without the full checklist in §9.
- Do not auto-charge in any code path. Manual click stays manual.

## 11. SQL recipes

```sql
-- Saved card for a client (active only)
select id, brand, last4, exp_month, exp_year, status,
       stripe_account_id, stripe_livemode,
       card_authorization_signature_id, added_via, added_at
  from public.client_payment_methods
 where studio_id = '<studio uuid>'
   and client_id = '<client uuid>'
 order by added_at desc;

-- Manual fee charge attempts for one appointment
select id, charge_type, status, amount_cents, currency,
       stripe_livemode, stripe_payment_intent_id, stripe_charge_id,
       stripe_idempotency_key, charged_at, failed_at,
       failure_code, failure_message,
       cancelled_at, cancelled_by_practitioner_id, cancelled_reason
  from public.manual_fee_charge_attempts
 where appointment_id = '<appointment uuid>'
 order by created_at desc;

-- Policy acknowledgement for an appointment
select id, action, acknowledged_at, policy_snapshot_hash
  from public.appointment_policy_acknowledgements
 where appointment_id = '<appointment uuid>'
 order by acknowledged_at desc;

-- Stripe events ledger (most recent)
select stripe_event_id, event_type, stripe_account_id, stripe_livemode,
       studio_id, processed_at, processing_error, payload_summary, created_at
  from public.stripe_events
 order by created_at desc
 limit 20;
```
