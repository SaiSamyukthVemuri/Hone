# 14 AI handoff

**If you are an AI agent continuing work on Hone, read this first.**

## Current production status (as of PR #189)

- **Pilot-safety fixes: email claim, export gate, invite-only login** (PR #189, migration 0080). (1) The 24h/2h reminder cron now claims each row atomically via `claim_email_send` (mirror of the SMS claim from 0049: conditional UPDATE on sent-is-null + 3-attempt cap + 5-minute stale-claim window; new `confirmation/reminder_24h/reminder_2h_claimed_at` columns) before calling Resend, and records outcomes via `record_email_result` (stamps sent_at on success, clears the claim, no double-increment); overlapping cron runs can no longer double-send, and both RPCs are service_role-only. Unclaimed one-shot email paths keep `record_email_attempt`. (2) `exportStudioDataAction` is owner-only with a generic refusal, and every successful export writes a fail-closed `audit_logs` row (`studio_export`, actor, studio, filename + file list + row counts). (3) Practitioner login is invite-only at two layers: the magic-link request runs through a server action gating `shouldCreateUser` on a pending invitation (generic responses, no enumeration oracle), and migration 0081 removed `handle_new_user()`'s no-invite fresh-studio fallback so even Google OAuth (which cannot pass shouldCreateUser) provisions no studio/practitioner for uninvited users; the invited arm (inviting-studio placement + terms stamping) is unchanged. No payment, Stripe (gates unchanged from PR #187), live-mode, portal, SMS, calendar-feed, or availability change.

## Cumulative status through PR #188 (2026-06-10)

PR #188 is a docs-only cleanup; the most recent runtime change is PR #187. This section is the single current-state summary; the per-PR blocks below are the detailed history.

**Payment status:** Test-mode session payments are built end-to-end. Live payments are still blocked. Fees are not active.

**Stripe gate status** (pinned by `scripts/check-stripe-gates.mjs` + per-PR tests):

```text
paymentIntents.create   exactly 2  (lib/billing/manual-fee-charge.ts, lib/billing/session-payment-charge.ts)
refunds.create          exactly 1  (lib/billing/payment-refund.ts)
charges.create          0
checkout.sessions       0
STRIPE_ALLOW_LIVE_MODE  guarded    (string appears only in lib/stripe/server.ts error message)
```

**Completed (PRs #170-#187):**

```text
#170  Card authorization current-version gate
#171  Canonical payment_charge_attempts ledger
#172  Prepare session payment
#173  Run Stripe test charge
#174  Payment status UX
#175  Test-mode receipts
#177  Card authorization pointer refresh
#178  Test-mode refunds
#179  Webhook reconciliation
#180  Appointment completion/session-start workflow unblock
#181  Session completion to billing UI cleanup
#182  Calendar feed token hash-at-rest phase 1
#183  Portal last_seen_at fix
#184  DST two-pass conversion fix
#185  localTimeString 24:xx normalization
#186  Explicit server-only dependency
#187  Waitlist/demo public form rate limits
```

**Still open:**

```text
Live payment readiness
Legal review of card authorization wording
Tax/HST decision
Statement descriptor review
Off-session SetupIntent confirmation before live
Live runbook
Dispute response runbook
Willow live Stripe onboarding
Supervised first live charge
Late cancellation/no-show fee charging
manual_fee_charge_attempts unification/retirement
Calendar feed phase 2
Docs/launch checklist final polish
```

**Calendar feed phase 2:** Not started. A parked WIP commit exists locally (branch `claude/calendar-feed-token-hash-phase-2`, not pushed). Do not proceed until real Google/Apple calendar subscriptions are confirmed still polling cleanly after phase 1. Renumber the old parked PR/migration labels before using.

## Current production status (as of PR #187)

- **Waitlist + demo request rate limiting** (PR #187, no migration). The anonymous landing-page actions `submitWaitlistEntry` and `submitDemoRequest` previously had no rate limit. Both now route through `lib/rate-limit/public.ts` via new `limitWaitlistSubmit` / `limitDemoRequestSubmit` helpers (shared `limitMarketingForm` implementation): 5/hour per IP + 2/day per normalized email, checked after validation and before the Supabase insert, with namespaced Redis prefixes (`rl:waitlist_*`, `rl:demo_*`), SHA-256-hashed identifiers, the shared generic `RATE_LIMIT_MESSAGE` refusal copy, and the module's standard FAIL-OPEN posture on Upstash outage. No raw body or PII logging. No payment behavior change, no Stripe behavior change (gates unchanged from PR #186), no migration, no email/SMS sending, no portal or calendar feed change.

## Earlier production status (as of PR #186)

- **Explicit server-only dependency** (PR #186, no migration). `server-only@0.0.1` is now declared in `dependencies`. The 23 runtime server modules using `import "server-only"` as a client-bundle security boundary previously resolved the package only through Next's internal vendored alias; it was missing from package.json and the lockfile, so a Next upgrade could have silently weakened the boundary. No runtime behavior change intended; the Vitest stub alias is unchanged and takes precedence in tests. `tests/dependencies/server-only-explicit.test.ts` pins the declaration. No payment behavior change, no Stripe behavior change (gates unchanged from PR #185), no migration, no portal logic change, no calendar feed phase 2.

## Earlier production status (as of PR #185)

- **localTimeString hour-24 normalization** (PR #185, no migration). Some ICU builds resolve Intl's `hour12: false` to the h24 hour cycle and render hour 0 as "24" ("24:30" instead of "00:30"); the PR #184 CI run surfaced this when its runner ICU emitted 24:xx where dev machines emitted 00:xx. `lib/booking/tz.ts:localTimeString` now rewrites a leading `24:` to `00:` via a private `normalizeHour24` helper, so HH is always 00-23 on every runtime (calendar grid labels, dashboard roster, SMS templates). `tzOffsetMinutes` already guarded the same quirk numerically; `localTimeString12h` (h12 cycle) and `localDateString` (date-only) are unaffected and pinned by test; `utcInstantFromLocal` untouched. The PR #184 DST round-trip tests now exercise the production normalization directly (the test-side copy was removed). No conversion logic change, no payment behavior change, no Stripe behavior change (gates unchanged from PR #184), no migration, no new dependency.

## Earlier production status (as of PR #184)

- **DST two-pass offset correction in utcInstantFromLocal** (PR #184, no migration). `lib/booking/tz.ts:utcInstantFromLocal` previously applied a single offset correction sampled at the naive instant; when the naive and corrected instants straddle a DST transition the sample is the pre-transition offset and local times in the hours after a spring-forward jump were stored one hour late (Toronto 2026-03-08 `03:30` -> `08:30Z` -> rendered back `04:30`; `05:30` -> `10:30Z` -> `06:30`). The fix re-samples the offset at the corrected instant and re-applies when it differs. Behavior is unchanged for every wall-clock time that exists: normal days, already-correct DST-day times, and the fall-back ambiguous hour (still resolves to the first, pre-transition occurrence). Only nonexistent spring-forward gap times changed convention (now map one hour before the wall string; pinned by test). Regression suite `tests/lib/booking/tz-dst-two-pass.test.ts` covers Toronto spring-forward round-trips (03:30, 05:30, 09:00, 00:00), 23/24/25-hour day-window spans, fall-back conventions, and zero-dependency pinning. No payment behavior change, no Stripe behavior change (gates unchanged from PR #183), no migration, no new dependency, no portal or calendar feed change.

## Earlier production status (as of PR #183)

- **Client portal session last_seen_at lazy-builder fix** (PR #183, no migration). `lib/portal/session.ts:getCurrentPortalSession` previously "fired" the `last_seen_at` touch as a bare `void admin.from("client_portal_sessions").update({ last_seen_at: nowIso }).eq("id", data.id);`. Supabase/PostgREST builders are lazy thenables: without `await` or `.then(...)` no request is sent, so `last_seen_at` was never written despite the fire-and-forget comment. The fix appends `.then(onFulfilled, onRejected)` so the update actually executes while staying un-awaited (a slow touch never blocks the portal render). The fulfilled arm inspects the PostgREST `{ error }` result, the rejected arm covers transport throws; both log the sanitized structured event `portal_session_last_seen_update_failed` with only the session id, error code/message, and timestamp (no cookie token, no token hash, no email, no client PII). A failed touch still resolves the session normally. No schema change (`last_seen_at timestamptz` exists since migration 0052), no auth behavior change (hash lookup, revoked/expired checks, cookie attributes, login timing padding all untouched), no payment behavior change, no Stripe behavior change (gates unchanged from PR #182: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create`/`checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string), no calendar feed phase 2, no SMS.

## Earlier production status (as of PR #182)

- **Calendar feed token hash-at-rest, phase 1** (PR #182, migration 0079). Closes `docs/13` security backlog item "Hashed `practitioners.calendar_feed_token` | Currently stored raw" for the runtime route + future rotations without breaking existing in-the-wild feed URLs. Migration 0079 adds nullable `practitioners.calendar_feed_token_hash text` + a 64-hex-char CHECK + a partial unique on the hash + a backfill via `encode(extensions.digest(calendar_feed_token, 'sha256'), 'hex')` (pgcrypto already enabled by migration 0001; Supabase installs it under the `extensions` schema, matching the 0032 precedent). The runtime feed route `app/calendar-feed/[token]/route.ts` now hashes the URL token via the new `lib/calendar-feed/token.ts:hashCalendarFeedToken` helper and looks up by `calendar_feed_token_hash`; the raw `calendar_feed_token` column is no longer in the route's SELECT list so a database read that leaks a row to logs does not include the bearer token. `rotateCalendarFeedTokenAction` + `clearCalendarFeedTokenAction` in `app/(app)/settings/profile/actions.ts` now use the shared `generateCalendarFeedToken` + `hashCalendarFeedToken` helpers and write BOTH columns (rotate writes both; clear nulls both). The raw column is intentionally KEPT in phase 1 for rollout safety because `CalendarFeedCard.tsx` still renders the existing URL from the raw column on page render; phase 2 (a later PR) refactors the UI to display the URL only at rotation time and then nulls the raw column. Prod verified post-migration: 2 practitioners had raw tokens; both now have well-formed 64-hex hashes; zero raw-without-hash or hash-without-raw mismatches; live-mode CHECKs intact. Stripe gates unchanged from PR #181 (2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create`/`checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string). No SMS, no email, no payment behaviour change, no RLS change, no payment_charge_attempts touch.

## Earlier production status (as of PR #181)

- **Session completion to billing workflow + payment UI cleanup** (PR #181, no migration). Two surfaces touched. Calendar: new `NextStepCard` on `app/(app)/calendar/[id]/page.tsx` replaces the bare `Completed` placeholder. Renders "Appointment completed" + "Next step: chart the session and bill the client." + ONE primary CTA chosen from three states: no linked session -> `Start session` (forwards to `/clients/<id>/sessions/new?appointment_id=<id>`), linked unstarted session -> `Open session`, linked started session -> `Go to billing` (deep-links to `#session-payment` on the session page). `ChartSessionCard` is now hidden when status is `completed` so the new card owns the CTA surface (it still renders for confirmed / no_show; cancelled hides both). Session payment card cleanup (`components/session-payment-prepare-card.tsx`): (1) the stale "Session payment prepared / Attempt id: ... / No charge has been run / Refresh to see the persisted state" banner is replaced with a concise "You can now run the test charge." line gated on `!activeAttempt`, so it disappears as soon as the persisted Ready row catches up; (2) `router.refresh()` is now called after a successful prepare so the persisted ready row replaces the local banner immediately; (3) `SucceededPanel` promotes `refund_status='succeeded'` to the top heading: when refunded the panel uses the amber palette, reads "Test payment refunded.", and shows a `Refund details` block (Amount refunded / Refunded / Refund id) directly under the charge details. Receipt + Refund sub-panels continue to render below as the per-section detail; "Refund test charge" button stays hidden when `refund_status='succeeded'`. Session detail page: `<div id="session-payment">` anchor wraps the payment card so the calendar `Go to billing` deep link lands precisely on the payment surface. Receipt template: `lib/email/templates/payment-receipt.ts` `NO_REFUND_BODY_DISCLAIMER` renamed to `REFUND_AVAILABLE_BODY_DISCLAIMER` with new copy "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone." (PR #178 made test-mode refunds available; the old "Refund handling is not enabled in Hone yet." disclaimer is gone from both text and html bodies). No payment behavior change. No new Stripe call. No live mode. No migration. No SMS / client-portal / `manual_fee_charge_attempts` touch. Stripe gates unchanged from PR #180.

## Earlier production status (as of PR #180)

- **Appointment completion + session-start workflow unblock for payment smoke** (PR #180, no migration). Re-exposes the "Mark completed" button on `app/(app)/calendar/AppointmentLifecycleActions.tsx` (removed earlier per pre-payments feedback) alongside the existing Mark no-show. Same gating: `status === "confirmed"` AND `hasEnded`. Two-click `window.confirm` with the exact copy "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting." Success hint "Appointment marked completed." Primary (filled) styling so the happy path is the obvious affordance. ALSO adds `maybeMarkAppointmentCompletedOnSessionStart` in `app/(app)/clients/[id]/sessions/new/actions.ts`: after a session insert with a linked appointment, if `appointment.status='confirmed'` AND `appointment.ends_at <= now()`, the helper calls the `mark_appointment_complete` RPC via the admin client. Cancelled / no-show / completed / future appointments are explicitly skipped. Fail-soft: RPC errors are logged (`session_start_auto_mark_complete_rpc_error` / `session_start_auto_mark_complete_threw`) but never rethrown, so a failed auto-complete cannot break session start. The appointment SELECT in the action is widened from `id, studio_id, client_id, practitioner_id` to also include `status, ends_at` so the auto-complete decision is made off the same roundtrip as the lineage check. The PR #172 payment prepare gate (`appointment.status='completed'`) is unchanged. No new Stripe call, no live mode, no migration, no payment_charge_attempts change, no manual_fee_charge_attempts change, no SMS, no client-portal mutation. Stripe gates unchanged from PR #179.

## Earlier production status (as of PR #179)

- **Stripe webhook reconciliation for payment_charge_attempts** (PR #179, no migration). Adds four event handlers in `lib/billing/payment-webhook-reconciliation.ts` dispatched from `app/api/stripe/webhook/route.ts`: `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`. The existing `stripe_events` ledger (migration 0032) + `claim_stripe_event` RPC chain provide Stripe-event idempotency; no new ledger needed. Test mode only: `event.livemode === true` is a hard dormancy guard that records a warning `stripe_webhook_livemode_event_ignored` ops_alert and returns without mutation. Reason-agnostic by construction (handlers read `row.charge_reason`, never branch on it). Row-lookup order: canonical metadata `hone_payment_charge_attempt_id` → legacy `hone_session_payment_charge_attempt_id` (PR #173 backward compat) → fallback by `stripe_payment_intent_id` or `stripe_charge_id`. Metadata mismatch on studio/client/reason fires a critical `stripe_webhook_metadata_mismatch` and refuses to mutate. State-transition discipline: a row already in a terminal local state (`failed`/`cancelled`/`blocked`/`refund_status=succeeded`) is NEVER silently flipped; mismatch fires critical ops_alert (`payment_intent_succeeded_local_terminal_mismatch`, `payment_intent_failed_after_local_succeeded`, etc.). Out-of-band FULL refunds (Stripe Dashboard) are reconciled to `refund_status='succeeded'` with a warning `charge_refunded_out_of_band_reconciled`. Out-of-band PARTIAL refunds fire critical `charge_refunded_partial_out_of_band` and leave the row alone (v1 schema cannot represent partial). Disputes are alert-only (`payment_charge_dispute_created`); no automated response. Stripe gates unchanged: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create`, zero `charges.create` / `checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string. The webhook helper itself imports `recordOpsAlert` and `createAdminClient` only; it does NOT import `getStripe` (no SDK access from the reconciliation module). No SMS, no email, no client-portal mutation, no `manual_fee_charge_attempts` touch, no migration.

## Earlier production status (as of PR #178)

- **Reason-agnostic test-mode refunds on payment_charge_attempts** (PR #178, migration 0078). Adds nine nullable refund columns to `public.payment_charge_attempts` + a single allowlisted `refunds.create` call site in `lib/billing/payment-refund.ts` + a `RefundSubPanel` inside `SucceededPanel` only. Reason-agnostic by construction: the helper records `charge_reason` as Stripe-refund metadata and never branches on the value, so a future `late_cancellation_fee` / `no_show_fee` row refunds with no code change. v1 is full-refund only (`refund_amount_cents = amount_cents`); one refund per attempt enforced by partial unique on `stripe_refund_id`. Triple dormancy guard: `inferStripeLivemode()` short-circuit at entry, `payment_charge_attempts_livemode_false_check`, conditional UPDATE claim requires `status='succeeded' AND stripe_livemode=false AND (refund_status IS NULL OR refund_status='failed')`. Deterministic idempotency key `hone:payment_refund:<attemptId>:v1` + partial-unique `payment_charge_attempts_refund_idempotency_uniq`. Stripe gates: 2 allowlisted `paymentIntents.create`, 1 allowlisted `refunds.create` (`lib/billing/payment-refund.ts`), zero `charges.create` / `checkout.sessions`, 1 allowlisted `STRIPE_ALLOW_LIVE_MODE=true` string. UI uses two-click confirm with the amount in the second button; forbidden copy ("Live refund", "Refund complete", "Money returned", "Official refund receipt") pinned absent by negative source-grep tests. Migration 0078 applied to prod before merge; live-mode CHECKs intact. No webhook handling of `charge.refunded` (out-of-band Stripe-dashboard refunds NOT reconciled). No dispute automation. No refund receipt email. No SMS. No client-portal refund surface. No `manual_fee_charge_attempts` touch (the legacy 0032 `stripe_refunds` tables remain dormant; PR #178 ships refund state ON `payment_charge_attempts` directly).

## Earlier production status (as of PR #177)

- **Card authorization pointer refresh + tightened charge gate** (PR #177, migration 0077). Closes the `docs/16` §5.11 audit-trail gap surfaced in PR #176. Three pieces ship together: (1) `lib/payment-methods/refresh-card-authorization-pointer.ts` is called from `app/portal/consent-actions.ts` after a successful `card_authorization` signature insert; it updates active, non-removed `client_payment_methods` rows for `(studio_id, client_id, stripe_livemode=inferStripeLivemode())` to `card_authorization_signature_id = newSignatureId`. Fail-soft (critical `card_authorization_pointer_refresh_failed` ops_alert; never rolls back the signature). (2) Migration 0077 backfills existing prod rows; idempotent via `IS DISTINCT FROM`; scoped strictly by studio/client/livemode/status='active'/removed_at IS NULL/signature.template_version=template.version. NOTICE confirms row count. Applied to prod 2026-06-08; 1 row updated (the known Sai @ My Studio case); known row pointer went `a6b1fdbe-…0dd4` → `cd3af5cb-…a278`. (3) `getChargeReadyCardAuthorizationStatus` (new in `lib/consent/current-card-authorization.ts`) wraps the base PR #170 helper, adds the card-row pointer-equality check, returns the existing four variants plus `signed_current_but_card_pointer_stale`. Wired into session payment PREPARE eligibility + session payment EXECUTE recheck; remedy copy "Client must re-sign the current card authorization for the card on file." Critically, the charge-only helper is NOT used by `app/portal/consent-actions.ts` (re-sign), `app/portal/payment-method-actions.ts` (Add Card / Replace Card), or `lib/billing/manual-fee-eligibility.ts` (which already gates on the card row pointer); the deadlock-prevention contract is enforced both by code and by tests. Live-mode CHECKs (`manual_fee_charge_attempts_livemode_false_check`, `payment_charge_attempts_livemode_false_check`) verified intact post-migration. PR #175 receipt smoke can now resume against the repaired row. No new Stripe call, no live mode, no refund, no receipt-behavior change beyond eligibility unblock, no SMS, no client-portal payment UI expansion, no manual_fee runtime touch.

## Earlier production status (as of PR #175)

- Production domain: `https://hone.care`.
- Default branch: `claude/build-hone-saas-hOex7`. Every push to it triggers a production deploy. Vercel project: `prj_pJUjs6ImP01FBPqrZyiJRpbpJ2mk`, team `team_Pwj27KsmnBKe3ZUBfKLcFczf`.
- At least 71 migrations applied. Most recent in-tree: `0071_thermolysis_duration_decimal.sql`. The next migration is `0072`. Always double-check the highest file in `supabase/migrations/` before assuming the count.
- Practitioner notification center (PR #164, migration 0070) records business events (`new_booking`, `appointment_cancelled`, `appointment_rescheduled`) into `public.practitioner_notifications`. Writes happen via the server-only `lib/notifications/practitioner-notifications.ts:recordPractitionerNotification` helper (admin/service-role client, never-throws fire-and-forget IIFE; a notification failure cannot roll back the booking / cancel / reschedule that just committed). Reads + mark-all-read happen via the authenticated RLS client on `/notifications`. Visibility is studio-wide in v1; `practitioner_id` is stored for future per-practitioner filtering. Separate from `ops_alerts` (which is the operator surface for system failures, PR #153).
- Thermolysis duration is fractional (PR #165, migration 0071). `electrolysis_entries.thermolysis_duration_seconds` is `numeric` (was integer in migration 0042). The form input uses `step="0.01"` + `inputMode="decimal"`; the read view routes through `lib/sessions/format-seconds.ts:formatSeconds` which yields `"0.15 seconds"` / `"1 second"` / `"2 seconds"`. Only the thermolysis column was widened; galvanic_duration_seconds and intensity_percent fields stay integer.
- Portal magic-link expiry is **60 minutes** (PR #166, raised from 30 minutes). The TTL constant `MAGIC_LINK_TTL_MS` lives in `app/portal/login/actions.ts` and is the single source of truth; the email body copy ("This link expires in 1 hour.") in `lib/email/templates/portal-magic-link.ts` is pinned by `tests/lib/email/portal-magic-link.test.ts`. No migration. The GET/POST split-consumption model (PR #142), the single-use atomic UPDATE on `consumed_at IS NULL`, and the 7-day portal session cookie TTL are all unchanged. PR #166 also flipped the portal-header right cluster from `flex-col items-end` to `flex-row items-center` so Sign out sits visibly at top-right next to the Email <studio> button instead of stacked below it.
- **Reason-agnostic test-mode receipt path** (PR #175, migration 0076). Adds the receipt-state columns to `public.payment_charge_attempts` and ships `lib/billing/payment-receipt.ts:sendPaymentChargeReceipt` + `lib/email/templates/payment-receipt.ts:buildPaymentReceiptEmail` (uses the existing `sendEmailSafely` helper from `lib/email/send-appointment.ts`). The helper is reason-agnostic: today only `session_payment` succeeded rows exist, but `late_cancellation_fee` and `no_show_fee` rows will work without code changes. UI: new `ReceiptSubPanel` inside `SucceededPanel` reads `receipt_status` from the persisted row so the already-sent / failed / sending states survive page refresh; a Send test receipt button appears only when status is null or failed. Atomic dedup via conditional UPDATE on `receipt_status IS NULL OR receipt_status = 'failed'` → `'sending'`. Subject "TEST MODE receipt from <studio>: <reason> $X.XX CAD". Body carries three disclaimers ("This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", "Refund handling is not enabled in Hone yet."). No auto-send from `runSessionPaymentCharge` -- the spec is explicit. No new Stripe call. No live mode. No refund. No SMS. No client-portal change. No manual_fee touch. Forbidden copy ("Pay now", "Send invoice", "Tax receipt", "Official invoice", "Payment complete", "Live payment") absent from the receipt surface, pinned by negative source-grep tests. Migration ledger advanced to 0076.
- **Session payment UX hardening** (PR #174, no migration). `SessionPaymentPrepareCard` refactored so every post-refresh state renders rich detail driven by the persisted `payment_charge_attempts` row. New `AttemptStatusPanel` dispatcher switches on `attempt.status` and returns one of `ReadyPanel` / `PendingPanel` / `SucceededPanel` / `FailedPanel` / `CancelledPanel` / `BlockedAttemptPanel` (mirrors `ManualFeeChargeCard.tsx` precedent). `SessionPaymentExistingAttemptSummary` widened to carry `stripePaymentIntentId / stripeChargeId / chargedAt / failedAt / failureCode / failureMessageSafe`; `getSessionPaymentEligibility` SELECT widened accordingly. `SucceededPanel` displays the PaymentIntent + Charge ids + charged-at timestamp + explicit "Stripe test-mode charge. No live card was charged. No receipt was sent in this PR." `FailedPanel` displays the sanitised failure message + failure code + failed-at + PaymentIntent id with "Prepare a new session payment attempt" guidance. `STATUS_LABEL` map updated to reflect post-PR-#173 reality (`ready: "Ready (test mode)"`, `succeeded: "Succeeded (test mode)"`, `failed: "Failed (test mode)"`, `pending_stripe: "Pending Stripe (test mode)"`). Forbidden copy ("Pay now", "Charge card", "Collect payment", "Payment complete", "Live payment", "Receipt sent") absent from actionable JSX (pinned by negative source-grep tests). No new Stripe call. No webhook change. No SMS / email. No client-portal change. No migration. Migration ledger remains 0075.
- **Session payment EXECUTE flow** (PR #173, migration 0075, test mode only). Adds `lib/billing/session-payment-charge.ts:runSessionPaymentCharge`, a faithful port of `runManualFeeCharge` adapted for `payment_charge_attempts`. Stripe gate script + live-mode-blocker test updated to allow exactly 2 allowlisted `paymentIntents.create` call sites (`lib/billing/manual-fee-charge.ts` + the new file). Migration 0075 adds the atomic claim RPC `claim_session_payment_charge_attempt` (mirror of 0065's manual fee RPC). Execution flow: live-mode early return -> attempt + reason + livemode-row guards -> PR #170 current-card-authorization recheck (signature id must still match the stamped value) -> lineage recheck -> claim RPC (status='ready' -> 'pending_stripe' + deterministic idempotency key `hone:session_payment:<attemptId>:v1`) -> `paymentIntents.create({amount, currency: 'cad', customer, payment_method, confirm: true, off_session: true, description, metadata}, {stripeAccount, idempotencyKey})` -> write succeeded (PI id, charge id, charged_at) or failed (sanitised failure_code + failure_message_safe + failed_at + ops_alert). No `application_fee_amount`, no `receipt_email`, no `statement_descriptor_suffix`. UI: new "Run test charge" button on `SessionPaymentPrepareCard`'s existing-attempt branch with a two-click confirm + clear test-mode disclaimer; no "Pay now" / "Charge card" label. No live mode. No receipt. No refund. No webhook business logic added. No SMS / email. manual_fee_charge_attempts runtime untouched. Per-file `paymentIntents.create` count: 1 in each of the two allowlisted files; `STRIPE_ALLOW_LIVE_MODE=true` still 1 in `lib/stripe/server.ts` only.
- **Session payment PREPARE flow** (PR #172, test mode only). The session detail page (`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx`) now renders a `SessionPaymentPrepareCard` after `SessionInfoCard`. The card resolves eligibility via `lib/billing/session-payment-eligibility.ts:getSessionPaymentEligibility` and dispatches between blocked / existing-attempt / ready states. The action `prepareSessionPaymentChargeAction` writes one row to `public.payment_charge_attempts` with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`, the practitioner-confirmed amount, the active card's lineage, and the PR #170 `signed_current` `card_authorization_signature_id`. The chargeability proxy (no `sessions.completed_at` column exists today) is `sessions.appointment_id IS NOT NULL AND appointments.status='completed' AND sessions.started_at IS NOT NULL`. NO Stripe call. NO PaymentIntent. NO charge. NO webhook. NO SMS. Duplicate protection via PR #171's `payment_charge_attempts_active_session_payment_uniq` partial unique + a 23505 catch in the action. UI explicitly does not render any "Pay now" or "Charge card" button; the disclaimer reads "This prepares a test-mode payment record. It does not charge the client." manual_fee_charge_attempts runtime fully untouched.
- **Canonical `payment_charge_attempts` ledger** (PR #171, migrations 0073 + 0074). Dormant: 0 rows in production. First writes land in PR #181 (test mode only) for `session_payment`. Schema covers all three charge reasons (`session_payment`, `late_cancellation_fee`, `no_show_fee`); status enum mirrors `manual_fee_charge_attempts` exactly (no parallel state machine); amount_cents bounded `> 0 AND <= 200000` ($2,000 CAD vs manual_fee's $200, intentionally larger for full session amounts); `payment_charge_attempts_livemode_false_check` is the named dormancy guard the future live-enablement PR drops deliberately; `payment_charge_attempts_reason_shape_check` enforces session_payment-requires-session_id (appointment_id OPTIONAL so a future freeform-session charge does not need a relax migration) AND cancellation/no-show-requires-appointment_id-and-forbids-session_id; `card_authorization_signature_id` nullable in this dormant PR (execution PR #181 must refuse to charge unless `lib/consent/current-card-authorization:getCardAuthorizationStatus` returns `signed_current` AND stamps the matching signature id); FK ON DELETE rules audited (studio CASCADE; client/appointment/practitioner composite RESTRICT; session_id RESTRICT after corrective 0074 -- initial 0073 declared SET NULL but that contradicted the reason_shape_check requiring session_payment rows to have non-null session_id; signature/payment_method RESTRICT); 12 secondary + 4 partial-unique indexes (idempotency, stripe_payment_intent, active-fee-per-appointment, active-session_payment-per-session) match manual_fee's three-layer duplicate-protection pattern; RLS enabled with studio-member SELECT only, no INSERT/UPDATE/DELETE policy, service-role admin owns mutations. **TEMPORARY TWO-TABLE STATE:** `manual_fee_charge_attempts` remains the runtime test-mode ledger; runtime fee charging must be migrated or unified onto `payment_charge_attempts` BEFORE live `late_cancellation_fee` or `no_show_fee` charging ships (see docs/13 + docs/16 §12.5b for the dated checkpoint + gate language).
- **Card authorization current-version re-sign gate** (PR #170). The product-ready DRAFT body lives at `lib/consent/card-authorization-draft.ts:CARD_AUTHORIZATION_DRAFT_V1_BODY` (around 2.5 kB; covers card on file, completed-session off-session charges, late cancellation, no-show, receipts/refunds/disputes, payment processing + privacy, scope + revocation; explicit "does not waive my dispute rights" line; no legal-approval claim). The shared helper `lib/consent/current-card-authorization.ts:getCardAuthorizationStatus` returns one of four kinds (`no_live_template` / `unsigned` / `signed_out_of_date` / `signed_current`); `createCardSetupIntentAction` refuses unless `signed_current`; `manual-fee-eligibility.ts` performs the same comparison inline. Portal page renders a new "Card authorization was updated" block when out-of-date; the practitioner `PaymentMethodCard` renders `AuthorizationOutOfDateBlock` (no card) or `AuthorizationOutOfDateWarning` (active card present). The unsignedConsentTemplates filter special-cases card_authorization so re-signing reuses the existing Review and sign UI; other consent types do NOT force re-sign on every edit. No migration. No production data change in this PR -- the operator step (Chloe pastes the body via Settings -> Consent forms, which bumps version 1 -> 2 via the existing updateConsentTemplateAction) is documented in docs/05; until then existing "test" signatures continue to satisfy version=1 and nothing visible changes for current clients.
- **Session payment product model defined** (PR #169, docs + guardrails only). [docs/16 §12](./16_LIVE_PAYMENTS_READINESS.md#12-session-payment-product-model-pr-169) carries the v1 model: charge AFTER the session with a practitioner-confirmed amount (no auto-charge from `services.price_cents` or duration), one charge primitive parameterized by `charge_reason` (`session_payment` / `late_cancellation_fee` / `no_show_fee`), off-session SetupIntent already satisfied at `lib/stripe/setup-intent.ts:202`, 0% Hone platform fee in v1, no tax calculation, paid status derived from charge rows (no boolean), studio is merchant of record, risk-ordered enablement (session_payment ships live first, then cancellation, then no-show). The PR sequence in docs/16 §11 + §12.13 was renumbered: PR #169 is the product model, PR #170 is the legal review of `card_authorization` wording (was original PR #169), and the session_payment build PRs are #179 to #183. No schema commitment yet (separate table vs unified table with reason enum); the schema PR's own audit decides.
- **Live payments are NOT enabled.** PR #168 is a docs + guardrails-only readiness review concluding **NOT READY FOR LIVE PAYMENTS**. Three independent dormancy guards remain in place: (1) `lib/stripe/server.ts` rejects `sk_live_` keys unless `STRIPE_ALLOW_LIVE_MODE=true`; (2) `lib/billing/manual-fee-charge.ts:runManualFeeCharge` short-circuits with `outcome: "live_mode_blocked"`; (3) migration 0065 adds `CHECK (stripe_livemode = false)` on `manual_fee_charge_attempts`. The full readiness doc + 9-PR unblock sequence lives at [docs/16_LIVE_PAYMENTS_READINESS.md](./16_LIVE_PAYMENTS_READINESS.md). The "Test mode only" UI copy in 7 locations across the portal + practitioner surfaces survives PR #168 deliberately; PR #170 will remove it as part of the live-mode-enablement track. Willow's `card_authorization` template is still titled `"test"` (not legally reviewed); PR #169 covers the legal review.
- Consent templates have a **Live in client portal** control separate from the practitioner-facing `status` enum (PR #167, migration 0072). `consent_form_templates.is_live boolean NOT NULL DEFAULT false`; backfilled to `is_live = (status = 'active')` to preserve pre-migration portal visibility. DB CHECK constraint `(NOT is_live OR status = 'active')` guarantees a draft / archived row can never be live. The portal query in `lib/consent/queries.ts:getActiveConsentTemplatesForPortal` filters `is_live=true AND status='active'` (defense-in-depth); the portal Add card flow in `app/portal/payment-method-actions.ts` and the sign action in `app/portal/consent-actions.ts` apply the same two-clause gate. `createConsentTemplateAction` forces `status='draft'` and `is_live=false` on insert; `setConsentTemplateStatusAction` auto-sets `is_live=false` when moving to draft or archived; a new `setConsentTemplateLiveAction` is the only path to `is_live=true` and pre-flights the requirement that the row be active first. The `Settings -> Consent forms` UI gained a `Live` / `Draft` badge per row and a `Make live in client portal` / `Hide from client portal` button. Historical `client_consent_signatures` are untouched; the "Completed forms" portal surface reads signatures directly without joining the templates table. Audience targeting (per-modality / per-service / new-vs-existing-client) is deferred to a future PR. No payment / live-mode / SMS / RLS change.
- Client profile (`app/(app)/clients/[id]/page.tsx`) Sessions tab leads with an Appointments timeline (PR #157) that groups every appointment into Upcoming / Needs charting / Charted / Cancelled / No-show with per-row Chart / View / Open affordances. The query helper is `getAppointmentsForClientProfile` (`lib/supabase/queries.ts`); the component is `components/client-appointment-timeline.tsx`. No service role.
- Portal card-on-file section (PR #158) renders one of four explanatory states (no template configured / authorization needed / signed but no card / active card) with a deep-link `#forms-to-sign` from the "Card authorization needed" placeholder to the existing "Review and sign forms" block. Matching practitioner-side `PaymentMethodCard` on the client profile renders the same four branches with practitioner-actionable copy. Manual fee blocked-reason strings (`lib/billing/manual-fee-eligibility.ts`) updated to tell the practitioner exactly what to ask the client to do next. No new schema, no new RPC, no new payment behavior.
- Portal layout (PR #159) replaces the legacy "Your info" wrapper with four top-level sections (Appointments / Care instructions / Forms and records / Payment method). Header now carries an `Email <studio>` contact button next to Sign out. Care instructions render `<details open>` so the client sees them without clicking. "Signed forms" renamed to "Completed forms" with quiet border-top divider styling so the rows do not read as actionable. PR #158 card-authorization guidance preserved and verified by existing tests.
- Pre-appointment instructions (PR #160) are studio/service-owned via the existing `services.pre_care_instructions` field (migration 0025), edited from `Settings → Services`. The same field feeds the booking confirmation email, both reminder emails, AND the portal Care instructions section. The prior hardcoded "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph was removed from `lib/email/templates/appointment.ts`; empty prep text now omits the block entirely. No migration; no payment / SMS / public-route behavior change.
- Charting terminology (PR #162). The `session_blocks.side` value `bilateral` now renders as `"Both sides"` everywhere (Chloe's charting feedback); the stored enum, the migration 0039 CHECK constraint, and the server validation array all keep the canonical `bilateral` lowercase value. Label mapping lives in `lib/sessions/side-labels.ts`; both `block-setup-form.tsx` and `session-blocks-view.tsx` read from it. Thermolysis input order in the block editor is now `Duration -> Intensity -> Pulse count` (was `Intensity -> Duration -> Pulse count`) to match Chloe's machine; persisted column names (`thermolysis_duration_seconds`, `thermolysis_intensity_percent`, `pulse_count`) are unchanged. No data migration.
- Booking referral attribution (PR #163, migration 0069). Public booking form asks "How did you hear about us?" with seven canonical options (Google / Instagram / Friend or referral / Existing client / Studio website / Other / Prefer not to say). Answer stored on the nullable `appointments.referral_source` text column; no CHECK constraint at the DB layer (option set enforced at the action layer in `lib/booking/referral-source.ts`). Practitioner sees the value on the calendar appointment detail page and in the new-booking notification email; client-facing surfaces (confirmation email, reminder emails, portal) deliberately do not surface it. v1 is appointment-level only.
- Card-on-file and test-mode manual fee charge are live in production **test mode**. Live mode is blocked by three independent guards.
- GitHub Actions CI (PR #154) runs typecheck, lint, build, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR and push to default. `npm run ci` is the local shortcut. A red CI check blocks merge.
- Ops alerts (PR #153, migration `0067_ops_alerts.sql`) capture silent failure states for the manual-fee path, Stripe webhook, SMS path, and the appointment-reminder cron. The SMS path stamps `studio_id` on alerts as of PR #155.
- Sessions can be explicitly linked to appointments via `sessions.appointment_id` (PR #156, migration `0068_sessions_appointment_link.sql`). Write-forward is partial: appointment-context flows stamp the FK, client-scoped session creation remains null. Historical sessions remain null; no backfill has been run. The dedup site in `lib/supabase/queries.ts:getPastConfirmedAppointmentsForClient` prefers the explicit link and falls back to the `+/- 2 hour` heuristic only for unlinked sessions.

## Branch / PR / deploy workflow

1. Branch off `claude/build-hone-saas-hOex7` with a short descriptive name.
2. Build, validate locally:
   ```bash
   npm run typecheck
   npm run lint
   npm run build
   npm test
   npm run check:stripe-gates
   git diff --check
   # or as one command:
   npm run ci
   ```
3. Commit as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>` (the Vercel author gate requires this).
4. Push. Open a PR with the `.github/pull_request_template.md` checklist filled honestly.
5. STOP. Do not merge until reviewed.
6. On review approval: `gh pr merge <N> --merge`.
7. Poll the Vercel commit status:
   ```bash
   gh api "repos/SaiSamyukthVemuri/Hone/commits/<sha>/status" --jq '.state'
   ```
8. When `state=success`, confirm `READY` via Vercel MCP `get_deployment`.
9. Report merge SHA, deployed SHA, production status, any check failures.
10. Run the post-deploy smoke that you CAN do from a non-authenticated harness. Clearly say what could not be verified.
11. Do not start another PR until the deploy is `READY`.

## What not to touch casually

The list of high-risk areas. Each has a doc you MUST read before changing anything in it.

| Area | Doc | Why high-risk |
|---|---|---|
| Stripe / payment / live mode | [docs/06](./06_PAYMENTS_AND_STRIPE.md) | Money. Live charging is blocked by three independent guards; do not weaken any of them. |
| Token routes (`/cancel`, `/reschedule`, `/manage`, `/intake`, `/portal/verify`, `/calendar-feed`) | [docs/03](./03_SECURITY_AND_PRIVACY.md) | Token IS the credential. No analytics. noindex + no-referrer headers. |
| Portal session / magic link / `client_portal_magic_links` | [docs/03 §3](./03_SECURITY_AND_PRIVACY.md#3-portal-session-model) | The GET on `/portal/verify/<token>` is deliberately non-consuming. POST consumes. Do not flip this. |
| Manual fee `paymentIntents.create` | [docs/06](./06_PAYMENTS_AND_STRIPE.md), [docs/13](./13_BACKLOG_AND_DECISIONS.md) | The single allowed occurrence. Do not delete. Do not add a second. |
| RLS policies + `SECURITY DEFINER` RPCs | [docs/09](./09_DATABASE_AND_RLS.md) | Trust boundary. |
| Service-role client usage | [CONTRIBUTING.md](../CONTRIBUTING.md) | Never in `"use client"`. Never to bypass RLS as a convenience. |
| Analytics mount points | [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142) | Root layout MUST NOT mount Analytics. Safe trees opt in. |
| `ADMIN_EMAILS`, `NEXT_PUBLIC_APP_ORIGIN`, `PORTAL_FINGERPRINT_SALT` fail-closed behavior | [docs/03 §7](./03_SECURITY_AND_PRIVACY.md#7-production-config-fail-closed-pr-143) | Production with missing values fails closed deliberately. |

## Payment safety rules (non-negotiable)

- **No live charges** unless `STRIPE_ALLOW_LIVE_MODE=true` AND a deliberate live-mode PR is open AND the `manual_fee_charge_attempts_livemode_false_check` constraint has been deliberately replaced AND the [docs/06 §9 checklist](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) is complete.
- **No automatic / batch / background / public-triggered charge.** Charging is one manual practitioner click on a `ready` attempt.
- **No platform customer / platform PaymentMethod.** Every Stripe call must carry `{ stripeAccount }`.
- **No raw card / CVC / `client_secret` storage.**
- **No blind retry past the 60-minute reconciliation window.** Stripe idempotency is a 24-hour belt; the action's 60-minute window is the suspenders. Past that window, return `needs_manual_review`.

## PR review pattern

When reviewing a PR:

1. Read the PR template. Refuse to review further if the checklist is empty or dishonest.
2. Read the migrations (if any). Confirm RLS posture, grants, `search_path`, additive shape.
3. Read the diff for the search gates:
   ```bash
   git diff | grep -E '^\+' | \
     grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'
   ```
4. Confirm no new Stripe SDK imports outside the existing helper.
5. Confirm the migration was applied to prod BEFORE the code references it.
6. Confirm docs are updated per [docs/15](./15_DOCS_MAINTENANCE.md).
7. Confirm the PR body lists what could not be verified.
8. Stripe-touching PRs: confirm idempotency, claim-then-act, evidence recheck, lineage recheck, test-mode gate.

## Standard validation commands

```bash
npm run typecheck
npm run lint
npm run build
npm test
git diff --check
npm run check:stripe-gates
```

Or `npm run ci` to run all six in sequence. All must pass before pushing. The Vercel preview deploy must reach `READY` before merge.

GitHub Actions runs the same six steps automatically on every PR and on every push to the default branch (`claude/build-hone-saas-hOex7`). See `.github/workflows/ci.yml`. A red CI check is a hard merge block. CI does NOT replace manual smoke; browser / Stripe Elements / real-send paths still need a human against the live deploy.

## Grep gates (current)

```
charges.create:                       zero
checkout.sessions:                    zero unless explicit Checkout PR
refunds.create:                       zero unless explicit refund PR
set_studio_require_card_on_file:      zero unless explicit card-required booking PR
STRIPE_ALLOW_LIVE_MODE=true:          zero unless explicit live-mode PR

paymentIntents.create:                exactly one occurrence allowed today:
                                      lib/billing/manual-fee-charge.ts

                                      Any new paymentIntents.create
                                      occurrence is high-risk and must be
                                      explicitly reviewed.
```

The current `paymentIntents.create` path is **test-mode-only manual fee charging**. It is behind:

- practitioner auth
- `getManualFeeChargeEligibility` evidence recheck
- `loadCardAndVerifyLineage` lineage recheck
- `claim_manual_fee_charge_attempt` RPC (`FOR UPDATE`, conditional UPDATE, idempotency key stamp in one transaction)
- deterministic idempotency key `hone:manual-fee:<attempt_id>:v1`
- connected-account context `{ stripeAccount }`
- `inferStripeLivemode()` test-mode gate
- `manual_fee_charge_attempts_livemode_false_check` DB CHECK

**Never live without an explicit live-mode PR.** A live-mode PR must add stronger stale-pending reconciliation (Stripe `paymentIntents.search` by metadata before retry) and must deliberately alter or drop the `livemode_false_check` constraint after review.

## Merge discipline

- One PR per logical change. Do not mix schema + product behavior + security in one PR.
- Migrations apply to prod BEFORE the code PR merges.
- The PR description is the contract; if it does not match the diff, the reviewer rejects it.
- Em-dashes in added lines: zero. Use plain hyphens or colons.
- Commits authored as `SaiSamyukthVemuri <samyukth.ssv@gmail.com>`.

## How to write prompts for future PRs

Useful patterns:

- State the goal first. Then state non-goals. Then the acceptance criteria.
- Always include the validation list (typecheck / lint / build / diff-check) and the grep gates.
- Always include "Do not merge until reviewed."
- Include the SQL the reviewer can run to verify state after merge.
- Include the explicit "what could not be verified" list.

## How to review PRs

- Read the diff before the description.
- Match every claim in the description to a line in the diff.
- If the description says "no schema change" and the diff shows a migration: stop.
- If the description says "no Stripe behavior change" and the diff adds a Stripe SDK import: stop.
- If docs are not updated for a behavior-changing PR: stop.
- Re-run the smoke against a preview deploy where possible.

## Current non-negotiables

Repeat the list in the PR you open, every time:

- Author commits as SaiSamyukthVemuri <samyukth.ssv@gmail.com>
- Zero em-dashes in added lines.
- Apply additive migration to prod BEFORE merging code that references new columns.
- "Do not merge until reviewed."
- "Do not start the next PR until deploy is READY."
- Stripe dormancy: no charges, no `require_card_on_file=true`, no live-mode enable, exactly one `paymentIntents.create`.
- Grep gates: `paymentIntents.create` (allowed only in `lib/billing/manual-fee-charge.ts`), `charges.create`, `refunds.create`, `checkout.sessions`, `set_studio_require_card_on_file`, `STRIPE_ALLOW_LIVE_MODE=true`. Enforced by `scripts/check-stripe-gates.mjs` + the `npm run check:stripe-gates` script in CI (PR #154). The `STRIPE_ALLOW_LIVE_MODE=true` rule allowlists `lib/stripe/server.ts` because the string appears in an operator-facing error message there, NOT as a code path that flips the flag.
- **CSP discipline (PR #150).** The global CSP in `next.config.ts` (via `lib/security/headers.ts`) is the single source of truth. Any new third-party browser integration MUST extend the CSP source lists in the same PR. Never weaken `frame-ancestors 'none'` or `X-Frame-Options: DENY`. Never add wildcard `*`. Never add Sentry domains unless that PR actually installs Sentry. Token routes keep `Referrer-Policy: no-referrer`.
- **Ops alert hygiene (PR #153).** `lib/ops/alerts.ts:recordOpsAlert` is the single entry point for silent-failure alerts. NEVER throw from the helper to the caller; DB failures are swallowed and surface only as additional structured logs. NEVER put raw tokens / `client_secret` / Stripe secret keys / card data / CVC / API keys in `safe_details`; the helper has a defensive redactor but the contract is "the caller already redacted". **The helper MUST NOT import `lib/email/send-appointment.ts` or any module that imports it.** Operator email is intentionally deferred; the same module observes the email subsystem and cycling back through it (even with a loop guard) is avoidable. A future PR may add a standalone `lib/ops/alert-email.ts` that uses Resend directly. New silent-failure surfaces should reuse the helper and a stable event name (`<surface>_<state>`).

## If you find yourself wanting to…

- **Add a new `paymentIntents.create`:** stop. Read [docs/06](./06_PAYMENTS_AND_STRIPE.md). The only legitimate new call site is a live-mode PR that satisfies the [docs/06 §9](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) checklist.
- **Use `createAdminClient` in a client component:** stop. Move the logic to a server action.
- **Mount Analytics on `app/layout.tsx`:** stop. See [docs/03 §6](./03_SECURITY_AND_PRIVACY.md#6-analytics-privacy-pr-142). Mount on the safe-tree layout instead.
- **Add a wildcard `*` to the CSP, weaken `frame-ancestors`, or add Sentry domains "just in case":** stop. Read [docs/03 § Global browser security headers](./03_SECURITY_AND_PRIVACY.md). The CSP is the single source of truth and additions require explicit review.
- **Trust a `studio_id` / `client_id` / `appointment_id` from formData:** stop. Resolve from the session or from the token.
- **Add `process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care"`:** stop. Use `getRequiredAppOrigin()` from `lib/app-origin.ts`. PR #143 removed every silent fallback.
- **Skip a doc update because "the PR is small":** stop. The doc update is part of the PR.

## What was not verified by the agent in PR #148

This documentation overhaul is itself a docs-only PR. I did NOT:

- Run any new code paths.
- Apply any new migrations (no schema change in this PR).
- Send any email or SMS.
- Trigger any Stripe call.

The validation gates that DID run: `typecheck`, `lint`, `build`, `git diff --check`, em-dash count, and a grep for stale `hone.studio` references. Each doc was cross-referenced against the actual code, migrations, and PR template at the moment of writing (PR #147 just merged; the deployed SHA was `3ab714f`).

Where a doc references a behavior, the citation is the PR number and the migration number so a future reviewer can spot-check by reading the migration or the action file directly.
