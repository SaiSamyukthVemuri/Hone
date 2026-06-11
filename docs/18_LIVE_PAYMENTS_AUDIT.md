# 18 Live Payments Readiness Audit (PR #192)

**Audit date:** 2026-06-10, after PR #191 (production at migration 0082, merge `0fb10bf`).
**Verdict: NOT READY FOR LIVE PAYMENTS.** Test-mode session payments are complete and verified end to end by a real practitioner smoke (Chloe, 2026-06-10: prepare -> $25 charge -> receipt -> refund, attempt `6b71d20d`). Live payments are blocked by design and must stay blocked until the P0 blockers in §13 land. This document is an audit only; nothing in PR #192 changes runtime behavior.

This supersedes the per-section status notes in `docs/16_LIVE_PAYMENTS_READINESS.md` (the PR #168 review) as the current readiness picture; docs/16 remains the historical record and checklist source.

---

## 1. Payment system inventory

### 1.1 Database tables

| Table | Migration | Purpose | Runtime writers | Runtime readers | Status | Receipts | Refunds | Webhook recon | Live/test tracking | RLS | Live-safe |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `payment_charge_attempts` | 0073/0074/0076/0078 | Canonical charge ledger (session_payment + future fees) | prepare/execute/receipt/refund actions, webhook handlers | session payment card, webhook | **CURRENT** | yes (0076 columns) | yes (0078 columns, full-amount) | yes (PR #179) | `stripe_livemode` + `payment_charge_attempts_livemode_false_check` | member SELECT only; writes service-role | **Yes, after live-enable PR** (CHECK must be deliberately replaced) |
| `manual_fee_charge_attempts` | 0060-0065 | LEGACY test-mode cancellation/no-show fee ledger | `lib/billing/manual-fee-charge.ts` via `app/(app)/calendar/[id]/manual-fee-actions.ts` | ManualFeeChargeCard | **LEGACY (declared TEMPORARY in PR #171)** | **no** | **no** | **no** | `stripe_livemode` + `manual_fee_charge_attempts_livemode_false_check` | yes | **No. P0 blocker for live fees** |
| `client_payment_methods` | 0058/0059 | Card-on-file (brand/last4/expiry + Stripe ids only) | webhook `setup_intent.succeeded`, portal replace | eligibility helpers, portal card UI | CURRENT | n/a | n/a | yes (setup_intent) | `stripe_livemode` column | yes | Yes |
| `stripe_events` | 0032 | Webhook idempotency ledger | webhook (`claim_stripe_event` RPC) | webhook | CURRENT | n/a | n/a | is the mechanism | `stripe_livemode` in unique key | service-role | Yes |
| `studio_payment_settings` | 0032 | Connect account id + status flags | webhook `account.updated`, settings actions | payments settings, eligibility | CURRENT | n/a | n/a | yes | n/a | yes | Yes |
| `ops_alerts` | 0067 | Durable operator alerts | `lib/ops/alerts.ts:recordOpsAlert` (webhook, billing, cron, booking) | **NOBODY (no UI; SQL-only)** | CURRENT but **write-only** | n/a | n/a | n/a | n/a | yes | **No human-visible path: P0 blocker** |
| `consent_form_signatures` (card_authorization kind) | 0044+ | Signed card authorization evidence; `signed_current` gating | portal signing flow | eligibility (`getCardAuthorizationStatus`), pointer refresh (PR #177) | CURRENT | n/a | n/a | n/a | n/a | yes | Wording needs legal review; mechanics yes |
| `appointment_payments`, `stripe_charge_attempts`, `stripe_refund_attempts`, `stripe_refunds`, `stripe_disputes`, `stripe_payment_audit`, `payment_consents`, `client_stripe_customers`, `payment_recovery_tokens`, `pending_booking_payment_sessions`, `stripe_*_provisioning_attempts` | 0032 | Phase-1 dormant backend | **none** (zero references in app/ or lib/) | **none** | **DORMANT** | - | - | - | - | yes | Not wired; candidates to retire in ledger unification |

### 1.2 Stripe identifiers, where stored

All on `payment_charge_attempts` unless noted: `stripe_account_id` (also `studio_payment_settings`), `stripe_customer_id` + `stripe_payment_method_id` (also `client_payment_methods`), setup intent id (`client_payment_methods.stripe_setup_intent_id`, 0059 unique), `stripe_payment_intent_id` (partial unique), `stripe_charge_id`, `stripe_refund_id` (partial unique), webhook event id (`stripe_events`), `stripe_livemode`, receipt state (`receipt_status/sent_at/email_to/failure_*`, 0076), refund state (`refund_status/amount_cents/refunded_at/failure_*`, 0078), charge failure state (`failure_code/failure_message_safe/failed_at`), idempotency key (`stripe_idempotency_key`, partial unique).

### 1.3 Runtime flows

| # | Flow | Files | Writes | Test/live behavior | Idempotency | Live-ready |
|---|---|---|---|---|---|---|
| 1 | Session payment prepare | `app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts` -> `lib/billing/session-payment-eligibility.ts` | `payment_charge_attempts` (status `ready`, `stripe_livemode=false`) | test only (DB CHECK) | partial-unique active row per session | mechanics yes |
| 2 | Test charge execute | same actions -> `lib/billing/session-payment-charge.ts` | same row -> `pending_stripe` -> `succeeded/failed` | live blocked: key gate + `inferStripeLivemode` + DB CHECK | `claim_session_payment_charge_attempt` RPC (0075, FOR UPDATE conditional) + deterministic key `hone:session_payment:<id>:v1` | yes once gates deliberately relaxed |
| 3 | Receipt | `lib/billing/payment-receipt.ts`, `lib/email/templates/payment-receipt.ts` | receipt columns | template hard-labels TEST MODE | atomic claim, at-most-once send | copy is test-only: needs live variant + review |
| 4 | Refund | `lib/billing/payment-refund.ts` (sole `refunds.create`) | refund columns | test only (gates) | atomic claim, partial-unique `stripe_refund_id`, full-amount only | mechanics yes; partial refunds absent |
| 5 | Webhook reconciliation | `app/api/stripe/webhook/route.ts`, `lib/billing/payment-webhook-reconciliation.ts` | `stripe_events`, attempt rows, `ops_alerts` | `event.livemode===true` -> warning alert, no mutation | `claim_stripe_event` RPC | handler relaxation needed at live-enable |
| 6/7 | No-show / late-cancel fee | `app/(app)/calendar/[id]/manual-fee-actions.ts`, `lib/billing/manual-fee-charge.ts` | `manual_fee_charge_attempts` | test only | claim RPC + key `hone:manual-fee:<id>:v1` | **NO: no receipt/refund/reconciliation. P0** |
| 8 | Card authorization | portal consent signing; `lib/consent/current-card-authorization.ts`; pointer refresh PR #177 | signatures + `client_payment_methods.card_authorization_signature_id` | n/a | n/a | mechanics yes; wording needs legal review |
| 9 | Card-on-file SetupIntent | `app/portal/payment-method-actions.ts`, webhook `setup_intent.succeeded` | `client_payment_methods` | test only (gates) | unique setup-intent id; replace pre-flips old row | yes |
| 10 | Portal card management | `PortalCardOnFileCard/PortalPaymentMethodForm` (add/replace only) | via flow 9 | "Test mode only" copy must change at live | n/a | yes after copy pass |
| 11 | Admin/manual tools | none for payments (`/admin` is read-only metadata; ops_alerts has no UI) | - | - | - | gap: see §6 |

---

## 2. Live-mode gates (verified, unchanged)

1. **Key gate** `lib/stripe/server.ts:50`: `sk_live_*` throws unless `STRIPE_ALLOW_LIVE_MODE === "true"`; Preview/Dev refuse live keys regardless. The literal `STRIPE_ALLOW_LIVE_MODE=true` appears exactly once in runtime source, inside the error message (gate-pinned).
2. **Runtime livemode inference**: both charge paths early-return on `inferStripeLivemode()` mismatch; webhook handlers hard-return on `event.livemode === true` (warning ops_alert, no mutation).
3. **DB CHECKs**: `payment_charge_attempts_livemode_false_check` + `manual_fee_charge_attempts_livemode_false_check` make `stripe_livemode=true` rows structurally unwritable (verified intact in prod during the PR #189-era smokes; 0 live rows ever).
4. **CI**: `scripts/check-stripe-gates.mjs` (runs in `npm run ci` + GitHub Actions safety gates) pins exact counts: `paymentIntents.create` exactly 2 allowlisted, `refunds.create` exactly 1 allowlisted, `charges.create` 0, `checkout.sessions` 0, `set_studio_require_card_on_file` 0, the live-mode literal 1. Per-PR gate tests (#171-#192) re-pin the counts.

**Bypass risks:** a new file calling `paymentIntents.create` fails the exact-count gate (cannot sneak). Residual risks: (a) a raw `fetch` to `api.stripe.com` would evade the grep: no occurrence today, worth a gate-script term later; (b) gates live in repo, so a future PR could edit them: mitigated by per-PR pin tests + review discipline; (c) Stripe dashboard-side actions are out of Hone's control (webhook reconciles them in test mode).

**Conditions to relax (live-enable PR only):** legal/accounting sign-off (§10), ops visibility (§6), fee-ledger unification (§3), live receipt copy, runbook approved; then deliberately: env flip + replace the `payment_charge_attempts` CHECK + relax webhook livemode guard for reconciliation. **Gates that stay forever:** exact-count CI scans, allowlists, `charges.create`/`checkout.sessions` zero-pins, Preview/Dev live-key refusal, the `manual_fee` CHECK (until that ledger is retired).

---

## 3. Dual-ledger findings

The ledger is **still split**:

- `payment_charge_attempts` (CURRENT): session payments; full lifecycle (charge, receipt, refund, webhook reconciliation, ops alerts); reason-agnostic columns and reason-shape CHECK already accommodate `late_cancellation_fee` / `no_show_fee`; PR #178 refunds and PR #179 webhook handlers are reason-agnostic by design.
- `manual_fee_charge_attempts` (LEGACY, declared TEMPORARY in PR #171): still the live runtime for cancellation/no-show fees via `ManualFeeChargeCard`. **No receipt path, no refund path, no webhook reconciliation, no metadata handler** (`hone_manual_fee_charge_attempt_id` events are recorded-but-ignored).

**If live were enabled today:** session payments would have a complete safety net, but a live no-show fee would charge a real card with no receipt to the client, no in-app refund path, and no reconciliation if Stripe and Hone disagree. **This is a P0 live blocker.** Recommended fix: PR #194 moves fee charging onto `payment_charge_attempts` (the schema is ready; the fee actions/UI re-point; the legacy runtime freezes), then the legacy table is retired or kept read-only for history. The 0032 dormant tables (`stripe_charge_attempts`, `stripe_refunds`, etc.) have zero runtime references and should be dropped or explicitly archived in the same unification.

---

## 4. Receipt and refund findings

**Receipts** (`lib/billing/payment-receipt.ts` + template): send only from a `succeeded` row; atomic claim makes sends at-most-once (duplicate-send impossible barring the logged send-succeeded-but-record-failed race, which is alarmed via `payment_receipt_sent_record_update_failed`); `receipt_sent_at`/`receipt_email_to` recorded; address comes from the client row at send time. Copy audit: explicitly says "No tax calculation is included on this receipt."; no "invoice", "tax receipt", "official", "charitable", "pay now", or "send invoice" anywhere; subject and body are hard-labeled Stripe TEST-MODE. **Consequence: the current template is structurally test-only: a live receipt variant (without the test disclaimer, with reviewed wording) does not exist yet.** Receipt wording for live use needs legal/accounting review (HST/GST line, business identity, refund-policy mention). **Classification: ready for test mode; NOT live-ready (copy only: mechanics are ready).**

**Refunds** (`lib/billing/payment-refund.ts`): only from `succeeded` rows; atomic claim + partial-unique `stripe_refund_id` prevent duplicates; full-amount only (schema allows future partials without migration); state persists (`refund_status/refunded_at`); webhook `charge.refunded` reconciles out-of-band refunds (partials alert-only); UI hides the refund button after `refund_status='succeeded'` and shows the refunded panel (verified in Chloe's smoke + pinned). **Classification: ready for test mode and mechanically ready for a limited live pilot; partial refunds and refund-permission policy (see §9) open.**

---

## 5. Webhook and reconciliation findings

`app/api/stripe/webhook/route.ts`: raw-body `constructEvent` signature verification (generic 400 on failure, no oracle); idempotent claim via `claim_stripe_event` (partial unique on account+livemode+event id): duplicates and concurrent deliveries lose the claim and no-op; out-of-order/delayed events are safe because every handler is a conditional state mirror (already-terminal rows are idempotent no-ops; contradictions alert and refuse to mutate). Handled: `setup_intent.succeeded`, `account.updated`/`capability.updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded` (full reconciles; partial alerts-only), `charge.dispute.created` (critical alert, no automation). Metadata matching: canonical `hone_payment_charge_attempt_id` -> legacy key -> PI/charge-id fallback; studio/client/reason mismatch fires critical `stripe_webhook_metadata_mismatch` and refuses to mutate. Live events: hard-ignored at handler entry (dormancy). Not handled: `refund.updated` (rare), `charge.dispute.closed`, manual-fee metadata (see §3).

**The gap is not the machinery: it is that every alarm lands in `console.error` + `ops_alerts`, which no human sees** (§6). Marked as part of the P0 ops blocker.

---

## 6. Ops-alert findings

`lib/ops/alerts.ts:recordOpsAlert` writes durable rows (severity `warning`/`critical`) + structured logs; ~30 event types cover charge/receipt/refund failures, webhook mismatches, disputes, cron failures, email give-ups. **But:** there is **no admin UI** (zero readers of `ops_alerts` in app/), **no mark-resolved path** (nothing writes `resolved_at`), and **no email/Slack dispatch** (`OPS_ALERT_EMAILS` is reserved in env docs but never read; deliberately deferred in PR #153 to avoid an email-subsystem dependency cycle). Today an operator finds a dispute by running SQL from docs/11. Verified live during this audit's window: alerts table readable, zero unresolved-alert surface anywhere in the product.

**Classification: acceptable for test mode; BLOCKER for live payments.** A live dispute or a live charge/receipt/refund failure must reach a human without them thinking to run SQL. **Recommendation: PR #193 "Ops Alerts Dashboard + Critical Notifications"** (unresolved-alerts admin page, mark-resolved, critical-severity email via a standalone `lib/ops/alert-email.ts` that does not import the appointment email subsystem).

> **RESOLVED by PR #193 (2026-06-10):** `/admin/ops-alerts` (ADMIN_EMAILS-gated) lists unresolved alerts critical-first with safe metadata expanders and a conditional mark-resolved action (`resolved_at/resolved_by/resolution_note`, the 0067 columns); critical-severity alerts additionally email the operators in `OPS_ALERT_EMAILS` via the standalone `lib/ops/alert-email.ts` (bare Resend client, no appointment-email import, never calls recordOpsAlert, never throws; unset env = row+dashboard still work). Set `OPS_ALERT_EMAILS` in Production to activate notifications.

---

## 7. Consent / card authorization findings

Charge eligibility (`lib/billing/session-payment-eligibility.ts`, mirrored by the manual-fee eligibility) requires: active practitioner, studio Stripe account ready, an ACTIVE card row with non-null `card_authorization_signature_id`, and `getCardAuthorizationStatus(...) = 'signed_current'`: i.e. the signature exists, belongs to this client/studio, and matches the CURRENT template version (version, timestamp, signer captured on the signature row; superseded versions block with a clear reason). PR #177 keeps the card->signature pointer fresh and backfilled, with a charge-time invariant. Blocked states render as a calm reason list in the payment card; the practitioner sees authorization status before any charge. Receipts/refunds operate on the attempt row's frozen lineage, which is correct. Cancellation/no-show POLICY text is studio-authored and not yet structurally tied to the authorization version: flagged in the legal checklist. **Mechanics: live-safe. Wording: needs legal review (standing docs/16 §5.1 blocker).**

---

## 8. UI state findings

`components/session-payment-prepare-card.tsx` renders distinct, persistent states: blocked (reason list), ready (prepare form), prepared/ready row, charging, succeeded (PI + charge ids, charged_at), receipt sub-states (sent w/ timestamp+address, failed w/ safe reason, send button), refund sub-states (available, refunded panel promoted to heading w/ amber palette + refund id/amount/date, failed w/ retry), failed/cancelled/blocked as non-blocking terminal callouts (PR #174), test-mode labels throughout. PR #181 eliminated the stale "prepared/no charge" banner (router.refresh after prepare): confirmed in Chloe's smoke ("refresh preserved refunded state; no stale prepared message"). Webhook-pending is not a distinct UI state (acceptable: reconciliation is a backstop, the action path is synchronous). **Live gap is copy, not state:** "Test mode only. No live card will be charged." appears across 7+ surfaces (docs/16 §2.4 pins them) and must be conditionally replaced in the live-enable PR.

---

## 9. Security / abuse findings

| Risk | Status | Notes |
|---|---|---|
| Double-click / concurrent charge | **Handled** | claim RPC (FOR UPDATE conditional) + deterministic idempotency key + Stripe idempotency |
| Duplicate charge on retry | **Handled** | same key on retry within window; stale `pending_stripe` needs manual review (60-min rule): live must add `paymentIntents.search` (docs/16 §5 standing item) |
| Amount tampering | **Handled** | amount fixed at prepare into the row (DB CHECK 0 < x <= $2,000); execute charges `attemptRow.amount_cents`, never client input |
| Client/studio/session mismatch | **Handled** | studio-scoped queries + lineage checks + webhook metadata matching |
| Charge authorization (who may charge) | **Handled (policy open)** | any ACTIVE practitioner of the studio; no owner-only restriction: acceptable for a 1-2 person pilot, revisit before multi-staff studios |
| Refund permission | **Partially handled** | any active practitioner can refund; no owner-only gate, no refund audit_logs row (ops trail exists via attempt columns). Policy decision before live. |
| Webhook spoofing | **Handled** | signature verification, generic 400, idempotent claim |
| Live/test confusion | **Handled** | three independent guards + UI labels + receipt disclaimer |
| Payment IDs exposure | **Handled** | practitioner-auth surfaces only; portal shows brand/last4 only |
| Card data leakage | **Handled** | brand/last4/expiry + Stripe ids only; no PAN/CVC/client_secret stored |
| Sensitive logging | **Handled** | sanitized failure codes/messages; no card data, no secrets in logs |
| CSRF / server actions | **Handled** | Next server actions + practitioner auth + studio scoping |
| Charge/refund audit trail | **Partially handled** | attempt rows carry actor/timestamps; no `audit_logs` entries for charge/refund (export got one in PR #189; payments should match before live) |

---

## 10. Legal / accounting / compliance checklist (human review required; no legal claims made)

1. Receipt wording for live use (it is NOT an invoice; no-tax line; business identity shown as the studio).
2. Tax/HST/GST decision for electrolysis services in Ontario (charge, exempt, or include-in-price) and whether receipts must show a registration number.
3. Refund policy wording (client-facing) + whether practitioners may issue refunds unilaterally.
4. Cancellation/no-show policy wording and its linkage to the signed card authorization.
5. Card authorization template wording (standing docs/16 §5.1 blocker; lawyer review under Ontario law: CASL/PIPEDA/PCI/contract enforceability).
6. Consent versioning behavior when wording changes post-signature (re-sign threshold).
7. Statement descriptor review (what the client's card statement shows).
8. Off-session SetupIntent confirmation review (saving a card without an immediate charge).
9. Data retention period for payment/audit records.
10. Stripe account ownership/business profile (Willow as merchant of record; payouts enabled: currently `stripe_payouts_enabled=false` on both studios).
11. Dispute handling process + responsible human.
12. Privacy policy + Terms updates for live payment processing.
13. Record export expectations (payment rows are NOT in the studio data export today: decide whether they should be).

---

## 11. UI/admin gaps summary

- No ops alerts UI / notifications (P0, §6).
- Live copy pass needed across 7+ test-mode strings, the receipt template, and the portal card surfaces (P0 at enable time).
- No payment row in the data export, no charge/refund audit_logs entries (P1).
- No partial refund (P2; schema-ready).

## 12. Readiness scorecard

| Dimension | Score | Note |
|---|---|---|
| Payment architecture | 9/10 | canonical ledger + claims + gates are excellent; split fee ledger is the deduction |
| Test-mode readiness | 10/10 | practitioner-verified end to end |
| Live charge readiness | 4/10 | mechanics ready; gates/copy/ops/legal not |
| Refund readiness | 7/10 | full-amount solid; permission policy + partials open |
| Receipt readiness | 5/10 | mechanics ready; template is structurally test-only |
| Webhook/reconciliation | 8/10 | strong idempotent mirror; alarms invisible to humans |
| Ops readiness | 2/10 | durable rows, zero human visibility |
| Legal/accounting readiness | 1/10 | nothing reviewed yet |
| UI state readiness | 9/10 | states distinct + persistent; live copy pending |
| **Overall live-payment readiness** | **4/10** | **NOT READY FOR LIVE PAYMENTS: ready for internal test-mode only** |

## 13. Blockers

| P | Blocker | Where | Why | Fix | PR |
|---|---|---|---|---|---|
| ~~P0~~ | ~~No human-visible ops alerting~~ **RESOLVED by PR #193**: `/admin/ops-alerts` dashboard + mark-resolved + critical email (`OPS_ALERT_EMAILS`; set in Production to activate) | `app/admin/ops-alerts/`, `lib/ops/alert-email.ts` | a live dispute would go unseen | shipped | **#193 ✅** |
| ~~P0~~ | ~~Fee charging on legacy ledger~~ **RESOLVED by PR #196**: fees unified onto `payment_charge_attempts` (receipts/refunds/reconciliation inherited); legacy table frozen for new writes, historical reads kept; 0032 dormant-table retirement still a cleanup follow-up | `manual-fee-actions.ts`, migration 0083 | live no-show fee = real charge with no safety net | shipped | **#196 ✅** |
| P0 | Receipt template is test-only; live copy unreviewed | `lib/email/templates/payment-receipt.ts` | cannot send the current receipt for a real charge | live variant + legal/accounting review | **#197** |
| P0 | Legal/accounting review (card auth wording, tax/HST, refund + cancellation policy, statement descriptor, off-session confirmation) | docs/05, docs/16 §5.1 | enforceability + compliance | human review cycle; codify outcomes | **#197** |
| P0 | "Test mode only" copy across 7+ surfaces would be false in live | docs/16 §2.4 list | misleading client/practitioner copy | conditional copy at enable | **#198** |
| P1 | Stale `pending_stripe` recovery trusts idempotency window; no `paymentIntents.search` | `lib/billing/session-payment-charge.ts` | live retries must verify before re-charging | metadata search pre-retry | #197/#198 |
| P1 | Refund/charge permission policy + missing audit_logs entries | payment actions | accountability for money movement | decide owner-vs-practitioner; add audit rows | #197 |
| P1 | Stripe payouts not enabled on Willow's account; live onboarding unverified | Stripe dashboard | charges without payouts strand funds | dashboard checklist in runbook | #197/#198 |
| P2 | Partial refunds unsupported (alert-only via webhook) | 0078 schema ready | dashboard partials reconcile as alerts only | later PR post-live |
| P2 | Payment rows absent from data export; `refund.updated`/`dispute.closed` unhandled | export action, webhook | completeness | later PR |

## 14. Recommended PR sequence

1. **PR #193: Ops Alerts Dashboard + Critical Notifications**: unresolved-alerts admin page (owner-gated), mark-resolved, critical email dispatch via standalone `lib/ops/alert-email.ts`, surfacing disputes/mismatches/failed receipt-refund-webhook/cron failures. Clears the visibility P0.
2. **PR #194: Payment Ledger Unification**: fee charging (late-cancel/no-show) re-pointed to `payment_charge_attempts` (schema already reason-ready; receipts/refunds/reconciliation inherit); legacy `manual_fee_charge_attempts` runtime frozen; 0032 dormant tables retired or archived; charge/refund audit_logs rows + refund-permission decision can ride along.
3. **PR #195: Live Payments Gate Preparation**: legal/accounting-reviewed receipt + policy + authorization copy; live receipt template; `paymentIntents.search` pre-retry; final runbook (below) committed; env/dashboard checklists; NO enablement.
4. **PR #196: Controlled Live Payment Enablement**: deliberate gate relaxation behind explicit review (env flip, CHECK replacement migration, webhook livemode relaxation, conditional copy), then the §15 runbook's first controlled $1 live charge + refund with full verification and rollback.

## 15. Draft live enablement runbook (FUTURE - DO NOT EXECUTE)

1. **Preconditions:** PRs #193-#195 merged; legal/accounting sign-offs recorded in docs/13; Chloe informed and scheduled; rollback rehearsed in test mode.
2. **Code changes (PR #198 only):** env `STRIPE_ALLOW_LIVE_MODE=true` in Production only; migration deliberately replacing `payment_charge_attempts_livemode_false_check`; webhook livemode guard relaxed for reconciliation; conditional live copy; live publishable/secret keys.
3. **Approvals:** lawyer (card auth + policies), accountant (receipt/tax), operator (runbook).
4. **Env checks:** `sk_live_*`/`pk_live_*` set in Production env only; Preview/Dev still refuse live keys; `STRIPE_WEBHOOK_SECRET` points at the LIVE connected-account webhook endpoint.
5. **Stripe dashboard:** Willow live account: `charges_enabled`, `payouts_enabled`, `details_submitted` all true; statement descriptor set; webhook endpoint live-mode with matching secret; dispute notification email set.
6. **Database:** new live-mode CHECK posture applied; `stripe_events` unique key covers livemode=true; zero pre-existing live rows.
7. **CI:** gates script updated allowlist reviewed; all safety pins green.
8. **First controlled live charge:** internal card, $1.00, on a designated test client in Willow; verify PI/charge ids, `stripe_livemode=true` row, charged_at.
9. **First controlled refund:** refund the $1 fully; verify refund id, `refund_status='succeeded'`, Stripe dashboard agreement.
10. **Receipt verification:** live receipt arrives, wording per approved copy, no test-mode label, correct address.
11. **Webhook verification:** `payment_intent.succeeded` + `charge.refunded` events claimed exactly once; rows reconciled; no mismatch alerts.
12. **Ops alert verification:** trigger a synthetic warning; confirm dashboard + email visibility.
13. **Rollback:** unset `STRIPE_ALLOW_LIVE_MODE`, redeploy (key gate re-blocks instantly); leave DB rows for audit; refund any stray live charge via dashboard; postmortem in docs/13.
14. **Post-launch monitoring:** daily ops-alerts review for two weeks; weekly Stripe-vs-ledger reconciliation query; supervised first real client charge before unsupervised use.

---

*Audit performed in PR #192. No runtime, gate, migration, env, or production-data change was made.*

> **Roadmap renumbering (PR #196 docs patch):** ops smoke took #195 and ledger unification took #196, so the forward sequence is now **#197 Live Payments Gate Preparation** (live receipt copy, legal/accounting review, refund permission + audit rows, stale-pending paymentIntents.search, payouts readiness), **#198 Controlled Live Payment Enablement** (test-mode copy pass, controlled live charge/refund under the runbook), **#199 Marketing Site Refresh**.

---

## 16. PR #201 gate preparation (2026-06-12)

PR #201 executed the "Live Payments Gate Preparation" step (renumbered: docs said #195, then #197; the actual GitHub PR is **#201**, and controlled enablement is **#202**). **Live payments remain disabled.** No gate, env, CHECK, or executor change was made.

### 16.1 Blocker status updates (supersedes the table in §13 where noted)

| Blocker (from §13) | Status after PR #201 |
|---|---|
| P0 receipt template test-only | **Template readiness SHIPPED**: `buildPaymentReceiptEmail` accepts `livemode` (default false; test branch byte-identical, pinned). Live branch uses cautious wording ("Receipt for card payment processed by [Studio]." / "No tax calculation is included on this receipt unless separately stated by the studio." / "For questions about this payment or refund eligibility, contact the studio."), never says TEST MODE, and never claims tax receipt / official invoice / charitable receipt / pay now / send invoice (pinned). The sender passes `livemode: false` explicitly and still refuses any row with `stripe_livemode !== false`, so the live branch is structurally unreachable. **Final live wording: Needs legal/accounting review.** |
| P0 legal/accounting review | **OPEN. Remains a blocker for PR #202.** Checklist in §16.5. |
| P0 test-mode copy across surfaces | **Copy map documented (§16.2); runtime unchanged.** Conditional live labels are a PR #202 change, behind the enablement review. |
| P1 stale pending_stripe recovery | **Already resolved by the PR #196 unification, verified in this audit**: both executors recover `pending_stripe` deterministically (stored PaymentIntent id + deterministic idempotency key + `paymentIntents.retrieve` reconciliation; ambiguous states stay pending and force manual review; ops alerts fire on mismatch). `paymentIntents.search` by metadata remains an OPTIONAL hardening for rows that lost their PI id (none can exist by construction: the id is written before confirm). Not a blocker. Pinned in tests. |
| P1 refund permission + audit rows | **Refund permission DECIDED + SHIPPED: owner-only** (§16.3). **Audit rows DECIDED: the ledger row IS the audit row** (§16.4); no new table, no migration. |
| P1 Willow payouts/onboarding | **OPEN. Remains a blocker for PR #202.** Checklist in §16.6. |

### 16.2 Payment UI copy map (test-mode strings, where they live, future live labels)

All current copy is test-mode-truthful and **unchanged by PR #201** (pinned). Conditional live variants are listed for PR #202 planning only.

| Current test-mode string | Where | Future live label (PR #202, after review) |
|---|---|---|
| "This prepares a test-mode payment record. It does not charge the client." | `components/session-payment-prepare-card.tsx` header | "This prepares a payment record. The charge runs in the next step." |
| "Run test charge" (+ confirm variant) | `session-payment-prepare-card.tsx` ready panel; `ManualFeeChargeCard.tsx` ready panel | "Run charge" |
| "This was a Stripe test-mode charge. No live card was charged." | `session-payment-prepare-card.tsx` succeeded + refunded panels | "Card payment processed via Stripe." |
| "This was a Stripe test-mode attempt. No live card is charged." | `session-payment-prepare-card.tsx` failure panel | "The charge did not complete. No card was charged." |
| "Test mode only. No live card will be charged." | `ManualFeeChargeCard.tsx` (x2) | removed (live) |
| "Ready for test charge" / "Stripe test charge pending." | `ManualFeeChargeCard.tsx` | "Ready to charge" / "Stripe charge pending." |
| "Send test receipt" / "Refund test charge" | `ManualFeeChargeCard.tsx` succeeded panel | "Send receipt" / "Refund payment" |
| "TEST MODE receipt from ..." subject + body disclaimers | `lib/email/templates/payment-receipt.ts` | live branch shipped in #201 (pending legal review) |
| Test-mode framing in portal card forms | `app/portal/PortalPaymentMethodForm.tsx`, `PortalCardOnFileCard.tsx` | review at enablement |

### 16.3 Refund permission decision (SHIPPED)

Audit answer: before PR #201, ANY active practitioner in the studio could refund (actions checked studio membership only; `refund_initiated_by_practitioner_id` recorded the actor). The existing role model (`practitioners.role: owner | practitioner`, migration 0001) supports owner-only cleanly, so PR #201 made refunds **owner-only**, consistently across session payments, no-show fees, and late-cancellation fees: both `refundPaymentChargeAttemptAction` and `refundFeeAttemptAction` re-check `practitioner.role === "owner"` server-side and return the safe error "Only the studio owner can issue a refund." Charging and receipt sending remain any-active-practitioner. Willow impact: Chloe is the Willow owner, so her workflow (including the pending late-cancel smoke refund) is unaffected.

### 16.4 Payment audit rows decision (no new table)

Audit answer: every money movement already has a durable, queryable audit trail ON the canonical ledger row itself: `created_by_practitioner_id` + `created_at` (charge attempted), `status` + `charged_at`/`failed_at` + `stripe_payment_intent_id`/`stripe_charge_id` (charge outcome), `receipt_status`/`receipt_sent_at`/`receipt_email_to` (receipt), `refund_status`/`refunded_at`/`stripe_refund_id`/`refund_initiated_by_practitioner_id`/`refund_internal_note` (refund attempted + outcome + actor), `stripe_livemode`, `amount_cents`, `charge_reason`, studio/client/appointment/session ids. Rows are never deleted by runtime code; webhook mismatches additionally write `ops_alerts`. No card data, secrets, or raw Stripe payloads are stored. **Decision: the ledger row is the audit record for controlled enablement; a separate append-only audit_logs table is a post-live enhancement, not a blocker.**

### 16.5 Legal/accounting checklist (OPEN; needs legal/accounting review; no compliance claim is made)

Decisions required before PR #202: receipt vs invoice wording (current live draft says "Receipt", never "invoice") · HST/GST/tax wording (current draft defers to the studio; confirm whether Willow must show tax on electrolysis services in Ontario) · refund policy text shown to clients · cancellation/no-show policy enforceability of the signed acknowledgement flow · card-on-file authorization wording (consent template v-current) · statement descriptor (what appears on the client's card statement) · off-session charge authorization adequacy under card-network rules · privacy policy/Terms updates for live payment data · retention period for payment records · dispute response process + evidence template · whether payment rows must join the owner data export before live.

### 16.6 Willow / Stripe account readiness checklist (OPEN; verify in Stripe dashboard before PR #202)

- [ ] Stripe account ownership confirmed (Chloe controls the connected account; recovery email/2FA set)
- [ ] `charges_enabled`, `payouts_enabled`, `details_submitted` all true on the LIVE connected account; bank account verified
- [ ] Live keys exist but are NOT set in any Hone environment (gate stays sk_test-only)
- [ ] Statement descriptor reviewed and set
- [ ] LIVE webhook endpoint configured for the connected account + live signing secret stored (separate from test secret)
- [ ] Test/live webhook separation confirmed (test events keep flowing to the test endpoint only)
- [ ] Refund/dispute process understood by the operator (who clicks what, response deadlines)
- [ ] Operator email alerts verified working (PR #193/#195 smoke re-run within a week of enablement)
- [ ] Controlled live test card + designated internal test client selected for the $1 charge
- [ ] Rollback understood: unset env flag, redeploy; key gate re-blocks instantly

### 16.7 PR #196 fee smoke merge gate (CLEARED 2026-06-11)

Both legs are backend-verified clean and the **PR #196 fee path is fully smoke-closed**: no-show verified 2026-06-11 14:33 UTC (attempt `3c0e1c82-...`, reason `no_show_fee`, 5000c, livemode false, PI `pi_3Th9f3...`, charge/receipt/refund present, final state refunded) · late-cancellation verified 2026-06-11 17:36 UTC (attempt `b4d8ea32-...`, reason `late_cancellation_fee`, 5000c, livemode false, PI `pi_3ThCWY...` matching the practitioner screen, charge/receipt/refund present, final state refunded). Zero `manual_fee_charge_attempts` rows, zero stale ready/pending rows, zero unexpected ops alerts, zero Vercel runtime errors, gates 6/6. The PR #201 merge gate is cleared.

### 16.8 Controlled live enablement runbook

The §15 runbook is the final PR #202 runbook (all 14 steps: preconditions, smoke results, env/config, Stripe dashboard, DB, CI, enablement, $1 live charge, receipt, refund, webhook, ops alert, rollback, post-launch monitoring). **FUTURE ONLY. DO NOT EXECUTE IN PR #201.** Where §15 says PR #195/#198, read PR #201/#202.

> **Health-inspection note (PR #205, 2026-06-12):** record keeping (sterile items, disinfectants, exposure incidents, client procedure records + probe lot capture) has STARTED in Hone, built from Chloe's BodySafe sample forms. It still needs Chloe/public-health review before being relied on operationally; it is not a legal compliance guarantee. Unrelated to payments; all live-payment blockers above unchanged.
