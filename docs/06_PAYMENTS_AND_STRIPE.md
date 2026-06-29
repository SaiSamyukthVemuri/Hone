# 06 Payments and Stripe

> **Status note (reconciled — supersedes stale detail below).** The **single** canonical charge executor is `lib/billing/session-payment-charge.ts` (`runSessionPaymentCharge`), which handles session payments **and** the late-cancellation / no-show **fee** charges on the canonical `payment_charge_attempts` ledger. The legacy `lib/billing/manual-fee-charge.ts` executor was **deleted in PR #218**; fee unification onto `payment_charge_attempts` is **complete (PR #196, migration 0083)**. `scripts/check-stripe-gates.mjs` pins **exactly one** `paymentIntents.create` (`session-payment-charge.ts`) and **one** `refunds.create` (`lib/billing/payment-refund.ts`); `charges.create` / `checkout.sessions` are **0**. Payment-outcome zero-row detection was added in PR #263. **Live payments remain disabled; controlled live-payment enablement has not started.** Sections below that still describe a separate `manual_fee_charge_attempts` runtime as the active charge path are retained as historical design detail; where they conflict with this note, **this note is authoritative.**

## 1. Current payment status

| Capability | State |
|---|---|
| Stripe Connect Express onboarding | **Production**, test mode |
| Card-on-file via SetupIntent on connected account | **Production**, test mode |
| Test-mode cancellation/no-show fee charge | **Production**, test mode — **unified onto `payment_charge_attempts`** (PR #196, migration 0083); the legacy `manual_fee_charge_attempts` runtime was removed in PR #218 (historical rows readable only) |
| Test-mode session payment charge end-to-end (prepare, run, status UX, completion-to-billing handoff) | **Production**, test mode on `payment_charge_attempts` (PRs #171-#174, #180, #181) |
| Receipts (session-payment test receipt email) | **Production**, test mode (PR #175); manual-fee charge notice still not built |
| Refunds (full-amount, reason-agnostic, `payment_charge_attempts`) | **Production**, test mode (PR #178) |
| Webhook reconciliation for `payment_charge_attempts` | **Production**, test mode (PR #179); live events hard-ignored at handler entry |
| Dispute handling | **Alert-only** (PR #179: `charge.dispute.created` fires a critical ops_alert); no automated response |
| Automatic charging | **Not built** |
| Batch charging | **Not built** |
| Public booking card-required flow | **Schema present (migration 0032), code dormant** |
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
2. **Code gate.** `inferStripeLivemode()` short-circuits the canonical executor `lib/billing/session-payment-charge.ts:runSessionPaymentCharge` (session payments + fees) to `live_mode_blocked` before any Stripe call when the env is live. (The legacy `lib/billing/manual-fee-charge.ts` was deleted in PR #218.)
3. **DB CHECK.** `payment_charge_attempts_livemode_false_check` pins `stripe_livemode=false` on the canonical `payment_charge_attempts` ledger (session-payment and fee charges). A row cannot persist `true` until a deliberate migration drops or replaces the constraint.

## 4. Card-on-file flow (portal SetupIntent)

Gating order (PR #158 clarifies what the client sees in each state; PR #170 adds the current-version branch):

1. Studio has no active `card_authorization` template → portal shows `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."` No Add card surface.
2. Template exists; client has NOT signed → portal shows the unsigned template in "Review and sign forms" AND a calm placeholder in the card section: `"Card authorization needed before adding a card."` with a `Review card authorization` deep-link to the signing form. No Add card surface.
3. **(PR #170)** Template exists; client signed an older version → portal shows the live template in "Review and sign forms" (the unsigned-templates filter special-cases card_authorization re-signs) AND a dedicated `"Card authorization was updated"` block in Needs you with explicit re-sign copy and a `Review updated authorization` deep-link. SetupIntent action refuses with `"The card-on-file authorization was updated. Please review and sign the new version before adding a card."` until re-signed.
4. Template signed at current version; no active card → portal shows `"You have signed card authorization. You can now add a card on file. No charge will be made when you add a card."` plus the Add card form.
5. Active card → portal shows the read-only card summary plus Replace card. If authorization is out of date (PR #170), an inline `"Authorization needs re-signing"` warning sits next to the card; Replace card and any future live charge are gated until the client re-signs.

The practitioner-side `PaymentMethodCard` on the client profile mirrors the same five states with practitioner-actionable copy so Chloe can read out exactly what to ask the client to do next. The new branches added by PR #170 are `AuthorizationOutOfDateBlock` (no active card) and `AuthorizationOutOfDateWarning` (alongside an active card).

The shared helper `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` is the single source of truth for "is the signature current?". It compares `client_consent_signatures.template_version` (snapshot from migration 0057) to the live template's current `version`. The same helper is used by `createCardSetupIntentAction`; the `lib/billing/manual-fee-eligibility.ts` helper performs the same comparison inline; the PR #172 session payment eligibility helper `lib/billing/session-payment-eligibility.ts:getSessionPaymentEligibility` calls the same helper directly. See [docs/05 §Current-version signature gate (PR #170)](./05_CONSENT_AND_FORMS.md#current-version-signature-gate-pr-170).

## 4b. Session payment prepare flow (PR #172, test mode only)

Practitioner-only. Writes one `public.payment_charge_attempts` row with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`. NO Stripe call. NO PaymentIntent. NO charge. NO refund. NO webhook. NO SMS / email. Execution (the `runManualFeeCharge` counterpart that calls `paymentIntents.create`) is deferred to a separate PR.

```
practitioner opens /clients/[id]/sessions/[sessionId]
  -> SessionPaymentPrepareCard renders one of three states:
       blocked            -> show practitioner-facing blocking reasons
       existing_attempt   -> show existing payment_charge_attempts row
       ready              -> show form: amount + internal note + Prepare button
  -> Prepare button:
       prepareSessionPaymentChargeAction (server action)
         getCurrentPractitionerWithStudio() -> studio_id, practitioner_id
         parse amount_dollars to amount_cents (> 0 AND <= 200000)
         require internal_note (1..1000 chars)
         getSessionPaymentEligibility({ studioId, sessionId })
           gates (each blocks with a practitioner-facing message):
             1. session exists in this studio
             2. sessions.appointment_id IS NOT NULL
                AND appointments.status='completed'
                AND sessions.started_at IS NOT NULL
             3. active client_payment_methods row for (studio, client, livemode)
             4. getCardAuthorizationStatus = signed_current (PR #170)
             5. studio_payment_settings: account_status='enabled', livemode=false
             6. no existing active payment_charge_attempts row for
                (studio, session, charge_reason='session_payment')
         INSERT payment_charge_attempts row with the full lineage from
           the eligibility result (client_payment_method_id,
           card_authorization_signature_id, stripe_account_id,
           stripe_customer_id, stripe_payment_method_id stamped from
           the active card row).
         catch 23505 unique violation -> friendly duplicate message
           (partial unique payment_charge_attempts_active_session
            _payment_uniq is the structural backstop).
         revalidatePath(`/clients/${clientId}/sessions/${sessionId}`)
       return { ok: true; attemptId } | { ok: false; error; blockingReasons? }
```

What the row carries vs leaves null:

| Field | Value |
|---|---|
| `studio_id` | server-resolved from practitioner session |
| `charge_reason` | `'session_payment'` |
| `client_id` | from eligibility (not form) |
| `appointment_id` | stamped when session is appointment-linked (always in v1 chargeability proxy) |
| `session_id` | from URL path; required by `reason_shape_check` |
| `created_by_practitioner_id` | server-resolved |
| `amount_cents` | practitioner-confirmed; bounded `> 0 AND <= 200000` |
| `currency` | `'cad'` |
| `status` | `'ready'` |
| `client_payment_method_id` | from active card row |
| `card_authorization_signature_id` | from `signed_current` |
| `stripe_account_id` | from active card row |
| `stripe_customer_id` | from active card row |
| `stripe_payment_method_id` | from active card row |
| `stripe_livemode` | `false` (explicit; CHECK guarantees it) |
| `internal_note` | required form field |
| `stripe_payment_intent_id` | **null** (future execution PR) |
| `stripe_charge_id` | **null** (future execution PR) |
| `charged_at` | **null** (future execution PR) |
| `failed_at` | **null** (future execution PR) |

The prepare card explicitly does NOT render any "Pay now" or "Charge card" affordance. The disclaimer reads `"This prepares a test-mode payment record. It does not charge the client."` Three structural dormancy guards remain intact (key gate / code gate / DB CHECK) plus a fourth from PR #171 (`payment_charge_attempts_livemode_false_check`). The legacy `manual_fee_charge_attempts` runtime is byte-for-byte untouched.

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

## 4c. Session payment refund flow (PR #178, test mode only)

After a `succeeded` row exists on `public.payment_charge_attempts` (PR #173 charge path), a practitioner may issue a test-mode refund. The path is reason-agnostic: today only `session_payment` rows reach `succeeded`, but the same helper covers future `late_cancellation_fee` and `no_show_fee` rows without code change.

- **Helper:** `lib/billing/payment-refund.ts:refundPaymentChargeAttempt`. Single allowlisted `refunds.create` call site in the runtime tree (gate-enforced via `scripts/check-stripe-gates.mjs`).
- **Action:** `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts:refundPaymentChargeAttemptAction`. Accepts `attempt_id` + optional `internal_note` + `session_id` / `client_id` for revalidate; never accepts a browser-supplied amount.
- **UI:** `RefundSubPanel` inside `SucceededPanel` only (`components/session-payment-prepare-card.tsx`). Two-click confirm with the amount in the second button. Reads `refund_status` from the persisted row so the post-refund state survives refresh.
- **Schema:** migration 0078 adds nine nullable refund columns to `public.payment_charge_attempts` (`refund_status`, `refund_amount_cents`, `refunded_at`, `stripe_refund_id`, `refund_failure_code`, `refund_failure_message_safe`, `refund_internal_note`, `refund_idempotency_key`, `refund_initiated_by_practitioner_id`), 5 CHECK constraints, 1 FK, 2 partial uniques, 1 partial index.

Triple dormancy guard (mirrors PR #173 charge path):
1. `inferStripeLivemode()` short-circuit at function entry. Live env → `outcome:"live_mode_blocked"` before any DB / Stripe call.
2. Row-level CHECK `payment_charge_attempts_livemode_false_check` (the charge attempt row itself cannot be live-mode).
3. Conditional UPDATE claim predicate: `status='succeeded' AND stripe_livemode=false AND (refund_status IS NULL OR refund_status='failed')`. The claim is the only place that flips null/failed → `pending_stripe`.

Idempotency:
- Deterministic key shape: `hone:payment_refund:<attemptId>:v1`.
- Partial-unique `payment_charge_attempts_refund_idempotency_uniq` is the DB-level backstop.
- Network-retry produces the same key; Stripe's 24-hour replay returns the same Refund object.

Stripe call shape:
```ts
stripe.refunds.create(
  {
    charge: attempt.stripe_charge_id,
    amount: refundAmountCents,                  // v1: equals amount_cents
    metadata: {
      hone_payment_charge_attempt_id,
      hone_studio_id,
      hone_client_id,
      hone_charge_reason,                        // session_payment / late_cancellation_fee / no_show_fee
      hone_environment: "test",
    },
  },
  {
    stripeAccount: attempt.stripe_account_id,   // Connect direct-charge mode
    idempotencyKey,                              // hone:payment_refund:<attemptId>:v1
  },
);
```

No `application_fee_amount`. No `reverse_transfer`. No PaymentIntent / SetupIntent create. No charge create.

Outcomes:
- **succeeded** → `refund_status='succeeded'`, `stripe_refund_id`, `refunded_at`. UI shows "Test refund succeeded".
- **Stripe terminal error** → `refund_status='failed'`, sanitised `refund_failure_code` + `refund_failure_message_safe`. UI shows "Test refund failed" with the safe message + code. May be retried.
- **Unknown outcome (network)** → row stays `pending_stripe`; critical `payment_refund_stripe_unknown_outcome` ops_alert fires with the idempotency key. Operator decides whether to re-query Stripe.

What this flow does NOT do (v1):
- No live mode.
- No automatic refund trigger. Manual practitioner click only.
- No partial refund. Full amount only (the schema's `<= amount_cents` CHECK leaves room for a future partial-refund PR without migration).
- No multiple refunds per attempt (partial-unique on `stripe_refund_id`).
- Webhook handling lives in PR #179 (§4d), not here: full out-of-band Stripe-dashboard refunds ARE reconciled by the `charge.refunded` handler; partial refunds fire a critical ops_alert and leave the row alone.
- Dispute (`charge.dispute.created`) handling is alert-only via PR #179 (§4d); this refund flow itself does nothing with disputes.
- No refund receipt email. (May land later as a reason-agnostic mirror of PR #175.)
- No SMS.
- No client-portal refund surface.
- No `manual_fee_charge_attempts` touch. The dormant 0032 `stripe_refunds` / `stripe_refund_attempts` tables stay dormant; PR #178 ships refund state ON `payment_charge_attempts` directly.

## 4d. Webhook reconciliation for payment_charge_attempts (PR #179, test mode only)

After a charge or refund action runs, the webhook receives the corresponding Stripe event and reconciles state onto the `payment_charge_attempts` row. PR #179 is a one-way mirror: Stripe says X, Hone reflects X if safe; otherwise Hone alerts and leaves the row alone.

- **Module:** `lib/billing/payment-webhook-reconciliation.ts`. Four handlers exported: `handlePaymentIntentSucceeded`, `handlePaymentIntentPaymentFailed`, `handleChargeRefunded`, `handleChargeDisputeCreated`.
- **Dispatched from:** `app/api/stripe/webhook/route.ts` (extended `handleStripeEvent` switch).
- **Idempotency:** existing `stripe_events` ledger from migration 0032 + `claim_stripe_event` RPC. No new ledger needed.
- **Live-mode dormancy guard:** every handler calls `shouldIgnoreLiveModeEvent` first. `event.livemode === true` -> warning ops_alert + return without DB write.
- **Row lookup order:** canonical metadata `hone_payment_charge_attempt_id` -> legacy `hone_session_payment_charge_attempt_id` (PR #173 backward compat) -> fallback by `stripe_payment_intent_id` (PI events) or `stripe_charge_id` (Charge events).
- **Metadata consistency:** `hone_studio_id`, `hone_client_id`, `hone_charge_reason` are checked against the resolved row. Mismatch -> critical `stripe_webhook_metadata_mismatch` ops_alert + NO mutation.

### Event matrix

| Event | When local row is `ready`/`pending_stripe` | When local row already in target state | Mismatch handling |
| --- | --- | --- | --- |
| `payment_intent.succeeded` | Flip to `succeeded`; stamp PI id, Charge id, `charged_at`; clear failure fields. | Idempotent; may stamp missing charge id only. | Local `failed/cancelled/blocked` -> critical `payment_intent_succeeded_local_terminal_mismatch`. No row -> warning `payment_intent_succeeded_no_match`. |
| `payment_intent.payment_failed` | Flip to `failed`; stamp sanitised code + message + `failed_at`. | Idempotent; no field refresh. | Local `succeeded` -> critical `payment_intent_failed_after_local_succeeded`. Local `cancelled/blocked` -> critical `payment_intent_failed_local_terminal_mismatch`. |
| `charge.refunded` (FULL) | `pending_stripe` -> `succeeded` with refund id + `refunded_at`. Out-of-band null/failed -> `succeeded` + warning `charge_refunded_out_of_band_reconciled`. | Idempotent; may stamp missing refund id only. | Partial refund (`amount_refunded < amount`) -> critical `charge_refunded_partial_out_of_band`, NO mutation. |
| `charge.dispute.created` | No mutation. | (n/a) | Critical `payment_charge_dispute_created` with `attempt_id`, `stripe_charge_id`, `stripe_dispute_id`, `amount`, `currency`, `reason`, `status`. |

### What this flow does NOT do (v1)

- No new Stripe SDK call. The reconciliation module does not import `getStripe`; it reads the event payload only.
- No live mode (live-mode events ignored at handler entry).
- No automatic dispute response. Disputes record an ops_alert; operators handle via Stripe Dashboard.
- No automatic refund. Practitioner click via PR #178 is still the only way to issue a Hone refund; webhook reconciles existing Stripe-side refunds.
- No partial-refund row representation. The v1 `payment_charge_attempts` schema is full-refund-only; partials fire critical ops_alerts and leave the row alone.
- No SMS, no email, no client-portal mutation.
- No `manual_fee_charge_attempts` touch. The legacy fee runtime still has no webhook reconciliation.
- No new migration. The existing `stripe_events` table + columns from migrations 0073-0078 cover every state PR #179 writes.

### Zero-row outcome detection (PR #263)

Every payment-OUTCOME write — the charge executor's `writeSucceededOutcome`/`writeFailedOutcome` (`lib/billing/session-payment-charge.ts`), the refund helper's success + terminal-failure writes (`lib/billing/payment-refund.ts`), and the four reconcile UPDATEs above — is a status-conditional `.update().eq(...)`. Each now appends `.select("id")` and treats a ZERO-row result (the row left the guarded state between the read and the write, e.g. a concurrent action/webhook race) as an explicit failure: a structured non-PII ops_alert (`*_zero_rows` / `*_write_failed`, carrying safe ids + status enums only) and, for the webhook handlers, a `zeroRowNoMutation` return instead of falsely claiming a reconcile (the out-of-band "reconciled" alert is now gated behind rows>0). A zero-row outcome is never silently treated as success. App-layer only — no new migration, dependency, Stripe call, or live-mode change. Pinned by `tests/lib/billing/payment-outcome-zero-row.test.ts`.

### Authoritative success persistence (PR #281)

**A session-payment charge may only return a NORMAL `succeeded` outcome when BOTH are true: Stripe reported the PaymentIntent as `succeeded` AND Hone durably persisted that success on the local `payment_charge_attempts` ledger row.** Before PR #281, `writeSucceededOutcome` returned `void`, so the caller (`runSessionPaymentCharge`'s create/confirm path **and** `reconcileExistingPaymentIntent`) reported a clean `ok:true, outcome:"succeeded"` even when the local success write hit a DB error or affected zero rows — a real-money / unstamped-ledger split reported to the practitioner as fully done.

PR #281 makes success authoritative without a migration, a new public status, or any live-payment change:

- `writeSucceededOutcome` now returns a structured `SuccessPersistenceResult` = `{ persisted: true } | { persisted: false; reason: "db_error" | "zero_rows" }`.
- **Stripe success + DB write error** → critical ops_alert `session_payment_succeeded_write_failed` (PR #263 previously only logged this to stderr; it is now a critical alert) → helper returns `{persisted:false, reason:"db_error"}`. The row stays `pending_stripe`.
- **Stripe success + zero-row update** → critical ops_alert `session_payment_succeeded_write_zero_rows` (kept) → helper returns `{persisted:false, reason:"zero_rows"}`.
- **Stripe success + DB write proven (one row)** → helper returns `{persisted:true}`.
- Both success callers branch: `persisted:true` → existing `ok:true, outcome:"succeeded"`; `persisted:false` → `ok:false, outcome:"needs_manual_review"` (an existing, indeterminate, **non-success** outcome) with the safe message *"Stripe reported the payment as succeeded, but Hone could not confirm the local payment record. Review the payment in Stripe and Hone before retrying."* plus non-sensitive reconciliation ids (`stripePaymentIntentId`, `attemptId`) — no card data, raw Stripe payload, secrets, or sensitive client data.
- **No double-charge:** the `persisted:false` branch returns immediately and issues no retry; the deterministic idempotency key + Stripe's 24h replay already guard the retry path.
- **Webhook reconciliation remains the backstop:** the `payment_intent.succeeded` handler (§4d) still flips a `pending_stripe` row to `succeeded`, so a transient DB-error split is eventually reconciled even though the synchronous result was honestly indeterminate.

### Reconciliation + live-payment readiness (PR #282)

PR #282 is **readiness + reconciliation only — NOT live-payment enablement.** It adds the authoritative post-#281 **reconciliation + controlled live-payment runbook** in [docs/16 §17](./16_LIVE_PAYMENTS_READINESS.md#17-payment-reconciliation--controlled-live-payment-readiness-runbook-pr-282): a Before/During/After first-live-payment checklist, the forbidden actions (no `STRIPE_ALLOW_LIVE_MODE=true`, no live keys, no live charges, no broad card-required flows), a rollback plan, and a set of **read-only (SELECT-only) reconciliation SQL queries** over `payment_charge_attempts`, `ops_alerts`, and `stripe_events` (stuck `pending_stripe`; Stripe-PI-present-but-local-not-succeeded; the #281 `session_payment_succeeded_write_*` criticals; refund-review alerts; unprocessed/unmapped webhook events; recent payment criticals). Operators already see these alerts on the admin **Ops alerts** page (`/admin/ops-alerts`). **No migration, no runtime/behavior change, no new UI, no executable prod-connecting script.** **Live payments remain disabled; controlled live-payment enablement has not started.**

App-layer only — no migration, no schema/env change, no new Stripe call, exactly one `paymentIntents.create` / one `refunds.create` preserved, live-mode block unchanged. **Live payments remain disabled; controlled live-payment enablement has not started.** Pinned by `tests/lib/billing/payment-success-persistence.test.ts` (+ the new DB-error critical-alert assertion in `tests/lib/billing/payment-outcome-zero-row.test.ts`).

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
| Every other event class | Recorded with `ignoredInPhase1: true` summary, no side effect. Fee charges now produce `payment_charge_attempts` rows (PR #196), so their PaymentIntent events ARE reconciled by the reason-agnostic PR #179 handlers (matched on `hone_charge_reason` metadata); the synchronous action also records the result (see §6). |

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

## 7. Test-mode cancellation/no-show fee charge (PR #146; unified PR #196/#218)

> **Updated (PR #196/#218):** `lib/billing/manual-fee-charge.ts:runManualFeeCharge` was **removed**. `chargeManualFeeAttemptAction` now executes through the unified `lib/billing/session-payment-charge.ts:runSessionPaymentCharge` against `payment_charge_attempts` (`charge_reason` = `no_show_fee` / `late_cancellation_fee`), via the `claim_session_payment_charge_attempt` RPC (reasons widened in migration 0083). The execution narrative below describes the original manual-fee design and is retained for history.

Action: `chargeManualFeeAttemptAction` in `app/(app)/calendar/[id]/manual-fee-actions.ts`. Helper (historical): `lib/billing/manual-fee-charge.ts:runManualFeeCharge` — **removed in PR #218**; see the note above.

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
  Exactly ONE occurrence is allowed today (PR #196/#218 unified executor):
    lib/billing/session-payment-charge.ts   (test-mode; session payments
                                              AND late-cancel/no-show fees)

  It is behind:
    - practitioner auth
    - reason-appropriate eligibility recheck (getSessionPaymentEligibility
      for session payments; getManualFeeChargeEligibility for fees)
    - lineage recheck via loadCardAndVerifyLineage
    - claim_session_payment_charge_attempt RPC (FOR UPDATE, conditional
      UPDATE, idempotency key stamp in one transaction)
    - deterministic idempotency key
    - connected-account context { stripeAccount }
    - inferStripeLivemode() test-mode gate
    - payment_charge_attempts_livemode_false_check DB CHECK

  (The legacy lib/billing/manual-fee-charge.ts call site was deleted in
  PR #218.) Any new paymentIntents.create occurrence is high-risk and
  must be explicitly reviewed.
```

The session-payment occurrence (PR #173) sits behind the equivalent stack on `payment_charge_attempts`: practitioner auth, eligibility recheck, atomic claim RPC, deterministic idempotency key, `{ stripeAccount }` context, livemode inference gate, and the `payment_charge_attempts_livemode_false_check` DB CHECK.

**Do not say** `paymentIntents.create` should be zero. `scripts/check-stripe-gates.mjs` pins **exactly 1** occurrence in the single allowlisted file above (`lib/billing/session-payment-charge.ts`); it is a legitimate test-mode path and deleting it would break session-payment + fee charging. `refunds.create` is pinned at exactly 1 (`lib/billing/payment-refund.ts`, PR #178); `charges.create` and `checkout.sessions` at 0; `STRIPE_ALLOW_LIVE_MODE=true` appears only as the error-message string in `lib/stripe/server.ts`.

## 9. Live charging requirements

When a live-mode PR is opened (it is not opened today), it must do all of the following. Cherry-picking is not safe.

1. **Lawyer review of consent + cancellation + card-authorization wording** under Ontario law (CASL / PIPEDA / PCI / contract enforceability).
2. **Receipt / charge-notice email.** Status: built in test mode for session payments (PR #175, `lib/email/templates/payment-receipt.ts`); fees ride the same unified `payment_charge_attempts` path (PR #196). Remaining for live: content/legal review of the template copy.
3. **Refund code path.** Status: built in test mode on `payment_charge_attempts` (PR #178; full-amount, reason-agnostic, atomic claim + idempotency). The dormant 0032 `stripe_refund_attempts` / `stripe_refunds` tables remain unused. Remaining for live: deliberate live enablement and a partial-refund decision.
4. **Webhook handlers** for `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.*`. Status: built reason-agnostic for `payment_charge_attempts` (PR #179, metadata-matched, claimed via `claim_stripe_event`); live events are hard-ignored at handler entry. Remaining for live: deliberately relax the livemode guard. (Fee unification is already done — fees ride `payment_charge_attempts` since PR #196 and inherit this reconciliation; the legacy `manual_fee_charge_attempts` runtime was removed in PR #218.)
5. **Strengthen pending reconciliation.** Replace the "trust Stripe idempotency within 60 minutes" path with `paymentIntents.search` by metadata before any retry. The Stripe idempotency window is 24 hours; live mode must never depend on that being long enough.
6. **Manual smoke against a live test charge** with refund.
7. **Deliberately replace `payment_charge_attempts_livemode_false_check`** (the canonical ledger CHECK) with the live-mode equivalent. The migration must be reviewed.
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
