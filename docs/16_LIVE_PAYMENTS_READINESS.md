# 16 Live payments readiness

> **Status (PR #201, 2026-06-12):** docs/18 §16 is the current gate-preparation state. Live receipt template readiness shipped (live branch unreachable; wording needs legal/accounting review); refunds are now owner-only across all charge reasons; stale pending_stripe recovery verified already-shipped; payment audit trail decided as ledger-row-based. Live payments remain disabled; controlled enablement is future PR #202 and is blocked on the PR #196 late-cancel smoke, legal/accounting review, and Willow Stripe live-account readiness.

**Status: NOT READY FOR LIVE PAYMENTS** (original review PR #168, 2026-06-08; reaffirmed after PRs #170-#187, 2026-06-10; **fully re-audited in [docs/18_LIVE_PAYMENTS_AUDIT.md](./18_LIVE_PAYMENTS_AUDIT.md), PR #192, 2026-06-10: that document is the CURRENT readiness picture, scorecard, blocker table, and next-PR sequence; this one remains the historical review + checklists**). Test-mode session payments are built end-to-end (prepare, charge, receipt, refund, webhook reconciliation, billing UX) and practitioner-verified. Live payments are still blocked. Fees are not active. Several §5 blockers carry resolution notes below; the open ones are: legal review of card-authorization wording, tax/HST decision, statement descriptor review, off-session SetupIntent confirmation review, live runbook, dispute-response runbook, Willow live Stripe onboarding, supervised first live charge, late cancellation/no-show fee charging on `payment_charge_attempts`, and `manual_fee_charge_attempts` unification or retirement.

This document is a snapshot of the live-payments readiness review. It exists because Chloe asked, verbatim: *"We need a way to start taking live cards now, not just test. No more cash. We have 3 clients signed up already. We need to get everything live."*

The honest answer right now is **no, we cannot safely take live money yet**. This document explains why, what is already production-safe, and exactly which future PRs unblock live card setup and live manual fees. The audit ran read-only against production data; no code or configuration was changed.

---

## 1. Executive summary

The Stripe charge backend has been installed in production since PR #146 (migration 0032) and PR #135 (migration onwards). The system is **structurally dormant** behind three independent guards (described in §3), so no live money has ever moved through Hone. The dormancy is intentional and survives every shipped PR.

**Three categories of readiness, three answers:**

| Category | Status |
|---|---|
| Live card setup (SetupIntent only, no money movement) | **Not ready.** 7 client-facing copy strings advertise "Test mode only" and would be misleading in live mode; the `card_authorization` consent template Willow has on file is titled "test" (not a reviewed legal document); both studios have `stripe_payouts_enabled=false`. |
| Live manual fees (cancellation + no-show charging) | **Not ready.** Every blocker above plus: no operator runbook for stuck or duplicate charges, the legacy `manual_fee_charge_attempts` runtime has no receipt/charge-notice email and no webhook reconciliation (unification onto `payment_charge_attempts` still open), and the `manual_fee_charge_attempts.stripe_livemode = false` CHECK constraint blocks live writes structurally. (Receipt, refund, and webhook reconciliation DO exist in test mode for session payments on `payment_charge_attempts`: PRs #175, #178, #179.) |
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
$ grep -rln 'paymentIntents\.create' app/ lib/ --include='*.ts' --include='*.tsx'
lib/billing/manual-fee-charge.ts
lib/billing/session-payment-charge.ts
```

Exactly two occurrences as of PR #173 (the section above was written at PR #168 when there was one). Both allowlisted and count-pinned by `scripts/check-stripe-gates.mjs` (`exactly: 2`). These are the only paths that could ever cause money to move; both are behind test-mode livemode gates and `*_livemode_false_check` DB CHECKs.

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

**Resolution for the payment_charge_attempts surface (PR #175, 2026-06-09).** A Hone-side receipt template (`lib/email/templates/payment-receipt.ts`) is rendered and sent via Resend after a successful test-mode session-payment charge, with an atomic claim so the receipt sends at most once, and a `payment_receipt_sent_record_update_failed` internal log if the sent-record write fails after dispatch. Still open for live: content/legal review of the template, and the legacy manual-fee path still sends nothing (unify fees onto `payment_charge_attempts` or add a separate notice before live fees).

### 5.5 Refund path missing (PARTIALLY RESOLVED by PR #178)

> **Status (2026-06-09):** PARTIALLY RESOLVED. PR #178 shipped a reason-agnostic test-mode manual refund path on `payment_charge_attempts` (migration 0078 + `lib/billing/payment-refund.ts` + UI sub-panel). It covers `session_payment` rows today (the only reason with succeeded rows in prod); the same helper refunds future `late_cancellation_fee` / `no_show_fee` rows without code change. Still pending for full live-payments readiness: refunds on `manual_fee_charge_attempts` (the legacy dormant fee runtime), live-mode refunds, automatic refund triggers, dispute response, and webhook reconciliation of `charge.refunded` events for out-of-band refunds.

**Original finding (preserved for audit history):** There is no `refunds.create` call site in the runtime code. The `stripe_refund_attempts` + `stripe_refunds` tables exist (migration 0032) but are dormant. The `check-stripe-gates.mjs` rule enforces zero occurrences of `refunds.create`.

If Chloe needs to refund a charge (accidental duplicate, dispute resolution, mis-classified fee), she must use the Stripe dashboard manually today. That works but introduces operational risk: no audit row in Hone, no link from the original `manual_fee_charge_attempts` row to the refund.

**Resolution (PR #178, 2026-06-09).** Test-mode-only manual refunds on `payment_charge_attempts`:

- `lib/billing/payment-refund.ts:refundPaymentChargeAttempt` (new). Reason-agnostic helper; the discriminator is the row's `charge_reason`, recorded as Stripe-refund metadata (`hone_charge_reason`). Triple dormancy guard: (1) `inferStripeLivemode()` short-circuit at function entry, (2) row-level CHECK `payment_charge_attempts_livemode_false_check`, (3) conditional UPDATE claim requires `status='succeeded' AND stripe_livemode=false AND (refund_status IS NULL OR refund_status='failed')` before the Stripe call runs.
- Migration 0078 adds 9 nullable refund columns + 5 CHECK constraints + 1 FK + 2 partial uniques + 1 partial index. No live-mode CHECK relaxed.
- Stripe-gate-script allowlist: `refunds.create` now `exactly: 1` with allowlist `["lib/billing/payment-refund.ts"]`. Adding a second site is a deliberate review event.
- Deterministic idempotency key: `hone:payment_refund:<attemptId>:v1`. Network-retry produces the same key; Stripe's 24-hour replay catches duplicates. Partial-unique `payment_charge_attempts_refund_idempotency_uniq` is the DB-level backstop.
- v1 scope: **full refund only** (helper writes `refund_amount_cents = amount_cents`). The schema's `refund_amount_cents <= amount_cents` CHECK leaves room for a future partial-refund PR without migration.
- One refund per attempt (partial-unique on `stripe_refund_id`). Failed refunds may be retried; succeeded + in-flight refunds are refused.
- Unknown Stripe outcome (network error after claim) leaves the row at `refund_status='pending_stripe'` and records a critical `payment_refund_stripe_unknown_outcome` ops_alert with the deterministic idempotency key so an operator can re-query Stripe and reconcile.
- UI: new `RefundSubPanel` inside `SucceededPanel` ONLY. Reads `refund_status` from the persisted row so the already-refunded / pending / failed states survive page refresh (mirrors PR #175 receipt sub-panel). Two-click confirm with the amount in the second button. Copy strictly avoids "Live refund" / "Refund complete" / "Money returned" / "Official refund receipt".

**Still pending for live-payments readiness (NOT shipped in PR #178):**

- Live-mode refunds: blocked at entry by `inferStripeLivemode()` short-circuit. Live mode is a separate readiness gate elsewhere on this doc.
- Refunds on `manual_fee_charge_attempts`: the legacy dormant fee runtime still has no refund path. The PR #171 docs explicitly mark `manual_fee_charge_attempts` as the TEMPORARY runtime; live `late_cancellation_fee` / `no_show_fee` charging must move onto `payment_charge_attempts` first (then PR #178's helper covers them by virtue of being reason-agnostic).
- Automatic refund triggers (cancellation-window-cross, no-show-mis-classified): explicit non-goal; manual practitioner click only.
- Webhook reconciliation of `charge.refunded` for out-of-band Stripe-dashboard refunds: still required for live mode. PR #178 owns only the in-Hone refund path.
- Refund receipt email: not in v1. May land as a reason-agnostic mirror of PR #175 in a future PR.
- Dispute response automation: not in v1. Still pending.

**Suggested follow-up PR (post-#178):** webhook reconciliation of `charge.refunded` + `charge.dispute.created` (pair with PR #176-or-later for full live-mode webhook coverage).

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

**Partial resolution (PRs #171-#187, 2026-06-09/10).** The Vitest suite now sits at ~1,480 tests with per-PR coverage of the session-payment surface: eligibility helpers, charge/refund/receipt source invariants, webhook reconciliation matrices, Stripe-gate count pins, and live-mode dormancy guards. Most of it is source-grep invariant pinning per project convention rather than mocked-Stripe happy-path execution; a mocked `runManualFeeCharge` happy-path test and a Supabase-local webhook idempotency test remain open before live mode.

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

**Resolution for the payment_charge_attempts surface (PR #179, 2026-06-09).** Four handlers in `lib/billing/payment-webhook-reconciliation.ts` dispatched from `app/api/stripe/webhook/route.ts`:

| Event | Behavior |
| --- | --- |
| `payment_intent.succeeded` | Flip `ready`/`pending_stripe` rows to `succeeded` with PI id + Charge id + `charged_at`. Critical ops_alert on terminal-local-state mismatch; warning ops_alert on no-match. |
| `payment_intent.payment_failed` | Flip `ready`/`pending_stripe` rows to `failed` with sanitised code/message. Critical ops_alert if local row is already `succeeded`. |
| `charge.refunded` (full) | Reconcile `pending_stripe` -> `succeeded`; reconcile out-of-band null/failed -> `succeeded` with warning `charge_refunded_out_of_band_reconciled`. |
| `charge.refunded` (partial) | Critical ops_alert `charge_refunded_partial_out_of_band`; NO row mutation (v1 schema cannot represent partial). |
| `charge.dispute.created` | Critical ops_alert `payment_charge_dispute_created` with charge/dispute identifiers. No automated dispute response. |

The existing `stripe_events` ledger from migration 0032 provides idempotency (partial unique on `(stripe_account_id, stripe_livemode, stripe_event_id)`); no new ledger table was needed. Row-lookup order: canonical metadata `hone_payment_charge_attempt_id` -> legacy `hone_session_payment_charge_attempt_id` -> fallback by `stripe_payment_intent_id` / `stripe_charge_id`. Metadata mismatch on studio/client/reason fires a critical `stripe_webhook_metadata_mismatch` and refuses to mutate.

Live-mode events are still hard-blocked at the handler entry (`event.livemode===true` -> warning ops_alert + no mutation).

**Still pending for full live-payments readiness:**

- `manual_fee_charge_attempts` webhook reconciliation: the legacy fee runtime still has no webhook handler. PR #171 marked the manual_fee table as the TEMPORARY runtime; live fee charging must move onto `payment_charge_attempts` first (then PR #179's handlers cover it by virtue of being reason-agnostic).
- Live-mode handling itself: PR #179's dormancy guard returns BEFORE any mutation when `event.livemode=true`. Enabling live mode requires the existing dormancy posture to be re-evaluated and the guard relaxed deliberately (separate live-enablement PR).
- `charge.refund.updated` / `refund.updated`: not handled. Stripe sends these after Dashboard refunds are modified (rare); the original `charge.refunded` event covers the common case.
- Refund receipt email: a future PR may add a reason-agnostic mirror of PR #175.
- Tax / HST, statement_descriptor, off-session SetupIntent legal review still open.

### 5.11 Stale `client_payment_methods.card_authorization_signature_id` pointer (RESOLVED by PR #177)

> **Status (2026-06-08):** RESOLVED by PR #177 (migration 0077 + refresh helper + tightened charge-only gate). The original audit-history below is preserved verbatim so a future reader sees the finding shape exactly as PR #176 reported it. The resolution clause sits below the finding.

**Found:** 2026-06-08 during the PR #175 post-merge receipt smoke gating check.

**State observed (prod, studio `9d37c51a-6237-42ef-b9d3-28a567c2bfa8` "My Studio", client `910b9fb2-…25a1`):**

| Source | Signature id | Template version | Timestamp |
| --- | --- | --- | --- |
| latest `client_consent_signatures` row for the live `card_authorization` template (the one `getCardAuthorizationStatus` reads) | `cd3af5cb-33b1-4c6b-8ebf-6170b8dfa278` | 1 | signed 2026-06-08 19:37:18 |
| `client_payment_methods.card_authorization_signature_id` (the pointer stamped when the card was added) | `a6b1fdbe-5738-4a42-bfef-22703edb0dd4` | (against a pre-2026-06-08 template) | card added 2026-06-04 01:19:54 |

Live template id `70a3aede-…854b9` was created 2026-06-08 19:34:27. The card row pre-dates the current live template by ~4 days.

**Why the prepare gate still passes today.** `getCardAuthorizationStatus` (`lib/consent/current-card-authorization.ts:119-127`) selects the LATEST signature for `(studio_id, client_id, template_id)` by `signed_at desc` and compares its `template_version` to the live template's `version`. It does NOT compare the latest signature id to `client_payment_methods.card_authorization_signature_id`. The helper returns `kind='signed_current'` and PR #172's eligibility helper (`lib/billing/session-payment-eligibility.ts:215-222`) lets Prepare proceed.

**Why this is a live-payments blocker, not just a v1 nit.** When a charge is made against this card in live mode, the legal artefact Hone has on the card row's audit trail is the OLD signature `a6b1fdbe`. The OPERATIONAL artefact that the gate said is current is the NEW signature `cd3af5cb`. They are not the same row. If a dispute or chargeback ever asks "show me the signed authorization for the card that was charged", Hone today returns the old signature (because the card row points to it). The studio's defence rests on a signature whose body may differ from what the practitioner believes was authorized.

This is acceptable in test mode where no money moves; it is not acceptable in live mode.

**Proposed fix (NOT in this PR; ticketed as readiness blocker).**

Two options, either or both:

1. **Refresh the pointer when a fresh signature lands.** In `app/portal/consent-form-actions.ts` (or whichever path inserts `client_consent_signatures` for `form_type='card_authorization'`), after the signature row is created, run an UPDATE against `client_payment_methods` matching `(studio_id, client_id, stripe_livemode, status='active', removed_at IS NULL)` setting `card_authorization_signature_id = <new signature id>`. Backfill once with a script for any existing rows where `latest signature id != pointer`.

2. **Tighten the gate at charge time.** In `getCardAuthorizationStatus`, additionally read the card row and verify `card_authorization_signature_id` is one of the signatures for the live template at the current version. Return `kind='signed_current'` only when both the latest signature is current AND the card row's pointer is current. This is stricter and matches the auditing intent.

Option 1 is the natural product behaviour (the card's authorization pointer reflects the freshest signed body). Option 2 is the gate-side defence-in-depth. The recommended live-payments readiness PR sequence ships option 1 plus a one-shot backfill, then option 2 as a CHECK / runtime assertion. Both are additive: no `paymentIntents.create` change, no live-mode flag change, no migration that relaxes the existing `payment_charge_attempts_livemode_false_check`.

**Impact on the PR #175 receipt smoke.** The smoke pauses here. The PR #175 patch (silent-success on DB-update-after-email-success) is already merged + deployed and is provably correct against the test suite. Driving a live Prepare → Execute → Receipt sequence in prod today would do so against a card with a stale authorization pointer, which is exactly the failure mode this finding identifies. The smoke is deferred until either (a) the pointer is repaired, (b) a new card with a fresh post-2026-06-08 signature is added, or (c) the gate is tightened per option 2.

**Suggested PR #177-or-later:** "Card authorization pointer refresh on re-sign + backfill". Pair with a runtime invariant check on Prepare so a future drift is caught at gate time rather than at audit time. (This finding itself is recorded as PR #176, which is docs-only and intentionally does not ship the fix.)

**Resolution (PR #177, 2026-06-08).** Three interdependent pieces shipped together:

1. **Pointer refresh on re-sign** (`lib/payment-methods/refresh-card-authorization-pointer.ts`). The portal sign action (`app/portal/consent-actions.ts`) now calls `refreshActiveCardAuthorizationPointersForSignature` after a successful insert when `template.form_type === 'card_authorization'`. The helper updates every active, non-removed `client_payment_methods` row for `(studio_id, client_id, stripe_livemode=inferStripeLivemode())` so its `card_authorization_signature_id` equals the new signature id. Fail-soft on DB error (records a critical `card_authorization_pointer_refresh_failed` ops_alert; never rolls back the signature). Deliberately does NOT call any auth-status gate so the re-sign path can never deadlock against a stale pointer.

2. **One-shot backfill** (`supabase/migrations/0077_refresh_card_authorization_signature_pointers.sql`). Refreshes existing prod rows so the new charge-time gate does not block known-valid current signatures. Strictly scoped: active + non-removed cards only; only when a current signed signature exists; `IS DISTINCT FROM` for idempotency. No CHECK relaxed; no Stripe; no DML against `manual_fee_charge_attempts` or `payment_charge_attempts`. Applied to prod 2026-06-08 BEFORE PR #177 code merge; NOTICE confirmed `refreshed 1 active client_payment_methods card_authorization_signature_id pointer(s)`.

3. **Tightened charge-only gate** (`lib/consent/current-card-authorization.ts:getChargeReadyCardAuthorizationStatus`). New helper wraps the base PR #170 `getCardAuthorizationStatus` and adds the card-row pointer-equality check. Returns the existing four variants unchanged plus a new `signed_current_but_card_pointer_stale` variant carrying the cardId + stale pointer for debugging. Wired into `lib/billing/session-payment-eligibility.ts` (PREPARE gate) and `lib/billing/session-payment-charge.ts` (EXECUTE recheck). Practitioner-facing remedy copy: "Client must re-sign the current card authorization for the card on file."

**Deadlock prevention (load-bearing):** the charge-ready helper is used ONLY by charge gates (session payment prepare + execute). Portal re-sign (`app/portal/consent-actions.ts`), Add Card / Replace Card (`app/portal/payment-method-actions.ts`), and the manual fee path (`lib/billing/manual-fee-eligibility.ts`, which already had its own pointer check) continue to use the base helper or no gate. A client with a stale pointer can self-heal by re-signing through the portal; the new refresh helper updates the pointer in the same action.

**Known production row repair (verified 2026-06-08 in prod):**
- Card row: `2cb98ea1-df0c-4900-a9ae-5366c05683b9` (studio `9d37c51a-…2bfa8` / client `910b9fb2-…25a1`)
- Pointer BEFORE: `a6b1fdbe-5738-4a42-bfef-22703edb0dd4`
- Pointer AFTER: `cd3af5cb-33b1-4c6b-8ebf-6170b8dfa278` ✅ (matches the latest signed_current signature)
- Stale pointer count BEFORE: 1
- Rows updated by migration: 1
- Stale pointer count AFTER: 0

**Live-mode invariants unchanged:** `manual_fee_charge_attempts_livemode_false_check` and `payment_charge_attempts_livemode_false_check` both intact post-migration (verified by `pg_constraint` lookup). No CHECK constraint was relaxed by 0077.

**Receipt smoke unblock.** The PR #175 receipt smoke can now resume against the repaired prod row (or against any future card whose pointer is auto-maintained by the new refresh helper).

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
# (PR #218 deleted the legacy manual_fee_charge_attempts executor; the
# canonical ledger is payment_charge_attempts — see the PR #281 / §17
# update below.)
supabase db query --linked "
  select count(*) from public.payment_charge_attempts where stripe_livemode = true;
"
# Expect: 0 (the payment_charge_attempts_livemode_false_check CHECK blocks any such write).

# Confirm STRIPE_ALLOW_LIVE_MODE is not set to 'true' in production.
# Run from the Vercel dashboard: Project -> Settings -> Environment Variables
# Expect: STRIPE_ALLOW_LIVE_MODE absent OR explicitly 'false'.
```

### 7.2 Verify no PaymentIntent will be created today

```bash
# The check-stripe-gates script enforces this on every CI run, but the
# operator can confirm manually.
npm run check:stripe-gates
# Expect: PASS paymentIntents.create -- 1 occurrence in lib/billing/session-payment-charge.ts only.
#         (PR #218 deleted lib/billing/manual-fee-charge.ts; the canonical
#         charge executor is now lib/billing/session-payment-charge.ts.)
# Expect: PASS refunds.create        -- 1 occurrence in lib/billing/payment-refund.ts only.
# Expect: PASS charges.create        -- 0 occurrences.
# Expect: PASS checkout.sessions     -- 0 occurrences.
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

---

## 12. Session payment product model (PR #169)

PR #168 audited what was built and concluded NOT READY. PR #169 (this section, added 2026-06-08) defines the product model for what gets built next, before any money-moving code lands. Chloe clarified that "no more cash" means she wants to charge cards through Stripe for three reasons: completed treatment sessions, late cancellation fees, and no-show fees. The manual fee path (PR #145, PR #146) covers the second and third reasons in test mode today. The first reason -- charging the client after the session is delivered -- does not exist yet and is the primary product gap.

This section is **docs only**. No code, no migration, no Stripe behavior change.

### 12.1 Charge after session vs charge at booking

**Decision: charge AFTER the session, with a practitioner-confirmed amount.**

Electrolysis pricing is not knowable at booking time:

- Final treatment duration is determined by what happens in the chair (skin response, area treated, hair density at the actual visit).
- Practitioner judgement adjusts the price for a difficult area, a discount, a make-good after a mistake.
- Tax + corrections happen in real time; the booking price is at best a quote.

If Hone auto-charged the service's `services.price_cents` at booking, every meaningful session would need an adjustment after the fact (refund + re-charge, or a credit-and-reapply pattern). Both of those move real money twice and double the dispute surface. The right shape is to defer the charge until the practitioner sits down at the end of the session and confirms what the client owes.

If Chloe ever wants checkout-at-booking (deposits, prepayments, package sales), that is a different product with different cancellation conversion rules, different tax timing, and a different Stripe flow. Do not conflate them.

### 12.2 Canonical charge reasons

The system supports exactly three reasons today and for the foreseeable future:

```text
session_payment          -- client received a treatment session; practitioner charges the agreed amount
late_cancellation_fee    -- client cancelled inside the policy window; studio charges the configured fee
no_show_fee              -- client did not attend; studio charges the configured fee
```

Any new reason (deposit, package, gift card, store credit) is out of scope for v1 and requires its own design review. The reason is a parameter on the charge attempt row, not a separate code path.

### 12.3 One charge primitive, not parallel implementations

**Architectural decision: one charge-execution helper, parameterized by `charge_reason`.**

The proven pattern from `lib/billing/manual-fee-charge.ts:runManualFeeCharge` is:

1. Claim the row atomically (`claim_*_charge_attempt` RPC under `FOR UPDATE`; transitions to `pending_stripe`; stamps the deterministic idempotency key).
2. Create a Stripe PaymentIntent on the connected account with `idempotencyKey: 'hone:<reason>:<attemptId>:v1'`.
3. Persist the result (PI id, charge id, charged_at, failure code) into the attempt row.
4. On unknown error after claim, park as `needs_manual_review` and emit a `severity=critical` ops_alert; the next click hits a reconciliation path that calls `paymentIntents.retrieve` instead of blindly retrying.
5. Defense-in-depth: three independent dormancy guards (key gate, code gate, DB CHECK) prevent live writes until each one is deliberately removed.

This pattern is correct. The session payment PR (the future PR #181 in §12.13) must reuse it, not parallel it. The audit recommended a separate table for session payments because the **preconditions** differ (completed appointment vs cancelled/no_show, practitioner-entered amount vs studio default fee, no policy acknowledgement required); the **charge-execution body** is identical and stays in one helper.

Concretely:

- **Same**: the helper that calls `stripe.paymentIntents.create`, the idempotency-key shape, the claim RPC pattern, the ops_alert payload, the test-mode live-mode early return, the metadata layout.
- **Different**: the **eligibility helper** (one per reason family), the **amount source** (studio fee table vs practitioner input), and the **consent template** that authorizes the charge.

### 12.4 V1 session payment flow

```text
practitioner starts a session from the appointment detail page
  -> chart blocks / electrolysis or laser entries as today (no payment-side change)
session is completed; practitioner enters the final amount on the session detail
  page (existing sessions.price_paid_cents field; PR #181 will extend this with a
  "charge this amount" action)
practitioner clicks "Prepare session charge"
  -> server-side eligibility check:
       appointment.status='completed'
       sessions.appointment_id = appointment.id (linked; PR #156)
       active client_payment_methods row with non-null
         service_charge_authorization_signature_id (new template type)
       amount_cents > 0 and <= studio-configured ceiling
       client is not archived
       no in-flight attempt for this (appointment_id, session_id, charge_reason='session_payment')
  -> inserts row into the charge attempts table with status='ready'
practitioner reviews the prepared charge (client, session, card, amount)
  -> clicks "Charge card"
  -> runChargeAttempt({ attemptId, reason: 'session_payment' })
  -> Stripe PaymentIntent created off-session against the saved card
  -> webhook payment_intent.succeeded reconciles the row to status='succeeded'
  -> receipt is emailed to the client (PR #171 deliverable)
```

What the system does NOT do automatically:

- Charge from `services.price_cents`. The service price is a quoted reference; the practitioner must confirm.
- Charge based on appointment duration, session duration, treatment area, hair count, or machine settings.
- Charge silently in the background after marking an appointment complete.
- Charge multiple sessions in one PaymentIntent (one PI per session per attempt).

### 12.5 Off-session card requirement

**Positive finding from the audit: the existing SetupIntent flow already uses `usage: "off_session"`.**

From `lib/stripe/setup-intent.ts:202`:

```ts
const setupIntent = await stripe.setupIntents.create(
  {
    customer: params.stripeCustomerId,
    payment_method_types: ["card"],
    usage: "off_session",
    metadata: { ... },
  },
  { stripeAccount: ..., idempotencyKey: ... },
);
```

This means every card on file today can already be charged later without the client present. **No SetupIntent rework is needed before live session payments.** The card-on-file infrastructure built in PR #135 + PR #151 was designed correctly for this from day one.

Replace card (PR #151) reuses the same SetupIntent path, so cards saved via either flow inherit the off-session posture.

### 12.5f Reason-agnostic test-mode receipt path (PR #175, migration 0076, 2026-06-08)

PR #175 shipped the test-mode receipt path on the canonical `payment_charge_attempts` ledger. A practitioner viewing a `succeeded` row can click "Send test receipt" to deliver one Stripe test-mode receipt email to the client. The path is reason-agnostic: today only `session_payment` rows reach it, but `late_cancellation_fee` and `no_show_fee` rows will work without code changes once those writers land on the canonical ledger.

Migration 0076 adds five nullable receipt-state columns (`receipt_status`, `receipt_sent_at`, `receipt_email_to`, `receipt_failure_code`, `receipt_failure_message_safe`) plus three CHECKs (`receipt_status in {sending, sent, failed}`, failure-code length ≤ 100, failure-message length ≤ 1000) plus a partial index `payment_charge_attempts_receipt_sending_idx` on `where receipt_status = 'sending'` for stuck-receipt dashboards. No live-mode CHECK is relaxed.

The body explicitly says: "This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", and "Refund handling is not enabled in Hone yet." Forbidden copy ("tax receipt", "official invoice", "live payment completed", "payment complete") is absent from both the template and the UI, pinned by negative source-grep tests.

The receipt action is a deliberate practitioner click; `runSessionPaymentCharge` does NOT auto-send. This is intentional per the PR #175 spec; an auto-send PR can land later once the receipt copy + dedup proves itself.

This PR closes the docs/16 §5.4 blocker for test mode only. Live-mode receipts are still deferred; the live-enablement PR sequence in §11 / §12.13 carries them.

### 12.5e Session payment UX hardening (PR #174, 2026-06-08, no schema change)

PR #174 refactored `SessionPaymentPrepareCard` so every post-refresh state (succeeded / failed / pending_stripe / ready / cancelled / blocked) renders rich detail driven by the persisted `payment_charge_attempts` row, not by React local state. The eligibility helper's SELECT and the `SessionPaymentExistingAttemptSummary` type were widened to carry every post-execute field (`stripe_payment_intent_id`, `stripe_charge_id`, `charged_at`, `failed_at`, `failure_code`, `failure_message_safe`).

A new `AttemptStatusPanel` dispatcher switches on `attempt.status` and returns one of six per-status subcomponents. The pattern mirrors `ManualFeeChargeCard.tsx`. React local state is now confined to in-session feedback during the same render cycle as the action submit; a page refresh always shows the persisted state.

Copy contracts (each pinned by negative + positive source-grep tests):

- Succeeded heading: "Test charge succeeded" (NOT "Payment complete").
- Succeeded panel: PaymentIntent + Charge id + charged_at + "This was a Stripe test-mode charge. No live card was charged. No receipt was sent in this PR."
- Failed heading: "Test charge failed" + sanitised failure message + failure code + failed_at + "Prepare a new session payment attempt if you need to try again."
- Forbidden copy absent from actionable JSX: Pay now, Charge card, Collect payment, Payment complete, Live payment, Receipt sent.

No live mode. No receipt. No refund. No webhook business logic. No SMS / email. No client-portal change. No new Stripe call sites. The readiness conclusion is unchanged: NOT READY FOR LIVE PAYMENTS. The remaining blockers (receipt path, refund path, payment_intent.* webhook handlers) are still pending.

### 12.5d Session payment EXECUTE flow (PR #173, migration 0075, 2026-06-08, test mode only)

PR #173 shipped the test-mode execution helper that takes a prepared `session_payment` row (PR #172) and creates ONE Stripe PaymentIntent on the connected account against the saved test card. The helper (`lib/billing/session-payment-charge.ts:runSessionPaymentCharge`) is a faithful port of `runManualFeeCharge` adapted for `payment_charge_attempts`. Migration 0075 added the atomic claim RPC `claim_session_payment_charge_attempt` (mirror of the manual fee RPC from migration 0065).

The Stripe gate (`scripts/check-stripe-gates.mjs` + `tests/lib/billing/live-mode-blockers.test.ts`) was updated deliberately to allow exactly 2 allowlisted `paymentIntents.create` call sites (the manual fee charge + the new session payment charge). Every other negative gate stayed at zero. `STRIPE_ALLOW_LIVE_MODE=true` remains allowlisted to `lib/stripe/server.ts` only.

The execution helper is gated by:
1. `inferStripeLivemode() === true` early return.
2. Row-level `stripe_livemode = false` re-check.
3. Reason guard (`charge_reason='session_payment'`).
4. **PR #170 current-card-authorization recheck at execution time** (the signature stamped at prepare must still match `getCardAuthorizationStatus().signatureId` AND be `kind='signed_current'`).
5. Full card / studio / customer-mapping lineage recheck.
6. Atomic claim via the new RPC BEFORE any Stripe call.
7. Deterministic idempotency key `hone:session_payment:<attemptId>:v1`.
8. On error after claim, ops_alert at appropriate severity; row stays `pending_stripe` for manual reconciliation.

No live mode. No receipt. No refund. No webhook business logic added. No SMS / email. The readiness conclusion is unchanged: NOT READY FOR LIVE PAYMENTS. The receipt + refund + webhook reconciliation work is still pending (the docs/16 §11 sequence). PR #173 makes the test-mode end-to-end charge path exercisable in the studio detail page.

### 12.5c Session payment PREPARE flow (PR #172, 2026-06-08, test mode only)

PR #172 shipped the first runtime writer of `public.payment_charge_attempts`. A practitioner on the session detail page (`/clients/[id]/sessions/[sessionId]`) can now Prepare a `session_payment` charge attempt by submitting an amount + internal note. The action `prepareSessionPaymentChargeAction` inserts one row with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`. **No Stripe call. No PaymentIntent. No charge. No refund. No webhook. No SMS or email.**

Chargeability proxy (Audit 1 in the PR #172 audit confirmed there is no `sessions.completed_at` column today):

```text
sessions.appointment_id IS NOT NULL
AND appointments.status = 'completed'
AND sessions.started_at IS NOT NULL
```

Freeform (unlinked) sessions are deferred to a future product decision. Migration 0073's `reason_shape_check` deliberately left `appointment_id` OPTIONAL for `session_payment` so a later relax does not need a schema change.

Card authorization gate (reused from PR #170): the prepare path calls `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` and requires `kind='signed_current'`. Old signatures against a pre-edit template version do NOT satisfy the gate. The `card_authorization_signature_id` stamped on the row is the same id the helper returned, so the audit trail is unambiguous.

The prepare flow does NOT change the readiness conclusion: live payments are still NOT READY. Every blocker in §5 remains. PR #172 only fills the prepare half of the runtime; the execution helper (the `runManualFeeCharge` counterpart) is deferred to a separate PR. The Stripe gates remain intact (1 allowlisted `paymentIntents.create`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string).

### 12.5b Canonical payment_charge_attempts ledger (PR #171, migrations 0073 + 0074, 2026-06-08)

PR #171 created the dormant canonical `public.payment_charge_attempts` table in production (migration 0073; 0 rows; first writes land in PR #181 in test mode). The schema is the single destination for all three charge reasons (`session_payment`, `late_cancellation_fee`, `no_show_fee`). Full schema detail lives in `supabase/migrations/0073_payment_charge_attempts.sql` and `docs/09` migration log; full decision rationale lives in `docs/13`.

**Temporary two-table state (dated checkpoint, 2026-06-08):**

- `manual_fee_charge_attempts` (migration 0064 + 0065) remains the test-mode runtime ledger for `late_cancel` and `no_show` fee preparations. The proven helper `lib/billing/manual-fee-charge.ts:runManualFeeCharge` still reads + writes ONLY this table.
- `payment_charge_attempts` (migration 0073) is the future canonical charge ledger. The future helper (PR #181) writes the first rows here for `session_payment`.
- The two-table state is temporary.
- **Runtime fee charging must be migrated or unified onto `payment_charge_attempts` before live `late_cancellation_fee` or `no_show_fee` charging ships.** The unification (or formal deprecation of `manual_fee_charge_attempts`) is a separate PR (PR #178 placeholder in the sequence below); it must land before the live-mode CHECK relax for fees.

**Gate (do not bypass):**

```text
Before live late_cancellation_fee or no_show_fee charging,
manual_fee_charge_attempts must either be migrated into
payment_charge_attempts or formally deprecated with no
live-money rows.
```

The `payment_charge_attempts_livemode_false_check` CHECK constraint is the named structural dormancy guard for the new table. The future live-mode-enablement PR (per the §11 sequence) must drop or replace it deliberately, paired with the runtime helper code change. The constraint name is the search anchor.

### 12.6 Card authorization wording requirement

**PR #170 status (2026-06-08):** the product-ready DRAFT body now lives in code at `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (around 2.5 kB; covers all 7 spec topics: card on file, completed-session off-session charges, late cancellation, no-show, receipts/refunds/disputes, payment processing + privacy, scope + revocation; preserves chargeback rights with an explicit "does not waive my dispute rights" line; does not claim legal approval). PR #170 also shipped the current-version signature gate, so once an owner pastes the body into Settings → Consent forms (which bumps the version via `updateConsentTemplateAction`), historical signatures against the placeholder body stop counting for new SetupIntent or manual fee work. The legal review (Chloe + counsel) is still required before any live payment; PR #170 made the draft + the gate available but did not flip the legal-approval state.

**Confirmed gap from production query (2026-06-08): Willow's two `card_authorization` templates have `body = "test"` (4 characters).**

```text
form_type='card_authorization'
studio_id=9d37c51a-...          body="test"   is_live=true   status=active
studio_id=38cb3a8b-...          body="test"   is_live=true   status=active
```

Both are flagged `is_live=true` (PR #167 backfill preserved the pre-PR portal visibility), but the body is a placeholder. Before any live charge:

The body must explicitly authorize, in plain language:

1. **Off-session charging for completed sessions** -- the client agrees that the studio can charge their saved card for treatment after the session ends, without a signature or further consent at charge time.
2. **Late cancellation fees** -- the client understands the studio's cancellation policy (linked or quoted in the body) and agrees that a fee may be charged on their saved card if they cancel inside the window.
3. **No-show fees** -- the client agrees that a fee may be charged on their saved card if they do not attend a scheduled appointment.
4. **Chargeback / dispute posture** -- the client acknowledges the studio's evidence record (signed authorization, appointment history, session notes) in the event of a dispute.

CASL + PIPEDA + Ontario consumer-contract considerations apply; a lawyer review is the only correct way to finalize the wording. The Hone codebase does not validate the body text against required phrases (and should not -- the legal wording is the studio's responsibility, not Hone's); the wording review is a non-code artifact tracked in the go/no-go checklist.

The card_authorization template's title also needs to change from `"test"` to a real product name (for example: `"Card on file authorization"`); the body is the load-bearing piece, but a `"test"`-titled live consent row erodes trust if a client ever sees it in their portal Forms and records list.

### 12.7 Application fee decision

**Decision: 0% Hone platform fee per transaction in v1.**

From PR #168 audit: `studio_payment_settings.stripe_application_fee_bps = null` for both pilot studios. The migration 0032 invariant is that the application MUST NOT pass `application_fee_amount` on PaymentIntent creation; the RPC + the runtime code both enforce zero.

Posture for v1:

- Studio is the merchant of record.
- Stripe pays out 100% of the captured amount (less Stripe's own processing fees) to the studio's connected account.
- Hone takes nothing per transaction.
- Hone bills its own subscription / platform fee out of band, not through Stripe's `application_fee_amount` field.

This is a deliberate business choice, not a default. If Sam decides Hone should take a per-transaction cut later, that is its own PR with its own decision log and requires Chloe + the studio to consent on the connect-onboarding side (Stripe shows the application fee on the studio's payouts dashboard). Do not silently set `stripe_application_fee_bps`.

### 12.8 Tax handling decision

**Decision: practitioner enters the all-in / gross amount; Hone does not calculate tax in v1.**

The session payment helper records the amount charged. The studio remains responsible for tax pricing, tax remittance, and tax line items on receipts. This is consistent with the "no more cash" framing -- the studio was already collecting cash gross of tax and remitting separately; the live charge path matches that.

Hone does NOT in v1:

- Calculate GST / HST / PST.
- Render tax lines on receipts.
- Track a separate tax_cents field.
- Issue tax invoices.

A future PR can layer Stripe Tax on top if Chloe (or a future studio) needs automated tax handling. That is a separate product, requires per-jurisdiction configuration, and is out of v1 scope.

### 12.9 Paid status derivation

**Decision: paid status is DERIVED from successful charge attempt rows. No separate `appointments.paid` or `sessions.paid` boolean.**

Why:

- A boolean dual-writes with the actual evidence (the charge attempt row + Stripe PaymentIntent state). Dual writes drift; the boolean would be wrong every time a webhook is delayed, a charge is refunded, or a manual fee is reconciled.
- The charge attempt row carries the full audit trail (idempotency key, Stripe PI id, charged_at, failure_code, refund history) that a boolean does not.
- The portal Forms and records surface (PR #159) already reads signatures directly without joining templates; the same pattern applies: read the charge attempts row directly.

The "paid" UI badge on the appointment detail page (future PR) reads the existence of a `status='succeeded'` charge attempt for the appointment_id + reason='session_payment' pair. If a refund lands later, the refund row recolors the badge to "refunded" without flipping any boolean.

`sessions.price_paid_cents` (migration 0003) is a separate historical field that exists for record-keeping (what the client paid for this session, regardless of whether Hone moved the money or it was paid in cash). It is NOT the source of truth for "did Hone charge this?" -- the charge attempt row is.

### 12.10 Merchant of record and statement descriptor

**Decision: the studio's connected account is the merchant of record.**

On the client's credit-card statement and on the Stripe-issued receipt, the merchant name shown is the studio (Willow Electrolysis), not Hone. This matches the standard Stripe Express + Connect platform pattern and avoids any client confusion about who they paid.

The statement descriptor on the PaymentIntent (the short label that shows on the bank statement) should identify the studio. The session payment PR will set `statement_descriptor_suffix` from the studio's configured short name; Stripe combines this with the connected account's base descriptor at posting time. Hone's name does not appear on the client's statement.

The implications:

- A dispute (chargeback) is filed against the studio's connected account. The studio is the responder.
- The studio's tax / business registration is what the receipt carries.
- If Hone later takes an application fee (§12.7), that shows on the studio's Stripe payouts dashboard, not on the client's receipt.

### 12.11 Risk separation: session payments vs cancellation / no-show fees

The three charge reasons have different dispute risk profiles. Enable them in order:

| Reason | Dispute risk | Why | Enable when |
|---|---|---|---|
| `session_payment` | Lower | Client received a service. The chair-time is the evidence. | First. Easier to defend, easier to recover from a mistaken charge. |
| `late_cancellation_fee` | Higher | Client did not receive a service. Defense depends on (a) signed policy acknowledgement, (b) explicit timing classification. | After session_payment is proven in live mode. |
| `no_show_fee` | Highest | Client did not receive a service, AND the studio cannot prove the client was reachable. Defense depends on the same evidence plus reminder delivery records. | Last. Only after no-show evidence collection is hardened. |

This ordering means **PR #181 (the future session payment build) can ship before the late_cancellation_fee and no_show_fee paths flip to live**. The manual fee CHECK constraint (migration 0065) keeps cancellation+no_show in test mode independently of session_payment. The DB CHECK relaxation PR (#177 in the original sequence) becomes a per-reason decision, not a single switch.

### 12.12 Future schema sketch (informational; defer to schema PR)

The next schema PR (estimated `0073_session_payment_charge_attempts.sql`, confirmed against `supabase/migrations/` at build time) has two viable shapes. PR #169 does not pick a winner; the schema PR's audit will. Both are documented here so the trade-off is searchable.

**Option A: separate `session_payment_charge_attempts` table.**

```sql
create table public.session_payment_charge_attempts (
  id                                uuid primary key default gen_random_uuid(),
  studio_id                         uuid not null references public.studios(id) on delete cascade,
  session_id                        uuid not null references public.sessions(id) on delete restrict,
  appointment_id                    uuid not null references public.appointments(id) on delete restrict,
  client_id                         uuid not null references public.clients(id) on delete restrict,
  confirmed_by_practitioner_id      uuid not null references public.practitioners(id) on delete restrict,
  amount_cents                      integer not null check (amount_cents > 0 and amount_cents <= 10_000_00),
  currency                          text not null default 'cad' check (currency in ('cad')),
  status                            text not null default 'ready'
                                      check (status in ('ready','pending_stripe','succeeded','failed','cancelled','needs_manual_review')),
  client_payment_method_id          uuid not null references public.client_payment_methods(id) on delete restrict,
  service_charge_authorization_signature_id uuid not null references public.client_consent_signatures(id) on delete restrict,
  stripe_account_id                 text not null,
  stripe_livemode                   boolean not null default false check (stripe_livemode = false),
  stripe_payment_intent_id          text,
  stripe_charge_id                  text,
  stripe_idempotency_key            text,
  charged_at                        timestamptz,
  failed_at                         timestamptz,
  failure_code                      text,
  failure_message_safe              text,
  cancelled_at                      timestamptz,
  cancelled_by_practitioner_id      uuid references public.practitioners(id) on delete set null,
  internal_note                     text not null,
  created_at                        timestamptz not null default now(),
  updated_at                        timestamptz not null default now()
);
```

Pros: each reason owns its own table; the eligibility helper for each reason has no nullable-field branching; the manual_fee_charge_attempts schema and constraints stay frozen (lower regression risk on the proven test-mode path).

Cons: two tables to keep in sync structurally (constraint shapes, RLS, ops_alert events); two CHECK constraints to relax independently when going live.

**Option B: unified `payment_charge_attempts` table.**

Generalize `manual_fee_charge_attempts` to `payment_charge_attempts` with:

- `charge_reason text not null check (charge_reason in ('session_payment','late_cancellation_fee','no_show_fee'))`
- `session_id uuid` (nullable; required only when reason='session_payment')
- `appointment_policy_acknowledgement_id uuid` (nullable; required only when reason in ('late_cancellation_fee','no_show_fee'))
- `service_charge_authorization_signature_id uuid` (nullable; required only when reason='session_payment')
- Two partial CHECKs enforcing the nullability rules above.

Pros: one charge primitive code path with a single result table; one CHECK constraint to relax when going live.

Cons: migration is heavier (rename existing table, drop+re-add CHECKs, update RLS policies, update every reference); schema has nullable fields that are required-given-context (CHECK enforces but the type system does not).

**Recommendation (informational, not binding):** prefer Option B (unified table). The argument in §12.3 for a single charge primitive carries through to the data model. The nullable-with-CHECK pattern is already used elsewhere in the schema (PR #167's `is_live` CHECK, PR #156's `appointment_id` nullable FK). A single CHECK + a single set of indexes + a single set of ops_alerts is easier to reason about than two.

But the trade-off depends on how tight the rename migration can be. The schema PR's audit will decide.

### 12.13 Updated MVP sequence

The §11 sequence stays valid for the cancellation + no-show fee track. Session payments add their own track, parallel to (not replacing) it. Both tracks share the live-mode-enablement gate (§8).

| New PR | Track | Depends on | Description |
|---|---|---|---|
| PR #169 (this PR) | Both | -- | Product model + go/no-go reorganization; docs + guardrails only. |
| PR #170 | Both | -- | Legal review of card_authorization template body (was "PR #169" in the original §11; renumbered after this PR consumed the slot). The body must cover all three charge reasons or each reason gets its own template (see §12.6). |
| PR #171 | Both | PR #170 | Remove "Test mode only" UI copy from the 7 known locations; add a conditional dormancy disclaimer that reads `STRIPE_ALLOW_LIVE_MODE`. |
| PR #172 | Both | -- | Receipt email path. Required before live charges of any reason because the client must see what they were charged for. |
| PR #173 | Both | -- | Refund code path + practitioner UI button. Required before live charges of any reason because mistakes happen. |
| PR #174 | Cancel/no-show | -- | Cancellation / no-show policy alignment (only if Chloe's real policy is window-based). |
| PR #175 | Both | PR #172, PR #173 | Charge-path test coverage. |
| PR #176 | Both | PR #172 | Operator runbook + rollback plan. |
| PR #177 | Both | -- | `payment_intent.*` + `charge.refunded` + `charge.dispute.*` webhook handlers. |
| PR #178 | Both | PR #170-PR #177 | Cancel + no-show DB CHECK relax (was "PR #177" in the original §11). |
| **Session payment track** | | | |
| PR #179 | session_payment | -- | Add `service_charge_authorization` to `consent_form_templates.form_type` CHECK constraint; new template authored per studio. |
| PR #180 | session_payment | PR #179 | Schema migration: `session_payment_charge_attempts` (Option A) or `payment_charge_attempts` rename (Option B). Schema-PR audit picks the shape. |
| PR #181 | session_payment | PR #180 | Session payment eligibility helper + `runSessionPaymentCharge` calling the shared charge primitive; "Charge session" UI on appointment + session detail pages; test-mode only. |
| PR #182 | session_payment | PR #181 | Add the "Mark complete" button to the appointment detail page (today removed per a previous review; needs to come back paired with the session payment flow so the practitioner has a single "finish + charge" path). |
| PR #183 | session_payment | PR #181, PR #182 | Session payment DB CHECK relax (mirror of PR #178 for the session payment table). |
| Operator | -- | -- | `stripe_payouts_enabled=true` via Stripe dashboard; `stripe_application_fee_bps` decision (0% per §12.7); live key rotation. |

Sequence rule: session_payment can flip to live ONLY after PR #170 to PR #173 + PR #175 to PR #177 + PR #179 to PR #183 + the operator-side Stripe work. Cancellation + no-show fees flip to live independently after PR #170 to PR #178 + the operator work. Each reason has its own DB CHECK relax PR (PR #178 for cancel/no-show, PR #183 for session_payment) so live-enablement is per-reason, not all-or-nothing.

### 12.14 Readiness conclusion update

The §1 conclusion stands: **NOT READY FOR LIVE PAYMENTS** for any reason.

Refined:

- **Ready to BUILD the session payment infrastructure?** Yes. The audit found no architectural blocker: the SetupIntent is correctly off-session, the manual fee pattern is generalizable, the schema sketch is clear. PR #179 - #183 can ship sequentially.
- **Ready to FLIP session_payment to live?** No. Same blockers as the cancellation track (legal review, receipt path, refund path, test coverage, runbook, webhook handlers) plus the session payment track's own work (new consent template, new attempts table, charge UI).
- **Ready to FLIP late_cancellation_fee or no_show_fee to live?** No. Plus higher dispute risk per §12.11 means these two should follow session_payment, not lead.

### 12.15 What this PR does not do

PR #169 is docs + guardrails ONLY. Nothing in this PR:

- Enables live payments. The three dormancy guards from §3 are unchanged.
- Creates or modifies any database table, RLS policy, RPC, or index. No new migration. The latest migration in tree is still `0072_consent_templates_is_live.sql` from PR #167.
- Modifies any Stripe key, secret, env var, webhook secret, or Vercel configuration.
- Adds or removes any `paymentIntents.create` call site. Still exactly one; since PR #196 unification (and PR #218's removal of the dead legacy executor `lib/billing/manual-fee-charge.ts`) it lives in `lib/billing/session-payment-charge.ts`.
- Adds or removes any `refunds.create` call site. Still zero.
- Changes webhook handler behavior. Still ignores everything except `setup_intent.*` and account/capability.
- Changes manual fee charge logic. Still `runManualFeeCharge` with live-mode early return.
- Changes UI copy. The 7 "Test mode only" strings remain; PR #171 will remove them.
- Changes the card authorization consent template. Body still says `"test"` in production; PR #170 covers the legal review.
- Adds any SMS or email behavior.
- Changes `STRIPE_ALLOW_LIVE_MODE` default. Still unset / `false`.

The Stripe gates remain intact. The only artifacts of this PR are the new section above plus the guardrail tests that pin the section's claims.

---

## 17. Payment reconciliation + controlled live-payment readiness runbook (PR #282)

> **This section is the authoritative, post-#281 reconciliation + controlled-enablement runbook.** It supersedes the §7 stub (kept above for history; §7.1/§7.2 references corrected for the `payment_charge_attempts` ledger). **PR #282 adds readiness + reconciliation only — it is NOT live-payment enablement.** Controlled live-payment enablement remains a **separate, explicit, owner-approved future step**.

### 17.1 Current status

- **Live payments are DISABLED.** `STRIPE_ALLOW_LIVE_MODE` is unset / `false` in production; the three dormancy guards (§3) are intact; the Stripe gates pass.
- **PR #281 (payment success persistence) is COMPLETE and authoritative.** A normal `succeeded` outcome now requires **Stripe success AND a proven Hone ledger write**. If Stripe succeeds but Hone cannot persist the success (DB error or zero-row update), the charge path returns `needs_manual_review` (never a clean success) and a **critical** ops alert fires (`session_payment_succeeded_write_failed` / `session_payment_succeeded_write_zero_rows`). See docs/06 §4d.
- **Webhook reconciliation remains the eventual-consistency backstop.** The `payment_intent.succeeded` handler (`lib/billing/payment-webhook-reconciliation.ts`, PR #179) reconciles a `ready|pending_stripe` row to `succeeded`, so a transient #281 DB-error split self-heals even though the synchronous result was honestly indeterminate.
- **Operators already have full visibility** via the admin **Ops alerts** page (`/admin/ops-alerts`): unresolved-critical-first, with event, message, PaymentIntent id, and redacted details; critical alerts also email `OPS_ALERT_EMAILS`. No new dashboard is required for reconciliation.

### 17.2 Required gates before any live-mode change

Every line must hold (most are CI-enforced):

- [ ] Stripe gates pass — **one** `paymentIntents.create`, **one** `refunds.create`, **zero** `charges.create`, **zero** `checkout.sessions` (`npm run check:stripe-gates`).
- [ ] Local success persistence is authoritative (PR #281 — `tests/lib/billing/payment-success-persistence.test.ts`).
- [ ] Webhook **signature verification** confirmed — `constructEvent` over the raw body with `STRIPE_WEBHOOK_SECRET`; `400 "Invalid signature."` on any failure (`app/api/stripe/webhook/route.ts`).
- [ ] Webhook **replay procedure** documented (§17.6).
- [ ] **Refund path** documented and test-verified (`lib/billing/payment-refund.ts`; refund is owner-only, reason-agnostic, idempotent, manual-review on persist failure).
- [ ] **Manual-review handling** documented (§17.4 / §17.5).
- [ ] **Reconciliation checks** return clean (§17.7 read-only SQL).
- [ ] **Rollback plan** documented (§17.8).
- [ ] Owner business approval recorded; Willow live Stripe account onboarded + payouts enabled; legal/accounting review of card-authorization wording, statement descriptor, and tax/HST complete (the open §5 / docs/18 blockers).

### 17.3 Forbidden actions without explicit owner approval

Do **NOT**, as part of readiness work, do any of the following — each is a separate, owner-approved live-enablement decision:

- Set `STRIPE_ALLOW_LIVE_MODE=true` (in any environment).
- Add or rotate to live Stripe keys (`sk_live_*` / live `whsec_*` / live publishable key).
- Run a live charge or any live payment flow.
- Enable card-required / card-on-file-mandatory flows broadly.
- Onboard a studio to live mode (`studio_payment_settings.stripe_livemode=true`).

### 17.4 Before the first controlled live payment

- Confirm the **business decision / owner approval** is recorded.
- Confirm the **test-mode payment flow** works end-to-end (prepare → charge → receipt → refund) — docs/12 payment smoke chain.
- Confirm the **refund flow** works in test mode.
- Confirm **webhook delivery** is live-endpoint-configured in the Stripe dashboard, and the **replay procedure** (§17.6) is understood.
- Confirm the **connected account** state (Willow): onboarded, `charges_enabled`, `payouts_enabled`.
- Confirm the **manual-review procedure** (§17.5).
- Confirm the **reconciliation checks** (§17.7) return clean (zero stuck/mismatched rows, zero unresolved payment criticals).
- Confirm the **rollback procedure** (§17.8) is ready.

### 17.5 During the first controlled live payment

- **One studio only.** **One operator** watching production logs + the Ops alerts page. **One small controlled payment.**
- Verify the **Stripe dashboard** shows the PaymentIntent `succeeded`.
- Verify the **Hone payment ledger** row: `payment_charge_attempts.status='succeeded'`, PI id + charge id + `charged_at` stamped.
- Verify the **webhook event** was received + processed (`stripe_events`).
- Verify **no critical ops alert** fired (especially the #281 `session_payment_succeeded_write_*` pair).
- Verify the **refund path** if appropriate — in a sandbox/test context, not necessarily a real refund.
- **Stop immediately on any mismatch** and execute the rollback (§17.8).

### 17.6 Webhook replay / reconciliation procedure

- Events are claimed idempotently via `claim_stripe_event` and recorded in `public.stripe_events` with a `payload_summary` + processed state.
- To replay: re-send the event from the **Stripe dashboard** (Developers → Webhooks → event → Resend) or via the Stripe CLI. The handler is idempotent — a re-delivered, already-processed event is a no-op; a previously-unmatched event re-runs the matcher.
- A `payment_intent.succeeded` with no matching local row raises `payment_intent_succeeded_no_match` (warning); a terminal-state mismatch raises a **critical** alert — both visible on the Ops alerts page. Reconcile the named PaymentIntent against the ledger before any retry.

### 17.7 Read-only reconciliation checks (SELECT-only)

All snippets are **read-only** (`SELECT` only — no `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`). Run them in the Supabase SQL editor (read-only role) or any read replica. They never call Stripe. Run these before/after a controlled live payment and on a schedule once live.

```sql
-- (1) Payment attempts stuck in pending_stripe too long (> 60 min).
-- The synchronous reconcile window is 60 min; the webhook is the backstop.
-- A non-empty result means a charge may be unreconciled — investigate before retry.
select id, studio_id, charge_reason, amount_cents, stripe_payment_intent_id, updated_at
from public.payment_charge_attempts
where status = 'pending_stripe'
  and updated_at < now() - interval '60 minutes'
order by updated_at asc;
```

```sql
-- (2) Stripe PaymentIntent present but the local row is NOT succeeded.
-- Catches a #281-style "Stripe moved money but Hone did not persist success"
-- split (row left in pending_stripe with a stamped/known PI). Cross-check each
-- PI id against the Stripe dashboard.
select id, studio_id, charge_reason, status, stripe_payment_intent_id, stripe_status, charged_at, updated_at
from public.payment_charge_attempts
where stripe_payment_intent_id is not null
  and status <> 'succeeded'
  and status <> 'failed'
order by updated_at asc;
```

```sql
-- (3) The PR #281 critical success-persistence alerts (UNRESOLVED).
-- Any row here = Stripe succeeded but Hone could not persist; reconcile the
-- attempt_id / PaymentIntent before it is retried.
select created_at, event, severity, stripe_payment_intent_id, message, safe_details
from public.ops_alerts
where event in ('session_payment_succeeded_write_failed',
                'session_payment_succeeded_write_zero_rows')
  and resolved_at is null
order by created_at desc;
```

```sql
-- (4) Refund-review / refund write-failure alerts (UNRESOLVED).
select created_at, event, severity, stripe_payment_intent_id, message
from public.ops_alerts
where event like 'payment_refund_%'
  and severity in ('warning', 'critical')
  and resolved_at is null
order by created_at desc;
```

```sql
-- (5) Unprocessed / unmapped Stripe webhook events (recent).
-- A claimed-but-not-processed event, or a succeeded event that matched no
-- local row (see the no_match ops alert in (6)), needs operator reconciliation.
select event_id, type, livemode, processed_at, claimed_at, created_at
from public.stripe_events
where processed_at is null
  and created_at > now() - interval '7 days'
order by created_at desc;
```

```sql
-- (6) Recent payment/Stripe critical ops alerts (last 7 days), unresolved first.
-- The operator's single sweep for anything money-related that needs a human.
select created_at, event, severity, stripe_event_id, stripe_payment_intent_id, message, resolved_at
from public.ops_alerts
where severity = 'critical'
  and (event like 'session_payment_%'
       or event like 'payment_intent_%'
       or event like 'payment_refund_%'
       or event like 'charge_%'
       or event like 'stripe_webhook_%')
  and created_at > now() - interval '7 days'
order by (resolved_at is null) desc, created_at desc;
```

### 17.8 Rollback plan

If anything looks wrong at any point during or after a controlled live payment:

1. **Disable the live-mode env flag** — set `STRIPE_ALLOW_LIVE_MODE` to unset / `false` in Vercel production (re-arms the key gate — `sk_live_` is rejected immediately).
2. **Revert / pause live Stripe key usage** — rotate back to `sk_test_*` if a live key was added; the key gate then refuses live mode regardless of the flag.
3. **Pause the charging path if needed** — stop new charges (e.g. revert the enabling deploy) until reconciled.
4. **Inspect ops alerts** — the admin Ops alerts page + the §17.7 queries; resolve or escalate every payment critical.
5. **Inspect the Stripe dashboard** — confirm the true state of each PaymentIntent / charge / refund.
6. **Document the outcome** — what happened, what was reconciled, and the go/no-go for the next attempt.

### 17.9 After the first controlled live payment

- Run the §17.7 reconciliation checks — expect all clean.
- Sample production logs — expect no payment errors / 5xx.
- Confirm no unresolved payment ops alert.
- Document the outcome.
- **Do not broaden** (more studios / larger amounts / card-required flows) until repeated clean controlled runs.

### 17.10 What PR #282 does NOT do

- Does NOT enable live payments, set `STRIPE_ALLOW_LIVE_MODE=true`, add live Stripe keys, run live charges, or start controlled live-payment enablement.
- Does NOT change any charge / refund / webhook runtime behavior.
- Does NOT add a migration, a new DB table/column/RLS/RPC, or a new admin UI.
- Does NOT add an executable script that connects to production. The reconciliation checks are read-only SQL snippets the operator runs deliberately.

The only artifacts of PR #282 are this section + the documentation updates + the guardrail test (`tests/docs/payment-reconciliation-readiness.test.ts`) that pins these claims. **Live payments remain disabled; controlled live-payment enablement has not started.**

### 17.11 Manual-review queue surface (PR #290)

The §17.7 read-only reconciliation checks now have an **in-app, admin-only, read-only surface**: `/admin/payments/manual-review` (PR #290). It renders exactly two of the §17.7 checks for the operator without needing the Supabase SQL editor:

- **Stuck payment attempts** — `payment_charge_attempts` where `status='pending_stripe'` and `updated_at < now()-60min` (query (1)).
- **Unresolved critical payment alerts** — `ops_alerts` where `severity='critical'`, `resolved_at IS NULL`, and the event is a payment manual-review event (queries (3)/(6), critical-only). Warning-level reconciliation alerts and card-on-file setup failures stay on the full `/admin/ops-alerts` list.

Access is the existing `ADMIN_EMAILS` / `isAdmin` operator gate (the `/admin` layout redirects non-admins; the page re-checks and `notFound()`s) and reads via the service-role client (so `studio_id`-NULL alerts are visible). It displays only safe fields (studio name + ids, `client_id`/`session_id`/`appointment_id` **ids — no client names**, amount/currency, Hone status, `charge_reason`, `failure_code`, the non-secret PaymentIntent id, a live/test-mode flag, the alert event/severity, and the **redacted** alert message) plus the conservative next-step from this runbook.

**It is strictly READ-ONLY.** There is **no** resolve / retry / refund / repair action on this page — resolution stays on `/admin/ops-alerts` (the queue links there), and any actual reconciliation follows §17 (review the PaymentIntent in Stripe, compare with the Hone attempt, do **not** retry/refund blindly). No Stripe API call, no payment-attempt mutation, no migration. **Live payments remain disabled; controlled live-payment enablement has not started.** Pinned by `tests/app/admin/payment-manual-review.test.ts`.
