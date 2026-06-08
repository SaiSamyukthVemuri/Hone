# 16 Live payments readiness

**Status: NOT READY FOR LIVE PAYMENTS** (PR #168, 2026-06-08).

This document is a snapshot of the live-payments readiness review. It exists because Chloe asked, verbatim: *"We need a way to start taking live cards now, not just test. No more cash. We have 3 clients signed up already. We need to get everything live."*

The honest answer right now is **no, we cannot safely take live money yet**. This document explains why, what is already production-safe, and exactly which future PRs unblock live card setup and live manual fees. The audit ran read-only against production data; no code or configuration was changed.

---

## 1. Executive summary

The Stripe charge backend has been installed in production since PR #146 (migration 0032) and PR #135 (migration onwards). The system is **structurally dormant** behind three independent guards (described in §3), so no live money has ever moved through Hone. The dormancy is intentional and survives every shipped PR.

**Three categories of readiness, three answers:**

| Category | Status |
|---|---|
| Live card setup (SetupIntent only, no money movement) | **Not ready.** 7 client-facing copy strings advertise "Test mode only" and would be misleading in live mode; the `card_authorization` consent template Willow has on file is titled "test" (not a reviewed legal document); both studios have `stripe_payouts_enabled=false`. |
| Live manual fees (cancellation + no-show charging) | **Not ready.** Every blocker above plus: no receipt path, no refund code path, no operator runbook for stuck or duplicate charges, no test coverage on the charge path, `manual_fee_charge_attempts.stripe_livemode = false` CHECK constraint blocks live writes structurally. |
| Stripe Connect onboarding + status sync | **Ready.** Both studios have a connected test-mode account with `charges_enabled=true` and `details_submitted=true`. The webhook handler updates these flags atomically via the `sync_studio_account_status` RPC; idempotency is enforced via the `stripe_events` table. |

Estimated effort to unblock live card setup: **1 small PR** (#169, UI copy + template review). Estimated effort to unblock live manual fees: **6 to 8 sequential PRs** plus a separate legal-review cycle.

This PR (#168) does not enable live payments. It only documents the state and adds guardrail tests so a future PR cannot accidentally flip live mode without acknowledging this checklist.

---

## 2. Current state (production, 2026-06-08)

### 2.1 Studio payment settings

From a read-only query against production:

```text
studio_payment_settings
  studio_id                       9d37c51a-6237-42ef-b9d3-28a567c2bfa8 (Willow)
  stripe_account_id               acct_1Tb59mFJ6u7ZVoZ6
  stripe_account_status           enabled
  stripe_charges_enabled          true
  stripe_payouts_enabled          FALSE       <- blocker for actual money movement
  stripe_onboarding_completed_at  2026-05-25 20:36:33+00
  stripe_livemode                 false       <- test mode
  require_card_on_file            false
  default_charge_currency         cad
  stripe_application_fee_bps      null

  studio_id                       38cb3a8b-f0f1-409e-9ea4-ffa4b95cb4c6 (second studio)
  stripe_account_id               acct_1Tb9QtFFilRr6Xng
  stripe_account_status           enabled
  stripe_charges_enabled          true
  stripe_payouts_enabled          FALSE
  stripe_onboarding_completed_at  2026-06-05 01:48:00+00
  stripe_livemode                 false
  require_card_on_file            false
  default_charge_currency         cad
  stripe_application_fee_bps      null
```

Observations:
- Both studios completed Stripe Connect onboarding on test mode. Neither has a live account.
- `stripe_charges_enabled=true` means Stripe will accept PaymentIntent creation on the test account, but `stripe_payouts_enabled=false` means even successful charges would not flow to a bank account. Payouts are blocked because Stripe is missing a verified bank account or one of the verification documents.
- `stripe_application_fee_bps=null` means Hone takes a 0% platform fee on each charge. If Hone is meant to take a platform fee, this must be set before live charging or the policy will silently be 0%.
- `require_card_on_file=false` means appointment booking does not require a card; this matches the current product surface.

### 2.2 Card authorization consent template

From a read-only query against production:

```text
form_type                       card_authorization
studio_id                       9d37c51a-... (Willow)
title                           "test"                <- not a reviewed legal document
status                          active
is_live                         true                   (PR #167 backfill)
body                            <unread; treated as test placeholder>
```

The template is currently live in the client portal because PR #167's backfill set `is_live = (status = 'active')` to preserve pre-migration behavior. Before any live charge, the body must be reviewed by Chloe and legal counsel for Ontario law (CASL, PIPEDA, PCI obligations, contract enforceability), and the title must change from "test" to its real product name.

### 2.3 paymentIntents.create call sites

```text
$ grep -rn 'paymentIntents\.create' app/ lib/ --include='*.ts' --include='*.tsx'
lib/billing/manual-fee-charge.ts:723:    pi = await stripe.paymentIntents.create(
```

Exactly one occurrence. Allowlisted by `scripts/check-stripe-gates.mjs`. This is the only path that could ever cause money to move.

### 2.4 "Test mode only" UI copy

Seven client-facing or practitioner-facing strings advertise test mode. Every one of them would be factually wrong if STRIPE_ALLOW_LIVE_MODE were enabled tomorrow:

| File | Line | Copy |
|---|---|---|
| `app/portal/PortalPaymentMethodForm.tsx` | 72 | `"Your current card will be replaced after the new card is saved. No charge will be made. Test mode only."` |
| `app/portal/PortalCardOnFileCard.tsx` | 64 | `Test mode only. No live card will be charged.` |
| `app/(app)/settings/payments/PaymentsSettings.tsx` | 166 | `Test mode: not collecting payments from clients yet` |
| `app/(app)/settings/payments/PaymentsSettings.tsx` | 455 | `okLabel="Test mode only"` |
| `app/(app)/settings/payments/PaymentsSettings.tsx` | 456 | `notYetLabel="Test mode only (live mode is not enabled)"` |
| `app/(app)/calendar/[id]/ManualFeeChargeCard.tsx` | 114 | `Test mode only. No live card will be charged.` |
| `app/(app)/calendar/[id]/ManualFeeChargeCard.tsx` | 435 | `Test mode only. No live card will be charged.` |

A future PR that enables live mode must remove or conditionalize every one of these strings before the flip. The guardrail test in this PR pins the count + locations so a refactor cannot quietly drop or duplicate any of them.

---

## 3. What is test-mode-only by design

The system has three independent, defense-in-depth guards that together prevent any live charge today. All three must be deliberately changed to enable live money.

### Guard 1: Stripe key gate (`lib/stripe/server.ts`)

```ts
export function assertStripeKeyAllowed(raw: string): void {
  const isTestKey = raw.startsWith("sk_test_");
  const isLiveKey = raw.startsWith("sk_live_");
  if (!isTestKey && !isLiveKey) {
    throw new Error("Invalid Stripe secret key format.");
  }
  if (isLiveKey && process.env.STRIPE_ALLOW_LIVE_MODE !== "true") {
    throw new Error(
      "Stripe live mode is disabled for Phase 1. " +
        "Set STRIPE_ALLOW_LIVE_MODE=true behind a separate review before using sk_live_.",
    );
  }
  ...
}
```

A live key (sk_live_*) throws unless STRIPE_ALLOW_LIVE_MODE=true is set in the environment. The flag is unset in production today (verified in `.env.local.example` line 153). The literal string `STRIPE_ALLOW_LIVE_MODE=true` appears in exactly one runtime file (`lib/stripe/server.ts`); `scripts/check-stripe-gates.mjs` enforces that.

### Guard 2: Manual fee live-mode early return (`lib/billing/manual-fee-charge.ts`)

```ts
if (inferStripeLivemode() === true) {
  return {
    ok: false,
    outcome: "live_mode_blocked",
    message: LIVE_MODE_BLOCKED_MESSAGE,
  };
}
```

`inferStripeLivemode()` reads `process.env.STRIPE_SECRET_KEY` and returns `true` if it starts with `sk_live_`. If the operator somehow got past Guard 1 and loaded a live key, this guard still short-circuits the only `paymentIntents.create` call in the codebase.

### Guard 3: Database CHECK constraint (migration 0065)

```sql
ALTER TABLE public.manual_fee_charge_attempts
  ADD CONSTRAINT manual_fee_charge_attempts_livemode_false_check
    CHECK (stripe_livemode = false);
```

Even if Guards 1 and 2 were both bypassed, the database refuses to record a live-mode charge attempt. A live row literally cannot be written. This guarantee survives a forgotten env var, a misconfigured Vercel deploy, or a rushed PR.

### Lineage check (eligibility helper)

The `getManualFeeChargeEligibility` helper in `lib/billing/manual-fee-eligibility.ts` rejects any client_payment_methods row with `stripe_livemode != false`. So even if the card lookup found a live card on a live account, the manual fee path would refuse to charge it.

---

## 4. What is already production-safe

The following sub-systems are correctly built, hardened, and ready to handle real client traffic when the live-mode guards are deliberately flipped. None of these need additional work for Phase 1 live card setup.

### 4.1 Stripe Connect onboarding + status sync

- Express accounts created via in-app `/settings/payments` flow (PR #119, PR #135 onwards).
- Connected-account webhook endpoint configured at `/api/stripe/webhook` (deliberately not the platform webhook).
- `account.updated` and `capability.updated` events flip `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_account_status` atomically via the `sync_studio_account_status` RPC.
- Idempotency enforced via `stripe_events` table + `claim_stripe_event` / `mark_stripe_event_processed` RPC pair (migration 0032).
- Per-studio currency pinned to CAD (CHECK constraint).

### 4.2 Card-on-file SetupIntent flow

- `createCardSetupIntentAction` in `app/portal/payment-method-actions.ts` is server-only and gated on portal session + signed card_authorization + active studio Stripe account.
- Atomic webhook handler `setup_intent.succeeded` (lines 364 to 602 of webhook route):
  - Reads metadata (`hone_studio_id`, `hone_client_id`, `hone_card_authorization_signature_id`); all three required or the event is recorded as ignored.
  - Idempotent SELECT on `(studio, client, account, livemode, setup_intent_id)` short-circuits a duplicate delivery without pre-flipping the active row.
  - Atomic pre-flip of any existing `status='active'` row to `status='removed'` (with `removed_at=now()`), then INSERT new active row (PR #135).
  - INSERT unique-constraint failure (23505) is treated as idempotent success.
- Partial unique index `client_payment_methods_one_active_per_pair` (`(studio_id, client_id) WHERE status='active'`) is the structural backstop against two-active-cards regression.
- Replace card flow (PR #151) reuses the same SetupIntent path; no separate code branch can leak duplicate cards.

### 4.3 Manual fee charge correctness (test mode)

- Single allowlisted `paymentIntents.create` call site at `lib/billing/manual-fee-charge.ts:723`.
- Deterministic idempotency key: `hone:manual-fee:${attemptId}:v1`. Same attempt always produces the same key.
- Three-layer duplicate protection:
  1. Application: `claim_manual_fee_charge_attempt` RPC takes a row-level lock and transitions `ready -> pending_stripe` in one transaction, stamping the idempotency key.
  2. Stripe: `paymentIntents.create` is called with the deterministic key; Stripe replays the prior response within its 24h window.
  3. Database: partial unique index `manual_fee_charge_attempts_idempotency_uniq` on `(stripe_idempotency_key)` where non-null.
- Pending recovery is bounded: a stale `pending_stripe` row past 60 minutes is parked in `needs_manual_review` instead of being blindly retried.
- Ops alerts cover every failure path (`manual_fee_charge_failed`, `manual_fee_needs_manual_review`, etc.) with severity tiers + safe-details payloads (no PII).

### 4.4 Webhook safety

- Stripe signature verification via `stripe.webhooks.constructEvent` (HMAC + timestamp tolerance).
- Generic 400 on signature failure; full error logged internally.
- Event-type allowlist; unknown events recorded with `ignoredInPhase1: true` summary and no business logic.
- `stripe_events` table records the event id, type, account, livemode, studio, processed_at, processing_error, and a structured payload summary. No raw body, no secrets, no PII.
- On handler exception: ops alert (`severity=critical`), claim released with error, HTTP 500 returned so Stripe retries.

---

## 5. What blocks live payments

This is the strict blocker list. Each blocker links to the future PR that unblocks it.

### 5.1 Card authorization template (legal blocker)

Willow's `card_authorization` template is titled `"test"`. There is no evidence in the codebase that the body has been reviewed by Chloe or legal counsel.

For a Canadian (Ontario) studio, the live card authorization must explicitly cover:
- The specific circumstances permitting a charge (cancellation, no-show, late cancellation, completion).
- Fee amounts or the formula by which they will be computed.
- The client's affirmation that the charge is authorized off-session, after the fact, with no further consent step.
- Chargeback waiver if the studio's policy depends on it.
- Compliance posture with CASL (Canada's anti-spam law) and PIPEDA (privacy).

Before any live charge: a human (Chloe + legal) reviews the body, updates the title from "test" to the real product name, and the row is re-confirmed `is_live=true`. **Suggested PR #169 (legal review intake, not a Hone-code PR).**

### 5.2 "Test mode only" UI copy (factual blocker)

Seven strings in client and practitioner UI assert "Test mode only." If live mode were enabled tomorrow without removing them, the portal would tell clients "no charge will be made... test mode only" while a real charge was about to happen. That is misleading at minimum and could be a regulatory issue.

The PR that enables live mode must:
- Remove the "Test mode only" tails from every copy line above.
- Conditionally render the dormancy disclaimer on `STRIPE_ALLOW_LIVE_MODE != 'true'` if any of these strings should remain in non-prod contexts.
- Add tests that pin the absence of the "Test mode only" string in live builds.

**Suggested PR #170 (copy + conditional disclaimer).**

### 5.3 Stripe payouts not enabled (operational blocker)

Both production studios have `stripe_payouts_enabled=false`. Even if charges succeeded, the money would sit in the Stripe balance and could not flow to a bank account. The blocker is on Stripe's side (verification documents, bank account on file). Chloe must complete that step from the Stripe dashboard before live charging.

This is **not a code change** but it must be verified before live mode. The operator runbook (§7) covers the check.

### 5.4 Receipt path missing (client experience blocker)

`paymentIntents.create` does not pass `receipt_email`, and Hone does not pre-populate the email on the Stripe Customer. On a successful live charge, the client receives no receipt automatically. Live mode without a receipt path puts the entire dispute risk on Chloe.

A future PR must either:
- Pre-populate the Stripe Customer email at SetupIntent time so Stripe auto-sends, or
- Render a Hone-side receipt template and send it via Resend on `payment_intent.succeeded`.

**Suggested PR #171 (receipt email).**

### 5.5 Refund path missing (operator experience blocker)

There is no `refunds.create` call site in the runtime code. The `stripe_refund_attempts` + `stripe_refunds` tables exist (migration 0032) but are dormant. The `check-stripe-gates.mjs` rule enforces zero occurrences of `refunds.create`.

If Chloe needs to refund a charge (accidental duplicate, dispute resolution, mis-classified fee), she must use the Stripe dashboard manually today. That works but introduces operational risk: no audit row in Hone, no link from the original `manual_fee_charge_attempts` row to the refund.

**Suggested PR #172 (refund action + UI button on manual fee attempt rows; mirror the idempotency + atomic-claim pattern from manual-fee-charge.ts).**

### 5.6 Cancellation / no-show policy alignment (policy blocker)

The fee model today is fixed-amount via `studios.late_cancel_fee_cents` and `studios.no_show_fee_cents`. The `manual_fee_charge_attempts.timing_classification` column has only one value today (`practitioner_asserted`), meaning the system does not mechanically classify "this cancellation crossed the late window." The practitioner manually asserts the charge type.

This is correct for v1 (free-form policy text) but it puts dispute risk on Chloe: a client could claim the cancellation was inside the window and Hone cannot disprove it structurally.

Before live charging, verify with Chloe:
- Is the policy actually a flat amount, or window-based ("50% within 24h, 100% no-show")?
- If window-based, a follow-up PR must add structured threshold columns (`studios.cancellation_window_hours`, `studios.late_cancel_window_hours`) and switch `timing_classification` to `'system_derived'` for the auto-classified cases.

**Suggested PR #173 (policy alignment; only if Chloe's real policy is window-based).**

### 5.7 No test coverage on the charge path (regression blocker)

`runManualFeeCharge` and the webhook `setup_intent.succeeded` handler have no unit tests. The eligibility helper has no edge-case tests. A future refactor (renaming a metadata field, changing the idempotency key shape) could silently break the charge path. Before live mode, this surface needs at least:
- Happy-path test for `runManualFeeCharge` (mock the Stripe client).
- Live-mode-blocked test asserting the early return.
- Webhook idempotency test (same event twice, only one row inserted).
- Eligibility edge cases: no active card, no signed authorization, wrong livemode, archived client.

**Suggested PR #174 (charge path test coverage).**

### 5.8 No live-charge operator runbook (operational blocker)

`docs/11_RUNBOOK.md` does not document live-charge troubleshooting. Before live mode, the runbook must cover:
- How to identify a stuck `pending_stripe` charge.
- How to reconcile a charge attempt against Stripe (PaymentIntent id; metadata mapping).
- How to prove a duplicate (same idempotency key, same client, two PaymentIntents).
- How to interpret common Stripe error codes (card_declined, authentication_required, expired_card, processing_error).
- Whether to retry, refund, or escalate per failure type.

**Suggested PR #175 (operator runbook). This PR (#168) puts a holding stub in `docs/11`; the full runbook is a separate cycle.**

### 5.9 Live-mode webhook handlers missing (correctness blocker)

The webhook route handles `setup_intent.*` and `account.updated` / `capability.updated`. It does NOT handle `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`. These events are recorded with `ignoredInPhase1: true` and no business logic runs.

Before live mode, the webhook must:
- Match `payment_intent.*` on metadata (`hone_manual_fee_charge_attempt_id`) and update the attempt row's status without trusting client-supplied data.
- Handle `charge.refunded` to update `stripe_refunds` rows.
- Handle `charge.dispute.created` to alert the operator (ops_alert with `severity=critical`).

**Suggested PR #176 (live-mode webhook handlers).**

### 5.10 Manual fee DB CHECK constraint blocks live writes (intentional blocker)

```sql
manual_fee_charge_attempts_livemode_false_check
  CHECK (stripe_livemode = false)
```

This CHECK refuses any `INSERT` or `UPDATE` that would land a `stripe_livemode=true` row in the attempts table. It is the third dormancy guard from §3.

The live-mode-enablement PR must drop this constraint or replace it with a less restrictive one. **Suggested PR #177 (DB CHECK replacement, paired with code changes; this must be the LAST code change before flipping STRIPE_ALLOW_LIVE_MODE=true).**

---

## 6. Readiness checklists

### 6.1 Stripe Connect

```text
[x] Willow connected account exists (acct_1Tb59mFJ6u7ZVoZ6)
[x] charges_enabled = true (test mode)
[x] details submitted / onboarding complete (2026-05-25)
[ ] payouts_enabled = true                                 <- BLOCKER (Stripe dashboard)
[x] currency = CAD
[x] test vs live account/key status understood (test only)
[ ] live account onboarding complete                       <- BLOCKER (separate dashboard step)
[ ] live charges_enabled = true                            <- BLOCKER
[ ] live payouts_enabled = true                            <- BLOCKER
[ ] application_fee_bps decision made                      <- BLOCKER (null today = 0%)
```

### 6.2 Card authorization

```text
[x] card_authorization template exists for Willow
[x] template is_live = true (after PR #167 backfill)
[ ] wording reviewed by Chloe                              <- BLOCKER (title is "test")
[ ] legal review complete or accepted risk documented      <- BLOCKER
[x] client must sign before adding card (createCardSetupIntentAction enforces)
[x] signature snapshot stored (client_consent_signatures table; PR #137)
```

### 6.3 Card-on-file

```text
[x] Add card uses SetupIntent only (createCardSetupIntentAction)
[x] Replace card uses SetupIntent only (PR #151)
[x] no charge when adding/replacing card (verified in code + Stripe semantics)
[x] one active card per (studio, client) (partial unique index 0058)
[x] old cards marked removed (atomic pre-flip in webhook 0058)
[x] stripe_livemode recorded (client_payment_methods.stripe_livemode column)
```

### 6.4 Manual fees

```text
[ ] manual fee policy matches Chloe's real policy           <- VERIFY (flat amount vs window-based)
[ ] cancellation/no-show windows correct                    <- VERIFY
[x] amount/percentage model correct for v1 (fixed amount)
[x] duplicate charge prevention verified (3 independent layers)
[x] idempotency verified (deterministic key, Stripe replay)
[x] manual review path clear (needs_manual_review status; ops_alert)
[x] failure path creates ops alert (every failure path covered)
[x] live charge blocked until explicit enablement (3 dormancy guards)
[ ] receipt path                                            <- BLOCKER (PR #171)
[ ] refund path                                             <- BLOCKER (PR #172)
[ ] test coverage                                           <- BLOCKER (PR #174)
[ ] operator runbook                                        <- BLOCKER (PR #175)
[ ] live-mode webhook handlers                              <- BLOCKER (PR #176)
[ ] DB CHECK relaxed                                        <- BLOCKER (PR #177)
```

### 6.5 Receipts and refunds

```text
[ ] receipt behavior decided (Stripe auto vs Hone-sent)     <- BLOCKER
[ ] receipt template exists                                 <- BLOCKER
[ ] refund path exists                                      <- BLOCKER (no refunds.create today)
[ ] operator can find PaymentIntent in Stripe dashboard     <- partial (metadata only; no in-app surface)
[ ] manual refund process documented                        <- BLOCKER (no runbook)
[ ] client communication plan clear                         <- BLOCKER
```

### 6.6 Webhooks

```text
[x] setup_intent.succeeded idempotent (atomic claim + idempotency SELECT)
[ ] payment_intent.succeeded handler                        <- BLOCKER (PR #176)
[ ] payment_intent.payment_failed handler                   <- BLOCKER (PR #176)
[ ] charge.refunded handler                                 <- BLOCKER (PR #176)
[ ] charge.dispute.created handler                          <- BLOCKER (PR #176)
[x] webhook signature verified (Stripe SDK constructEvent)
[x] webhook failure alerting exists (ops_alert with severity=critical)
[ ] live webhook secret distinct from test secret           <- VERIFY (env separation)
```

### 6.7 Environment

```text
[x] STRIPE_ALLOW_LIVE_MODE unset / false in production
[x] sk_test_ key present today; sk_live_ not present
[x] STRIPE_ALLOW_LIVE_MODE=true blocked structurally (lib/stripe/server.ts)
[x] Vercel env vars documented (.env.local.example, docs/10)
[ ] rollback plan documented for live mode                  <- BLOCKER (PR #175 covers)
[ ] live key rotation procedure documented                  <- BLOCKER
```

---

## 7. Operator runbook stub (live payments)

This is a placeholder until PR #175. Today, the only operator action required is to verify that nothing is live.

### 7.1 Verify dormancy

From a terminal with the supabase CLI configured:

```bash
# Confirm no studio is on live mode.
supabase db query --linked "
  select studio_id, stripe_account_id, stripe_livemode, stripe_charges_enabled
  from public.studio_payment_settings;
"
# Expect: stripe_livemode=false for every row.

# Confirm no live-mode charge attempt exists.
supabase db query --linked "
  select count(*) from public.manual_fee_charge_attempts where stripe_livemode = true;
"
# Expect: 0 (the CHECK constraint blocks any such write).

# Confirm STRIPE_ALLOW_LIVE_MODE is not set to 'true' in production.
# Run from the Vercel dashboard: Project -> Settings -> Environment Variables
# Expect: STRIPE_ALLOW_LIVE_MODE absent OR explicitly 'false'.
```

### 7.2 Verify no PaymentIntent will be created today

```bash
# The check-stripe-gates script enforces this on every CI run, but the
# operator can confirm manually.
npm run check:stripe-gates
# Expect: PASS paymentIntents.create -- 1 occurrence in lib/billing/manual-fee-charge.ts only.
# Expect: PASS STRIPE_ALLOW_LIVE_MODE=true -- 1 occurrence in lib/stripe/server.ts only.
```

### 7.3 Live payments are not enabled

If a client or Chloe asks "is the card charging live yet?" the answer is **no**. Direct them to this document. Until each blocker in §5 is resolved by a future PR, all charge surfaces remain dormant.

---

## 8. Go / no-go checklist

A future PR may flip STRIPE_ALLOW_LIVE_MODE=true ONLY when every line below is checked. Every line is justified in §5 or §6.

```text
[ ] PR #169 merged   (legal review of card_authorization wording)
[ ] PR #170 merged   ("Test mode only" copy removed + conditional dormancy disclaimer)
[ ] PR #171 merged   (receipt email path)
[ ] PR #172 merged   (refund code path + UI)
[ ] PR #173 merged   (cancellation policy alignment, if window-based)
[ ] PR #174 merged   (charge path test coverage)
[ ] PR #175 merged   (operator runbook for live charges)
[ ] PR #176 merged   (payment_intent.* + charge.refunded + charge.dispute.* handlers)
[ ] PR #177 merged   (manual_fee_charge_attempts CHECK relaxed + matching code)
[ ] Stripe live account onboarded for Willow
[ ] stripe_payouts_enabled=true on Willow live account
[ ] stripe_application_fee_bps decided + applied
[ ] live webhook endpoint configured in Stripe dashboard
[ ] STRIPE_ALLOW_LIVE_MODE=true added to Vercel production env
[ ] STRIPE_SECRET_KEY rotated to sk_live_*
[ ] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY rotated to pk_live_*
[ ] STRIPE_WEBHOOK_SECRET rotated to whsec_* from the live webhook
[ ] Chloe confirms she has reviewed every checkbox
[ ] First live charge is a test against a Chloe-controlled card with a known amount
[ ] Live ops_alerts subscription verified
[ ] Rollback plan documented (how to flip back to test if a live charge surfaces an issue)
```

Until every box is checked, **do not flip STRIPE_ALLOW_LIVE_MODE=true**.

---

## 9. Risk register

| Risk | Current mitigation | Remaining gap | Decision |
|---|---|---|---|
| Wrong client charged | Atomic eligibility check + lineage FKs (client_payment_methods + client_stripe_customers) + idempotency key bound to attempt id | None for v1 | Accept |
| Duplicate charge | 3-layer protection: app claim RPC + Stripe idempotency window + DB partial unique on `stripe_idempotency_key` | None | Accept |
| Client disputes fee | Signed card_authorization snapshot in client_consent_signatures (immutable, hashed) | Template body unreviewed (titled "test") | BLOCKER (PR #169) |
| Live / test mode confusion | 3 independent dormancy guards (key gate, code gate, DB CHECK); ops_alerts on every failure | 7 UI strings advertise "Test mode only" and would mislead in live mode | BLOCKER (PR #170) |
| No refund workflow | Stripe dashboard fallback works | No in-app refund UI; no link from attempt row to refund row | BLOCKER (PR #172) |
| No receipt to client | None | No automatic email on successful live charge | BLOCKER (PR #171) |
| Stuck pending charge | 60-minute reconciliation window in runManualFeeCharge; `needs_manual_review` status + ops_alert | No operator runbook for resolving | BLOCKER (PR #175) |
| Stripe webhook lost | Stripe retries; ops_alert on handler failure; idempotency table prevents double-processing on retry | `payment_intent.*` events not handled today | BLOCKER (PR #176) |
| Live key leak | Server-only env, never sent to browser; key-format gate in lib/stripe/server.ts | Rotation procedure not documented | BLOCKER (PR #175) |
| Payout not configured | None | `stripe_payouts_enabled=false` on both studios today | BLOCKER (Stripe dashboard, no Hone PR) |
| Platform fee not set | None | `stripe_application_fee_bps=null` for both studios; Hone takes 0% | DECISION (Chloe) |
| Card authorization expired | None | Stripe customers do not have stored email; receipt + dispute notification rely on Hone-side notification | BLOCKER (PR #171 partial) |

---

## 10. Honest non-claims

This document does NOT do any of the following:

- Enable live payments. The three dormancy guards from §3 are unchanged.
- Modify any Stripe key, secret, env var, webhook secret, or Vercel configuration.
- Add or remove `paymentIntents.create` call sites (still exactly 1, in lib/billing/manual-fee-charge.ts).
- Add or remove `refunds.create` call sites (still 0).
- Change webhook handler behavior (still ignores everything except `setup_intent.*` and account/capability).
- Change manual fee charge logic (still `runManualFeeCharge` with live-mode early return).
- Change UI copy (the 7 "Test mode only" strings remain; PR #170 will remove them).
- Change the card authorization consent template (still titled "test"; PR #169 covers legal review).
- Modify any database table, RLS policy, RPC, or index.
- Add any SMS or email behavior.
- Change `STRIPE_ALLOW_LIVE_MODE` default (still unset / `false`).

The Stripe gates remain intact. The only artifacts of this PR are this document plus the guardrail tests that pin the dormancy guarantees.

---

## 11. Next steps

Sequencing recommendation:

1. **Today**: Open PR #168 (this readiness doc) for review.
2. **Week 1**: Independent track: Chloe + legal review the card authorization wording (PR #169 holding stub; the real action is outside the codebase).
3. **Week 1**: Open PR #170 (UI copy + conditional dormancy disclaimer).
4. **Week 2**: Open PR #171 (receipt email path) and PR #172 (refund code path) in parallel.
5. **Week 3**: Open PR #173 (policy alignment) if Chloe's policy is window-based; otherwise skip.
6. **Week 3**: Open PR #174 (charge path test coverage).
7. **Week 3**: Open PR #175 (operator runbook + rollback plan).
8. **Week 4**: Open PR #176 (live-mode webhook handlers).
9. **Week 4**: Open PR #177 (DB CHECK relax + final code change; merge LAST before flipping the env var).
10. **Week 4**: After every box in §8 is checked, flip `STRIPE_ALLOW_LIVE_MODE=true` in Vercel production env and rotate keys.
11. **Week 4**: First live charge is a controlled test against a Chloe-known card.

This sequence is conservative on purpose. Live payments do not benefit from speed; they benefit from every blocker being closed before the first real dollar moves.
