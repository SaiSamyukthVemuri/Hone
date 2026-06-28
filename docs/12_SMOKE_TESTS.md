# 12 Smoke tests

This is the catalogue of manual smoke tests every operator and reviewer should know how to run. Some can be executed from a curl loop; many require an authenticated practitioner session and a real test appointment and cannot be done from CI or from an AI harness.

Use [docs/11 Runbook](./11_RUNBOOK.md) for the SQL recipes referenced below.

> Schema-only note (PR #252, migration 0089 — Imported Treatment Memory): there is NO manual smoke for this PR because it adds NO UI surface (schema + read-model only: `import_batches`, `imported_treatment_memories`, `imported_treatment_memory_audit_events`, plus the `lib/imported-treatment-memory.ts` read helper). Its proof is automated: the DB/RLS integration lane (`tests/db/imported-treatment-memory.db.test.ts`, 18 tests) verifies owner-only writes, member reads, cross-studio isolation, no hard delete, soft-void, and the append-only audit trail on the real migrated database; the generated-types drift check verifies the curated types match the new tables; `tests/migrations/0089-*` pins the migration shape. Post-migration production verification (run the read-only isolation probes in docs/20 §3 against the new tables) is part of the migration-first rule, not a UI smoke.

## 0. Marketing homepage smoke (PR #242, tightened PR #243, human rewrite PR #244, visual density follow-up, visual system PR #246, comparison + proof polish PR #247, mature-SaaS polish PR #248)

The public homepage (`/`) is positioned around treatment memory; after PR #244 the copy is plain, human, and practitioner-first, with the public category phrase **"Treatment memory for electrologists."** PR #246 added a visual system for vertical-SaaS polish (Jane as a benchmark, not copied): an app-window chrome frame on the **hero** ("Demo Studio · Today") and on the **Before Today** centerpiece ("Before Today · Maya R."); a "Review Before Today" action on the Daily prep mockup; and faint alternating band backgrounds for rhythm. PR #247 made the **proof strip** a contained, edge-faded **marquee ticker** ("Built with working electrologists" … "Founder-led setup", no fake testimonials/logos/usage numbers) that must NOT cause horizontal page overflow at any width and stops scrolling under reduced-motion, and rebuilt the **Calendar-vs-Hone** comparison into two product-style cards. PR #248 matured the page further: the proof-strip items are now white **pills** (slower marquee); the **Calendar-vs-Hone** cards now sit in `AppWindow` chrome ("Calendar-only" / "Hone" title bars) — a limited appointment card (Appointment data: 10:00 AM / Maya R. / Electrolysis / Confirmed) and a treatment-memory card (Treatment memory) echoing Before Today (Remember-today band, Last-recorded chips Upper lip · Sterex · Lot L-204, Tolerance 4/5 · Mild redness, "Aftercare not marked last session"); the band tones strictly alternate; and the **Privacy & Trust** section is now a two-column claim-plus-compact-checklist card (all five claims in ONE card + the privacy-policy link), replacing the old awkward five-card 3+2 grid (stacks cleanly on mobile, no empty card grid). The **Records** section shows a printable Procedure record mockup ("Print this client's procedure record") and the **Smarter prep** section shows a Daily prep "Tomorrow morning" mockup ("Based on recorded Hone data."). Confirm the hero app-window, Before Today centerpiece, proof-strip pill ticker, both comparison app-window cards, the privacy checklist + policy link, record, and prep visuals all render and fit (no horizontal overflow) at phone and desktop. It keeps an eight-section structure: hero, calendar-vs-Hone comparison, before/during/after the appointment, what Hone remembers (Before Today, charting, procedure record, Daily prep as compact cards), records and lot traceability, "Smarter prep, without autopilot.", privacy/trust, and pricing/walkthrough. Open `https://hone.care/` on a phone (~390px) and on desktop and confirm: the hero reads "Treatment memory for electrologists." within five seconds with the line "Your calendar knows who is coming. Hone helps you remember what matters." and ONE hero visual (not a stack of competing cards); the page does not scroll sideways at either width; the Book walkthrough CTA is visible and reachable (header button on desktop, menu on mobile) and lands on `/demo`; Sign in is reachable and lands on `/login`; the comparison ("Your calendar shows the appointment. Hone shows what to remember."), before/during/after, what-Hone-remembers, records (with the local public-health responsibility caveat), the "Smarter prep, without autopilot." section, privacy/trust ("Your client records should stay yours."), and pricing ($19/month founding pilot, "See if Hone fits your studio.") all render; the nav is short and human (Product, Records, Pricing, Sign in plus the CTA — no "Agentic support" item); the hero leads with NO AI/agentic wording; all product visuals use only anonymized demo data (Maya R., Demo Studio, lot L-204, Sterex), never a real client or studio; and there are no medical, compliance, or AI overclaims (no HIPAA/public-health-certified/medical-grade/guaranteed-compliance, no autonomous clinical decisions claimed as a feature) and no SaaS filler (operating memory layer, AI-powered, intelligent assistant, seamless, empower, optimize, unlock, transform your workflow). The Playwright lane (`e2e/marketing-homepage.spec.ts`) covers the overflow + CTA + sign-in checks at phone and desktop widths.

## 1. Public booking smoke

1. Open `https://hone.care/book/willow-electrolysis`. Expect `200`.
2. Pick "Next available day". Expect a date with at least one slot.
3. Fill the form as a new client. Verify the service picker only shows consultation modalities.
4. Submit. Expect a confirmation banner and a confirmation email in the inbox.
5. SQL:
   ```sql
   select id, status, starts_at, cancellation_token_hash,
          confirmation_send_attempts, confirmation_sent_at
     from public.appointments
    where studio_id = '<studio uuid>'
    order by created_at desc
    limit 5;
   ```
   Expected: new row, `status='confirmed'`, `confirmation_send_attempts >= 1`, `confirmation_sent_at` populated. **Tokens are hashed at rest — the new row has `cancellation_token_hash` non-null (64 lowercase hex).** The confirmation email's `/cancel/<token>` link still carries the raw token (generated in-memory at booking); clicking it resolves because the route hashes the URL token and matches `cancellation_token_hash`. **PR #264 (migration 0091): the legacy raw `cancellation_token` column has been dropped — selecting it now errors; every row (including older ones, via the 0090 backfill) is found by hash only.**

### Appointment token hashing smoke (PR #260, migration 0090)

End-to-end check that hashing at rest did not break the public cancel/reschedule/manage links:

1. Book a public appointment (smoke 1). Confirm the confirmation email's **Cancel** and **Reschedule** links open `/cancel/<token>` and `/reschedule/<token>` and resolve to the appointment (not the generic "link can't be used" page).
2. SQL on that row: `cancellation_token_hash` is non-null 64-hex. (PR #264 / migration 0091 dropped the raw `cancellation_token` column — it no longer exists.)
3. As that client, open the **Portal** (smoke 2): the upcoming appointment's **Manage** button lands on a working `/manage/<token>` page whose **Reschedule** and **Cancel** actions both resolve (the portal mints the HMAC token; `/reschedule` accepts it as of PR #260).
4. Trigger an appointment reminder (or wait for the 15-min scheduler): the reminder email's cancel/reschedule links and the SMS manage link all resolve.
5. Negative: `/cancel/not-a-real-token` shows the generic neutral error (no token-state leak), unchanged.

This is also pinned automatically by `tests/db/appointment-token-hash.db.test.ts`, `tests/lib/booking/appointment-token-hash.test.ts`, and `e2e/appointment-token-hash.spec.ts`.

### Public booking PII log minimization smoke (PR #261)

Confirms the unauthenticated public booking error logs never carry raw client PII:

1. Primary coverage is `tests/app/book/pii-log-minimization.test.ts` (source-grep) — run `npm test`.
2. Optional manual check (**no production writes**): in a NON-prod environment, force a public booking error path (e.g. an existing-client / archived-collision attempt) and inspect the function logs. Each `public_booking_*` line must contain only `code`, `studioId`, and `emailFingerprint` (a 64-char hex), plus `archivedClientCollision: true` on the collision path — never a raw email, `normalizedEmail`, `archivedClientId`, or a raw Postgres `message`.
3. Determinism: the same booker email always yields the same `emailFingerprint` (so repeated failures stay correlatable), and the fingerprint never equals the raw email.

Do NOT exercise this against production data.

## 2. Portal smoke

1. Request a magic link at `/portal/login?studio=willow-electrolysis` for a test client.
2. Confirm the email arrives and the link points to `https://hone.care/portal/verify/<token>`. Confirm the body text reads `"This link expires in 1 hour."` (PR #166).
3. Open the link in a fresh incognito window. Confirm GET is non-consuming (page renders the Continue form).
4. Click Continue. Confirm landing on `/portal` with the two-zone layout (Needs you / Your info), and confirm the top-right cluster shows the Email <studio> button and the Sign out link as horizontal peers (PR #166 flipped them from stacked to side-by-side).
5. Verify the cookie `hone_portal_session` is httpOnly + secure.
6. Sign out by clearing the cookie. Confirm `/portal/messages` redirects when anonymous.
7. To verify the new 60-minute window: issue a magic link, wait ~35 minutes (well past the old 30-minute TTL), then click. The Continue page must render. A regression to the 30-minute TTL would surface the generic "this secure link can't be used right now" error.

## 3. Consent smoke (treatment + photo)

1. As the studio owner in `/settings/consent`, create a `treatment_consent` template. PR #167: the new template lands as **Draft** with a **Draft** badge; it is NOT in the client portal yet. Verify the helper copy above the form reads `"New forms are saved as Draft. They are not shown to clients until you mark them Active and then Live in client portal."`
2. Click **Make active**. The badge stays **Draft** (the template is now in the practitioner's workflow but not yet exposed). Confirm a **Make live in client portal** button appears.
3. Click **Make live in client portal**. The badge flips to **Live**. The row moves into the **Live in client portal** group.
4. As a test client in `/portal`, sign the form (type your name + submit).
3. SQL:
   ```sql
   select id, template_title_snapshot, template_version, template_hash,
          signature_name, signed_at, response
     from public.client_consent_signatures
    where studio_id = '<studio uuid>' and client_id = '<client uuid>'
    order by signed_at desc;
   ```
   Expected: new row with the title/body/version snapshot, `signature_name` populated, `signed_at` recent.
4. Repeat for a `photo_consent` template.

## 4. Photo denial smoke (PR #137)

1. From a test client's `/portal`, find an active `photo_consent` form.
2. Click "Deny" (or the equivalent UI button).
3. SQL: the new `client_consent_signatures` row carries `response='denied'` and a `response_label_snapshot` describing the deny copy. The signature is real, not absent.

## Session payment prepare smoke (PR #172, test mode only)

Manual smoke (cannot be done from the harness because it requires an active card + a signed `signed_current` `card_authorization` for a real client). Steps:

1. As studio owner in `/settings/payments`, confirm Stripe Connect is `enabled` and `stripe_livemode=false`.
2. Pick a test client who has an active card on file (PR #135 SetupIntent smoke covers adding one) and a `signed_current` card authorization (PR #170).
3. Book and complete a test appointment for that client; chart a session linked to the appointment.
4. Open `/clients/<client-id>/sessions/<session-id>`. Confirm the `Session payment` card renders immediately after `SessionInfoCard`.
5. Confirm the disclaimer reads `"This prepares a test-mode payment record. It does not charge the client."`
6. Enter an amount (e.g. `$50.00`) and an internal note. Click `Prepare session payment (test mode)`.
7. Confirm the success state appears with an `Attempt id:` block.
8. SQL verify the row:
   ```sql
   select id, studio_id, client_id, appointment_id, session_id, charge_reason,
          amount_cents, currency, status, client_payment_method_id,
          card_authorization_signature_id, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id, created_at
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`, `stripe_payment_intent_id IS NULL`, `stripe_charge_id IS NULL`, `client_payment_method_id` populated, `card_authorization_signature_id` populated.
9. Click `Prepare session payment` again on the same session. Confirm the duplicate state appears (`A session payment attempt is already prepared for this session`).
10. Negative path: archive the active card row, refresh. Confirm the card surfaces the blocking reason `"Client must add a card on file..."`.

## Session completion to billing handoff + payment UI cleanup (PR #181)

After PR #181 ships, the calendar appointment detail and the session payment card both render a clearer current state. Run this between the appointment-completion smoke (PR #180) and the payment smoke chain.

1. Open a confirmed past test appointment.
2. Click Mark completed and confirm.
3. The appointment status flips. Below the lifecycle actions the calendar page now renders an "Appointment completed" card with the guidance line **"Next step: chart the session and bill the client."** and one primary CTA whose label depends on linked-session state:
   - No linked session: **Start session** (forwards to `/clients/<id>/sessions/new?appointment_id=<id>`).
   - Linked session but not started: **Open session** (forwards to the session page).
   - Linked started session: **Go to billing** (deep-links to the session page with `#session-payment`).
4. The previous bare `Completed` placeholder text must NOT appear. The previously-mounted ChartSessionCard ("+ Chart session" / "Session for this appointment") must NOT appear on the completed state (the NextStepCard supersedes it). ChartSessionCard continues to render for confirmed and no_show.
5. Click the CTA. You should land on the session page; if the CTA was "Go to billing" the URL ends in `#session-payment` and the payment card is in view.
6. On the session page the payment surface follows the cleaner state model:
   - When the row is in `status='succeeded'` with no successful refund the top heading reads **Test charge succeeded.**
   - When the row also carries `refund_status='succeeded'` the top heading reads **Test payment refunded.** with an amber palette + a Refund details block (Amount refunded / Refunded / Refund id) directly under the charge details.
   - No stale "Session payment prepared / Attempt id: ... No charge has been run" banner appears alongside a succeeded or refunded panel. The local prepare banner is gated on `!activeAttempt` and `router.refresh()` is called after a successful prepare so the persisted ReadyPanel takes over immediately.
7. SQL verify the row to confirm DB state matches the UI:
   ```sql
   select id, status, refund_status, refund_amount_cents, refunded_at, stripe_refund_id
   from public.payment_charge_attempts
   order by created_at desc limit 1;
   ```
8. Receipt sub-panel + Refund sub-panel still render their own per-section detail and stay reachable.

## Appointment completion + session-start smoke (PR #180)

After PR #180 ships, the workflow Chloe could not finish becomes reachable. Run this before the payment smoke chain below.

1. Find or create a confirmed past test appointment (any time before now).
2. Open it from `/calendar` or the calendar appointment detail.
3. Confirm two buttons are visible: `Mark completed` (primary / filled) and `Mark no-show` (outline). Both are enabled because the appointment has already ended.
4. Click `Mark completed`. A browser confirm appears with the exact copy: "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting."
5. Confirm. Within a moment the appointment detail flips. The hint reads "Appointment marked completed."
6. SQL verify:
   ```sql
   select id, status, ends_at from public.appointments
   where id = '<appointment_id>';
   ```
   Expected: `status='completed'`.
7. (Optional, demonstrates auto-complete.) Skip step 5 and instead click "Chart session" from the appointment detail. After the session record is created, return to the calendar appointment detail. The appointment must now be `completed` (auto-marked by `maybeMarkAppointmentCompletedOnSessionStart`). SQL verify the same way.

Negative checks (each should leave the appointment status alone):
- Future confirmed appointment: both buttons are visible but disabled. Hover title for the Mark completed button reads "Appointment can be marked completed after the appointment has ended."
- Cancelled appointment: no Mark completed button rendered (the component early-returns null for any non-confirmed status).
- No-show appointment: no Mark completed button rendered.
- Already completed appointment: no Mark completed button rendered.

After step 6 (or 7) lands, proceed to the payment smoke chain below.

## Webhook reconciliation smoke (PR #179, test mode only)

Run this after a full Prepare -> Run test charge -> Send receipt -> Refund chain has produced a `succeeded` row with `refund_status='succeeded'`.

### Required (no special tooling)

1. Open the session detail page after running the full chain.
2. SQL verify the row is fully reconciled by the action layer (no webhook needed for this baseline):
   ```sql
   select id, status, stripe_payment_intent_id, stripe_charge_id, charged_at,
          refund_status, stripe_refund_id, refunded_at, refund_amount_cents
   from public.payment_charge_attempts
   order by created_at desc limit 5;
   ```
   Expected: `status='succeeded'`, `refund_status='succeeded'`, both `stripe_*_id` populated, `charged_at` + `refunded_at` populated.
3. SQL verify NO critical ops_alert tied to the chain:
   ```sql
   select event, severity, message, created_at from public.ops_alerts
   where event in (
     'payment_intent_succeeded_local_terminal_mismatch',
     'payment_intent_failed_after_local_succeeded',
     'payment_intent_failed_local_terminal_mismatch',
     'charge_refunded_partial_out_of_band',
     'charge_refunded_out_of_band_reconciled',
     'payment_charge_dispute_created',
     'stripe_webhook_metadata_mismatch',
     'stripe_webhook_livemode_event_ignored'
   )
   order by created_at desc limit 10;
   ```
   Expected: no new critical alert tied to this chain (a `charge_refunded_out_of_band_reconciled` would be warning-severity and would only appear if a Stripe-Dashboard refund happened separately).

### Optional (Stripe CLI replay)

If the Stripe CLI is configured for the studio's connected account:

4. Replay a `payment_intent.succeeded` event for the prepared PaymentIntent. The webhook should:
   - return 200,
   - leave the row unchanged (it's already `succeeded`),
   - NOT fire a duplicate ops_alert.
5. Replay a `charge.refunded` event. The webhook should:
   - return 200,
   - leave the row unchanged (already refunded),
   - NOT fire a critical ops_alert.
6. Test the mismatch surface: issue a partial refund via the Stripe Dashboard (test mode) against a fully-refunded charge. The webhook should fire a critical `charge_refunded_partial_out_of_band` and leave the row alone.
7. Test the dispute surface: trigger a Stripe-test dispute (`charge.dispute.created`). The webhook should fire a critical `payment_charge_dispute_created` with charge / dispute / amount / reason in the safeDetails.

If Stripe CLI is not available, document what was tested via the application path only; the webhook handler correctness is proven by the source-grep test suite + the structural idempotency guarantees of the existing `stripe_events` ledger.

## Session payment test-mode refund smoke (PR #178, test mode only)

Run after a `succeeded` session_payment row exists. The row must NOT already be refunded (`refund_status IS NULL`).

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the Succeeded panel renders with the green border.
3. Below the Receipt sub-panel, confirm the new Refund sub-panel is visible. It must say "This creates a Stripe test-mode refund for this charge. No live money is moved." and show a "Refund test charge" button.
4. Click `Refund test charge`. The button must flip to "Confirm: refund test charge ($X.XX)" alongside a Cancel button.
5. Click the confirm button.
6. Within a few seconds the sub-panel must flip to "Test refund succeeded." with `Amount refunded: $X.XX`, `Refunded: <date>`, and `Stripe refund: re_...`. The Refund test charge button must disappear.
7. Reload the page. Confirm the same "Test refund succeeded" state survives.
8. SQL verify the row:
   ```sql
   select id, charge_reason, status, refund_status, refunded_at,
          stripe_refund_id, refund_amount_cents, stripe_livemode
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `refund_status='succeeded'`, `refunded_at` populated ≈ now, `stripe_refund_id` starts with `re_`, `refund_amount_cents = amount_cents` (full refund), `stripe_livemode=false`.
9. Verify the Stripe Dashboard (TEST mode, the studio's connected account). The original test charge must show as Refunded; a Refund object with the matching `re_...` id must exist.
10. Confirm no critical ops_alert fired:
    ```sql
    select event, severity, message, created_at from public.ops_alerts
    where event in (
      'payment_refund_stripe_unknown_outcome',
      'payment_refund_succeeded_write_failed',
      'payment_refund_failed_write_failed'
    )
    order by created_at desc limit 5;
    ```
    Expected: no new alert tied to this smoke attempt.

Negative paths (manual variations):
- Click `Refund test charge` against a `pending_stripe` row: button must be absent (only succeeded rows show it).
- Click `Refund test charge` against an already-refunded row: button must be absent (the Test refund succeeded state holds).
- Run the action against a row whose `stripe_charge_id IS NULL`: helper returns `outcome:"missing_charge_id"`; the row's `refund_status` stays null. (This requires an in-DB scenario; not normally reachable from a clean prod row.)

## Session payment test-mode receipt smoke (PR #175 + PR #177, test mode only)

**PR #177 update (2026-06-08):** PR #177 unblocked this smoke by repairing the stale `client_payment_methods.card_authorization_signature_id` pointer in prod (migration 0077) and tightening the session payment prepare/execute gate so future drifts surface with the clear "Client must re-sign the current card authorization for the card on file." remedy at prepare time. The known prod row at `My Studio` is repaired; the helper auto-maintains the pointer on every future `card_authorization` re-sign. Run the steps below against any `succeeded` session_payment row.

Run after a `succeeded` session_payment row exists.

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the green Succeeded panel renders. Confirm a new `Receipt` sub-panel is visible inside it.
3. Confirm the sub-panel shows the disclaimer "Sends a Stripe test-mode receipt to the client. No live card was charged." and the `Send test receipt` button.
4. Confirm a test client with an email on file is associated with the attempt.
5. Click `Send test receipt`. Wait for the network round-trip.
6. Confirm the sub-panel flips to "Receipt already sent to <email> on <date>." within the same render.
7. Reload the page. Confirm the same "already sent" state survives the refresh.
8. SQL verify the row:
   ```sql
   select id, charge_reason, status, receipt_status, receipt_sent_at,
          receipt_email_to, stripe_livemode, stripe_payment_intent_id,
          stripe_charge_id
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `receipt_status='sent'`, `receipt_sent_at` populated, `receipt_email_to` matches the test client's email, `stripe_livemode=false`, `stripe_payment_intent_id` populated.
9. Verify the actual email arrived at the test client's mailbox. Confirm the subject starts with "TEST MODE" + the studio name + the reason label + the amount. Confirm the body carries the three disclaimers: "This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone." (PR #181 replaced the pre-PR-#178 "Refund handling is not enabled in Hone yet." wording.) Confirm the body does NOT say "tax receipt" / "official invoice" / "payment complete" / "live payment".
10. Click `Send test receipt` again (should not appear because state is now `sent`; if it does, that's a bug). Verify no new email is delivered and the SQL row remains untouched.

Negative path (no client email): use a test client whose `clients.email` is null or empty. Confirm the action returns the `client_email_missing` outcome and the row's `receipt_status` stays null.

## Session payment post-refresh state smoke (PR #174, test mode only)

Run after the PR #173 EXECUTE smoke has produced a `succeeded` row.

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the green Succeeded panel appears with:
   - Heading: "Test charge succeeded."
   - Amount + charged-at timestamp.
   - PaymentIntent id (`pi_...`).
   - Charge id (`ch_...`) if available.
   - Explicit "This was a Stripe test-mode charge. No live card was charged. No receipt was sent in this PR."
3. Reload the page. Confirm the same Succeeded panel renders with all the Stripe ids still visible (no fallback to a bare "Succeeded" label).
4. Confirm the Run test charge button does NOT appear.
5. Confirm the Prepare form does NOT appear.
6. Confirm no "Pay now" / "Charge card" / "Collect payment" / "Payment complete" / "Live payment" / "Receipt sent" copy is anywhere on the page.

Negative path (failed row): use a Stripe test card that declines (e.g. `4000 0000 0000 0002`). After execute:
1. Confirm the red Failed panel appears with sanitised failure message + failure code + failed-at.
2. Confirm the "Prepare a new session payment attempt if you need to try again." guidance is present.
3. Confirm no Run button appears.
4. Refresh and confirm the same Failed panel survives.

## Session payment EXECUTE smoke (PR #173, test mode only)

Run after the PR #172 prepare smoke has produced a `ready` row. The execute action calls Stripe in test mode on the connected account.

1. From the same session detail page that produced the `ready` attempt in the PR #172 smoke, confirm the "Run test charge" button now appears (Stripe-test-mode amber panel under the existing-attempt block).
2. Click "Run test charge". Confirm the button label changes to "Confirm: run test charge ($X.XX)" (two-click pattern).
3. Click "Confirm: run test charge". Wait for the network round-trip.
4. Confirm the green success panel appears with a `PaymentIntent: pi_...` id (and a `Charge: ch_...` id if available).
5. SQL verify the row:
   ```sql
   select id, charge_reason, status, amount_cents, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id, charged_at,
          failed_at, failure_code, failure_message_safe, updated_at
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated (`pi_...`), `stripe_charge_id` populated, `charged_at` non-null, `failed_at` null, `failure_code` null.
6. Click "Run test charge" again. Confirm the action short-circuits (the `runSessionPaymentCharge` already-succeeded branch). No new PaymentIntent.
7. Verify Stripe Dashboard -> Payments on the connected account: exactly one PaymentIntent + Charge.
8. Negative path: archive the active card row in `client_payment_methods` then click "Run test charge" on a NEW ready attempt. The action should refuse with a `lineage_mismatch` outcome and a practitioner-facing message; the row should remain unchanged (status='ready', no Stripe call).

## Live payments dormancy verification (PR #168)

Before running any of the payment smokes below, confirm the dormancy posture is intact:

```bash
npm run check:stripe-gates
# Expect:
#   PASS paymentIntents.create -- 1 occurrence in lib/billing/session-payment-charge.ts
#   PASS refunds.create -- 1 occurrence in lib/billing/payment-refund.ts
#   PASS STRIPE_ALLOW_LIVE_MODE=true -- 1 occurrence in lib/stripe/server.ts
#   PASS charges.create / checkout.sessions -- 0 occurrences

supabase db query --linked "
  select stripe_livemode, count(*) from public.studio_payment_settings
  group by stripe_livemode;
"
# Expect: every row stripe_livemode=false.

supabase db query --linked "
  select count(*) from public.manual_fee_charge_attempts where stripe_livemode = true;
"
# Expect: 0.
```

Full readiness review + go/no-go checklist: [docs/16](./16_LIVE_PAYMENTS_READINESS.md). Conclusion (PR #168, 2026-06-08): **NOT READY FOR LIVE PAYMENTS.**

## 5. Card-on-file smoke (test mode)

See [docs/11 Stripe card-on-file smoke](./11_RUNBOOK.md#stripe-card-on-file-smoke-test-mode). Use Stripe test card `4242 4242 4242 4242`.

Expected end state:
- One `client_payment_methods` row with `status='active'`, `stripe_livemode=false`, valid Stripe ids, non-null `card_authorization_signature_id`.
- One `stripe_events` row for `setup_intent.succeeded` with `processed_at` set and no `processing_error`.
- The portal "Your info" zone shows `Visa ending in 4242`.

### 5b. Replace card smoke (PR #151)

1. Sign into the portal as a test client who already has an active card on file (Visa 4242 from §5).
2. Confirm the "Your info" zone shows `Card on file: visa ending in 4242, expires MM/YYYY` plus a **Replace card** button (and the test-mode disclaimer).
3. Click "Replace card". Confirm:
   - Read-only summary remains visible.
   - The replace-mode helper copy renders: "Your current card will be replaced after the new card is saved. No charge will be made."
   - A Stripe Elements `<PaymentElement />` form mounts under the connected-account context.
   - An inline Cancel link is present.
4. Enter a different Stripe test card if practical (e.g. `5555 5555 5555 4444` for Mastercard) or `4242 4242 4242 4242` again. Submit "Save new card".
5. On Elements success, the form replaces itself with the success copy "Card updated. The new card may take a moment to appear on the page."
6. Refresh the portal page. The "Your info" zone now shows the new brand + last4 + expiry.
7. SQL verify:
   ```sql
   select id, status, brand, last4, exp_month, exp_year,
          stripe_livemode, stripe_account_id, stripe_customer_id,
          stripe_payment_method_id, stripe_setup_intent_id,
          card_authorization_signature_id, added_via,
          added_at, removed_at
     from public.client_payment_methods
    where studio_id = '<studio uuid>'
      and client_id = '<client uuid>'
    order by added_at desc;
   ```
   Expected:
   - Exactly ONE row with `status='active'` (the new card).
   - The prior card row is `status='removed'` with `removed_at` populated.
   - The new active row carries a non-null `card_authorization_signature_id`.
   - `stripe_livemode = false` on both rows.
   - The new active row's `stripe_setup_intent_id` is different from the prior row's.
8. Stripe Dashboard → Customers → the connected-account customer for this `(studio, client)`. Confirm a NEW PaymentMethod attached. Confirm a NEW SetupIntent succeeded. Confirm **no PaymentIntent and no Charge were created** during the replace.
9. Click "Replace card" again, then click Cancel. Confirm the form unmounts and the card summary is restored unchanged.
10. (Optional safety) Cancel a Stripe test SetupIntent that has not yet succeeded. Confirm the prior active card row is NOT removed (the webhook only flips on `setup_intent.succeeded`).

## 6. Cancellation reason smoke (PR #144)

1. From a test booked appointment, open the cancel link `/cancel/<token>`.
2. Pick "Schedule changed" from the reason dropdown. Verify the reschedule nudge appears with a `Reschedule instead` button.
3. Click the button. Confirm `/reschedule/<token>` opens.
4. Return to the cancel link. Pick "Schedule changed" again. Add a note. Check the follow-up-allowed box. Submit.
5. SQL:
   ```sql
   select action, actor_type, details, created_at
     from public.appointment_audit
    where action = 'cancelled'
    order by created_at desc
    limit 5;
   ```
   Expected: top row has `details = {"source": "public_token", "reason": "schedule_changed", "reason_label": "Schedule changed", "note": "<your note>", "follow_up_allowed": true}`.
6. Open the appointment in `/calendar/<id>` (signed in as practitioner). Confirm:
   - "Cancellation reason: Schedule changed".
   - "Client note: <your note>".
   - "Follow-up okay" badge.
   - "Cancelled N minutes after booking" if `cancelled_at - created_at <= 15 minutes`.

## 7. Calendar block smoke (PR #139 + #140)

1. As an active non-owner practitioner (if available; otherwise the owner), open `/calendar`.
2. Drag to select a window. Pick "Block time" from the chooser.
3. Confirm the block renders with the warm-tan style (PR #138).
4. Open `/book/<slug>` and the studio's booking horizon date that overlaps the block. Confirm the blocked time is NOT offered as a bookable slot.
5. Repeat with an all-day block. Confirm the block synthesises `[utc(date 00:00), utc(date+1 00:00))` (no extra calendar day swept up).

## 8. Fee protection smoke (PR #145)

1. As owner in `/settings/payments`, set both `late_cancel_fee_cents` and `no_show_fee_cents` to non-zero values via the FeeAmountsCard.
2. Open a cancelled appointment with full evidence (active card, signed authorization, policy ack). The "Cancellation/no-show fee" card should show the eligible preview on the Late cancellation tab and block on the No-show tab with "No-show fee requires a no-show appointment."
3. Try Prepare with no internal note → blocked (client-side disable + server-side `NOTE_REQUIRED_ERROR`).
4. Add note + Prepare → success card "Manual charge prepared. No money has been charged yet."
5. SQL:
   ```sql
   select id, charge_type, status, amount_cents, currency,
          internal_note, timing_classification, created_at
     from public.manual_fee_charge_attempts
    order by created_at desc
    limit 5;
   ```
   Expected: new row with `status='ready'`, `timing_classification='practitioner_asserted'`, your note populated.
6. Set both fee amounts to NULL or 0. Confirm the eligible preview disappears and the blocked panel reads "Late cancellation fee amount is not configured."

## 9. Test-mode manual fee charge smoke (PR #146)

Critical money-adjacent path.

1. Pre-conditions: a `ready` attempt exists from §8 above. Stripe is in test mode (`STRIPE_SECRET_KEY` starts with `sk_test_`).
2. On the appointment detail page, click "Run test charge".
3. Wait for the success card to render.
4. SQL:
   ```sql
   select id, status, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id,
          stripe_idempotency_key, charged_at
     from public.manual_fee_charge_attempts
    where id = '<attempt uuid>';
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated, `stripe_charge_id` populated, `stripe_idempotency_key = 'hone:manual-fee:<attempt-id>:v1'`, `charged_at` set.
5. Stripe Dashboard → Payments under the connected account: exactly one PaymentIntent + Charge with metadata `hone_manual_fee_charge_attempt_id=<your id>`, `hone_environment=test`.
6. Click "Run test charge" again on the same now-succeeded row. The action short-circuits via `already_succeeded`. Stripe Dashboard shows still exactly one PaymentIntent.
7. Refresh the appointment detail page (simulating a network blip mid-action). Confirm the success panel reads the same `stripe_payment_intent_id`.
8. Prepare a separate `ready` attempt on a different appointment. Click "Cancel prepared fee" with a reason. Confirm:
   - Row flips to `status='cancelled'`.
   - `stripe_payment_intent_id` stays NULL.
   - No Stripe call (verify in dashboard).
9. Confirm no email/SMS receipt was sent (none should be; no receipt code exists today).
10. Confirm no live payment exists.

## 9b. Public reschedule safety smoke (PR #149)

Critical safety path. Public reschedule must match public booking on past-slot handling and must never expose raw DB or RPC errors.

1. Create a test appointment in the future. Open its `/reschedule/<token>` link.
2. Confirm the summary loads and slots render.
3. Pick **today** as the date. Confirm slots earlier than or equal to now are NOT offered.
4. Submit a forged form with `newStartsAt <= now()` (browser devtools edit the value attribute on a hidden field or POST directly). Confirm the response is the generic "This reschedule link can't be used right now." copy with no raw Postgres or function-name text.
5. Cancel the original appointment via `/cancel/<token>`. Re-open `/reschedule/<token>`. Confirm the page renders the generic unavailable surface and `/reschedule/<token>`'s read actions do not return the appointment summary.
6. Mark another future appointment `completed` and another `no_show` (via the practitioner calendar lifecycle). Re-open each one's reschedule link. Confirm the same generic behavior.
7. SQL check after a successful reschedule:
   ```sql
   select id, status, starts_at, cancellation_reason, cancelled_at,
          cancelled_by, cancellation_token_hash, updated_at
     from public.appointments
    where studio_id = '<studio uuid>'
      and (id = '<original id>' or starts_at = '<new starts_at>')
    order by updated_at desc;
   ```
   Expected: original row has `status='cancelled'`, `cancellation_reason='Rescheduled via email link'`. New row has `status='confirmed'` and a new `cancellation_token_hash` (64-hex). The raw `cancellation_token` column was dropped by migration 0091 (PR #264) — the raw token exists only in the outbound link at creation time, never at rest; links resolve by hashing the URL token and matching `cancellation_token_hash`.
8. SQL check the RPC source carries both guards:
   ```sql
   select pg_get_functiondef(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='reschedule_appointment';
   ```
   Expected substring matches:
   - `v_original.starts_at <= now()`
   - `p_new_starts_at <= now()`
9. Run the local automated test harness against the action's source file:
   ```bash
   npm test
   ```
   Expected: every test in `tests/app/reschedule/error-sanitization.test.ts`, `tests/app/reschedule/submitted-start-guard.test.ts`, and `tests/lib/booking/slots-filter-future.test.ts` passes. These pin down "no raw .message leak", "strict > now()" comparison, and the shared future-slot filter.

## 10. Security route smoke

```bash
echo "=== Anonymous routes ==="
curl -sI -o /dev/null -w "/book/willow-electrolysis %{http_code}\n" \
  "https://hone.care/book/willow-electrolysis"
curl -sI -o /dev/null -w "/calendar %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/calendar"
curl -sI -o /dev/null -w "/settings/payments %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/settings/payments"
curl -sI -o /dev/null -w "/portal %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal"
curl -sI -o /dev/null -w "/portal/messages %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal/messages"

echo "=== Token route privacy headers ==="
for p in /cancel /reschedule /manage /intake /portal/verify; do
  echo "${p}/fake:"
  curl -sI "https://hone.care${p}/fake" \
    | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
done

echo "=== /calendar-feed/fake.ics has the same headers ==="
curl -sI "https://hone.care/calendar-feed/fake.ics" \
  | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
```

Expected:

| Route | HTTP | Redirect / headers |
|---|---|---|
| `/book/willow-electrolysis` | `200` | n/a |
| `/calendar` | `307` | `/login` |
| `/settings/payments` | `307` | `/login` |
| `/portal` | `307` | `/portal/login` |
| `/portal/messages` | `307` | `/login` |
| `/cancel/fake` | `200` | `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` |
| `/reschedule/fake` | `200` | same |
| `/manage/fake` | `200` | same |
| `/intake/fake` | `200` | same |
| `/portal/verify/fake` | `200` | same |
| `/calendar-feed/fake.ics` | `404` (no real token) | same |

### 10b. Invite-only auth + no-studio gate (PR #253)

Hone is invite-only for supervised studios; there is no self-serve signup or public studio creation. Anonymous (no session): `/login` returns `200` and shows "Sign in to Hone" with the line "Invited users only. Use the email address your studio invitation was sent to." and NO "Create account / Sign up / Create studio" CTA; `/no-access` returns `307 -> /login`; and there is no `/signup` or `/register` route (`curl -sI https://hone.care/signup` and `/register` return `404`). No-studio authenticated user (an uninvited Google sign-in, or any account with no `pending_invitations` match — i.e. an `auth.users` row with no practitioner): after the auth callback they are redirected to `/no-access` (NOT the dashboard), which shows "No studio access yet", the invite-only explanation, a Sign out button (→ `/login`), and a Contact Hone link (`mailto:hello@hone.care`), and NO app navigation or studio data; hitting `/dashboard`, `/clients`, `/calendar`, `/records`, `/settings/*`, or `/admin` directly all redirect (`307`) to `/no-access` (the middleware gate runs before any app page renders, so no studio data loads and no server error is logged). Invited owner first sign-in still works (the supported `pending_invitations` → `handle_new_user` → owner practitioner path; the existing Chloe/Willow account is unaffected). Public booking (`/book/<slug>`) and the marketing site remain public. The e2e lane (`e2e/invite-only.spec.ts`) proves the no-studio gate end to end on the local stack; the RLS posture (no authenticated user can create a studio / membership / invitation or escalate a role) is pinned by `tests/db/invite-only-posture.db.test.ts`.

### 10c. Internal New Studio Wizard (PR #254)

The internal New Studio Wizard lives at the operator-only `/admin/studios/new` and automates the docs/20 §2.1/§2.2 writes (one `studios` row + one `owner` `pending_invitations` row, via the service-role client, after an `isAdmin` gate). **Access checks (non-destructive, safe to run anytime):** anonymous `curl -sI https://hone.care/admin/studios/new` returns `307 -> /login`; a signed-in no-studio NON-operator hitting `/admin/studios/new` lands on `/no-access` (the PR #254 carve-out is `isAdmin`-only); a signed-in operator (an `ADMIN_EMAILS` entry — note a studio-less operator first lands on `/no-access` after sign-in and must navigate to `/admin/studios/new` directly) sees the "New studio" form. **Actual creation is a real production action, not a throwaway smoke** — use the wizard to do real new-studio setup per docs/20 (it creates a real `studios` row, which has no DELETE policy). On success the wizard shows the booking URL (`/book/<slug>`), the owner email, the `owner · pending` invitation, and the setup checklist ("Live payments remain disabled"); the owner is then created by `handle_new_user()` on their invited first sign-in (the wizard never inserts a practitioner). The wizard never sends email, touches Stripe/payments, or seeds services/availability. The access matrix + create flow are proven by `e2e/new-studio-wizard.spec.ts`; the operator gate + two-write shape by `tests/app/admin/new-studio-wizard.test.ts`; the service-role capability + RLS denial for normal users by `tests/db/new-studio-wizard.db.test.ts`.

### 10d. Admin Console V1 (PR #255)

`/admin` is the operator-only Admin Console (gated by the same `app/admin/layout.tsx` `isAdmin` check as every `/admin` route). **Access checks (non-destructive):** anonymous `curl -sI https://hone.care/admin` returns `307 -> /login`; a signed-in no-studio NON-operator → `/no-access`; a normal (non-`ADMIN_EMAILS`) studio user → `/dashboard` (the layout redirect); only an `ADMIN_EMAILS` operator sees the console. **Console contents (operator session):** a header "Admin / Internal operator tools for invite-only studio setup.", a "Live payments are disabled." banner, a **Studio setup** card with a **Create new studio** CTA → `/admin/studios/new` (the wizard is discoverable here and from the nav — no remembered URLs), four overview count cards (total studios, pending/accepted owner invites, studios needing an owner), an enhanced studios table (name → `/admin/studios/[id]`, slug → `/book/<slug>`, owner email, timezone, owner-invite status, and Owner/Services/Availability setup-health flags), and operator quick links. The page must not scroll sideways at desktop width. **Privacy:** the console shows operational metadata + aggregate counts ONLY — confirm it never renders client names, treatment notes, exposure-incident details, imported-memory contents, payment internals, Stripe ids, tokens, or audit JSON. Reads are two cheap service-role queries (`studios` + embedded counts, owner `pending_invitations` status); no new schema or tracking. Pinned by `tests/app/admin/admin-console.test.ts` (surface + the NO-client-data negatives) and `e2e/new-studio-wizard.spec.ts` (operator sees the console, no overflow, CTA → the wizard).

### 10e. Admin studio detail privacy (PR #256)

`/admin/studios/[id]` is the operator-only studio detail page (same `app/admin/layout.tsx` `isAdmin` gate; anonymous `curl -sI https://hone.care/admin/studios/<id>` → `307 -> /login`). **As of PR #256 it shows operational metadata + aggregate counts + setup-health flags ONLY** — it no longer renders raw client names (the previous gap) or any client contact, treatment note, imported-memory content, exposure incident, payment internal, Stripe id, token, or audit JSON. **Operator session check:** open a studio from the console (name → `/admin/studios/[id]`) and confirm it shows a metadata grid (booking slug → `/book/<slug>`, timezone, owner email, owner-invite status), a counts grid (Practitioners / Clients / Services / Appointments / Imported memory) with an "Aggregate counts only" note, setup-health flags (Owner active / Services configured / Availability configured / Booking slug set / Live payments disabled), and links back to the console + wizard — and that **no client name appears anywhere**. The page must not scroll sideways. Reads are one explicit-column `studios` select with embedded counts + one owner `pending_invitations(status)` query (no row-level client/practitioner/invitation tables). Pinned by `tests/app/admin/admin-studio-detail.test.ts` (no client/clinical/payment/token/audit row reads; embedded counts) and `e2e/new-studio-wizard.spec.ts` (a seeded studio's detail page renders counts/setup and the seeded client name does NOT appear).

## 11. Global security header smoke (PR #150)

Run after every deploy. The global headers ship from `next.config.ts` via the builder in `lib/security/headers.ts`.

```bash
echo "=== Global headers on a safe route ==="
curl -sI https://hone.care/book/willow-electrolysis \
  | grep -iE '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy)'

echo ""
echo "=== Token routes still carry the PR #142 privacy overrides ==="
for p in /cancel/fake /reschedule/fake /manage/fake /intake/fake /portal/verify/fake /calendar-feed/fake.ics; do
  echo "--- $p ---"
  curl -sI "https://hone.care$p" \
    | grep -iE '^(content-security-policy|x-robots-tag|referrer-policy|x-frame-options|x-content-type-options|permissions-policy)'
done
```

Expected on the safe route:

| Header | Value |
|---|---|
| `Content-Security-Policy` | starts with `default-src 'self'`, contains `frame-ancestors 'none'`, contains `https://js.stripe.com`, contains `https://m.stripe.network` in BOTH `frame-src` and `connect-src`, contains the specific Supabase project host BOTH as `https://<host>` AND as `wss://<host>`, no wildcard `*`, no `sentry.io` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload` for this baseline) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | starts with `camera=(), microphone=(), geolocation=()`, ... |

Expected on token routes: all of the above EXCEPT `Referrer-Policy` flips to `no-referrer` and `X-Robots-Tag: noindex, nofollow` is added.

Manual browser smoke (still required for full verification):

1. Open `https://hone.care/book/<slug>` in a fresh tab. Confirm public booking renders, slot picker works, no console CSP violations break the flow.
2. Open `https://hone.care/portal/login`. Confirm the page renders.
3. As a test client, sign in via magic link. Confirm `/portal` renders the two-zone layout.
4. Open the portal Add card flow. **Confirm Stripe Elements iframes load**, the test card `4242 4242 4242 4242` can be entered, and `setup_intent.succeeded` arrives at the webhook. CSP-breaking changes typically show up as the Stripe iframes failing to render or `loadStripe` throwing.
5. Confirm browser console shows no CSP violations on any of the core flows.
6. Confirm no second PaymentIntent / Charge was created (this PR adds no money-moving code).

## 12. Ops alerts smoke (PR #153)

Run after any PR that touches `lib/ops/alerts.ts`, the webhook, the cron routes, or the email/SMS helpers.

1. Force a benign critical alert by setting `STRIPE_WEBHOOK_SECRET` to an obviously wrong value in a non-production env and hitting `/api/stripe/webhook` with a real Stripe test event. The route returns 400 (signature mismatch); no ops_alerts row is written for the signature-mismatch path because it's a normal protocol error. Restore the secret.
2. Force a benign `cron_route_failed` by temporarily setting `SUPABASE_SERVICE_ROLE_KEY` to garbage and hitting `/api/cron/appointment-reminders` with the right `CRON_SECRET`. The route's catch fires `cron_route_failed`. Restore the env.
3. Query the table:
   ```sql
   select created_at, severity, event, message, route, safe_details
     from public.ops_alerts
    order by created_at desc
    limit 10;
   ```
   Expected:
   - No raw tokens / `client_secret` / Stripe secrets / card numbers anywhere in `safe_details`.
   - Each row has an `event` matching one of the documented names.
   - Severity is `info`, `warning`, or `critical` (CHECK enforced).
4. Confirm normal flows do NOT spam alerts:
   - Open `/cancel/fake` (invalid token) → no alert.
   - Submit `/portal/login` with a non-matching email → no alert.
   - Trigger a 429 via the rate limiter → no alert.
5. Run the full test suite. The 23 new ops-alerts tests + the source-grep wiring tests guard the contract:
   ```bash
   npm test
   ```

## Fractional thermolysis duration (PR #165, migration 0071)

After deploy, the operator should confirm Chloe can enter a fractional value, the row stores it correctly, and the read view displays it.

1. Open a test electrolysis session as the practitioner.
2. Add or edit a thermolysis (or blend) block.
3. Under "Treatment readings" enter:
   - Thermolysis duration (s): `0.15`
   - Thermolysis intensity %: `61`
   - Pulse count: `1`
   - Hairs treated: `37`
4. Save. SQL verify the value persisted as a decimal:
   ```sql
   select id, thermolysis_duration_seconds
   from public.electrolysis_entries
   where session_id = '<session uuid>'
   order by created_at desc
   limit 5;
   -- expect: top row carries 0.15 (not 0).
   ```
5. Refresh the session view. The entry row should read `... 61%, 0.15 seconds, 1 pulse ...` (not `... 0s ...`).
6. Edit the same block again and confirm the input field still shows `0.15`.
7. Enter `0.2` instead and save. Refresh. Confirm the row reads `0.2 seconds` (not `0.20`, not `0`).
8. Enter `1` and save. Refresh. Confirm the row reads `1 second` (singular).
9. Enter `2` and save. Refresh. Confirm `2 seconds`.

## Practitioner notification center (PR #164, migration 0070)

After deploy, the operator should confirm the notification table is reachable, the three event sources fire the helper, and the practitioner-facing page renders the rows. Migration 0070 is applied to production before merge.

1. As Chloe, log into `https://hone.care` and confirm a new **Notifications** link appears in the header nav, between Calendar and Settings. Initial badge: zero (unless someone bookmarked the URL and visited; the unread count is from the live DB).
2. As a test public visitor in an incognito browser, book a new appointment at `/book/willow-electrolysis`. Complete the booking.
3. Refresh Chloe's `/notifications` page. Expect:
   - A new row at the top titled **New booking**.
   - Body: `<Client name> booked <Service> for <Day Mon DD> at <H:MM AM/PM>.`
   - href clicks through to `/calendar/<appointment_id>`.
   - Header badge shows 1 (or however many unread rows exist).
4. From the public token email, click the cancellation link and cancel the appointment with a reason (e.g. "Schedule changed"). Refresh `/notifications`. Expect a new row titled **Appointment cancelled** with body `<Client name> cancelled their appointment. Reason: Schedule changed.`
5. From a fresh public booking, follow the reschedule token to move the appointment to a different time. Refresh `/notifications`. Expect a new row titled **Appointment rescheduled** with body `<Client name> rescheduled from <Day Mon DD at H:MM AM/PM> to <Day Mon DD at H:MM AM/PM>.`
6. Click **Mark all read**. Expect the badge to drop to 0 and the unread tint to disappear from every row.
7. SQL backstop:
   ```sql
   select event_type, title, body, href, read_at, created_at
   from public.practitioner_notifications
   where studio_id = '<studio uuid>'
   order by created_at desc
   limit 10;
   ```
   Expected: three rows from the smoke flow (new_booking, appointment_cancelled, appointment_rescheduled). All `read_at` populated after step 6.
8. Cross-studio safety: sign into a different studio's practitioner account (or use the admin SQL to flip studio scope) and confirm none of the rows above appear. The RLS `is_studio_member(studio_id)` clause is the gate.
9. Never-throws safety: temporarily break the notification write path (e.g. revoke the service role's insert grant in a staging env) and book an appointment. The booking MUST succeed and the client confirmation email MUST go out, even though no notification row is created. The failure logs to `ops_alerts` with `event = 'practitioner_notification_insert_failed'`. This is the hard acceptance gate.

## Booking attribution / "How did you hear about us?" (PR #163, migration 0069)

After deploy, the operator should confirm the new dropdown captures + surfaces correctly end to end.

1. Open `/book/<studio-slug>` as a fresh client (incognito window).
2. Walk through the booking form. Confirm the new "How did you hear about us?" dropdown appears after "Anything else?" with the helper text "Optional. Helps the studio understand where new clients come from."
3. Confirm the options match the seven canonical labels: Google, Instagram, Friend or referral, Existing client, Studio website, Other, Prefer not to say. The default option is "Select an option (optional)".
4. Pick `Instagram` and submit. Confirm the booking succeeds.
5. SQL verify the new column:
   ```sql
   select column_name, data_type, is_nullable
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'appointments'
     and column_name = 'referral_source';
   -- expect: referral_source | text | YES
   ```
6. SQL verify the value landed on the new row:
   ```sql
   select id, starts_at, referral_source
   from public.appointments
   where studio_id = '<studio uuid>'
     and client_id = '<client uuid>'
   order by created_at desc
   limit 5;
   -- expect: the new row has referral_source = 'instagram'
   ```
7. As the studio practitioner, open the calendar appointment detail page for the new booking. Confirm a "How they heard about us" section renders below the appointment notes with the value `Instagram`.
8. Open the practitioner notification email Chloe received. Confirm the body contains `How they heard about us: Instagram` after the time/notes lines.
9. Open the client's confirmation email. Confirm it does NOT mention "How they heard about us" anywhere.
10. Open the client portal. Confirm `referral_source` is not surfaced anywhere on the portal page.
11. Book a second appointment without picking a referral option (leave the dropdown on "Select an option"). Confirm the row inserts with `referral_source = NULL` and the practitioner appointment detail page omits the "How they heard about us" section entirely.

## Charting terminology + thermolysis field order (PR #162)

Operator smoke after deploy:

1. As a practitioner, open any session detail page (`/clients/<id>/sessions/<sessionId>`) for a client with an existing electrolysis session.
2. Click into the treatment-area editor for an existing or new block.
3. **Side dropdown**: confirm the picker shows `Center / Left / Right / Both sides / n/a`. The prior `Bilateral` label must NOT appear.
4. Pick `Both sides` and save. Refresh. Confirm the block re-renders with the same selection.
5. In the read-only session blocks view (the area-title strip above each block), confirm a saved record with `side='bilateral'` prints as `... · Both sides · ...` (NOT lowercase `bilateral`).
6. **Thermolysis field order**: in the same editor, pick the Thermolysis or Blend mode. Confirm the rendered input order under "Treatment readings" is:
   1. Thermolysis duration (s)
   2. Thermolysis intensity %
   3. Pulse count
7. Save a value in each field and confirm the saved record on the read view shows the same values. Persisted column names are unchanged (`thermolysis_duration_seconds`, `thermolysis_intensity_percent`, `pulse_count`).
8. Backstop SQL (optional):
   ```sql
   select id, primary_area, side
   from public.session_blocks
   where studio_id = '<studio uuid>'
     and side = 'bilateral'
   limit 5;
   ```
   Expected: stored value is still the lowercase `bilateral`; only the rendered label changed.

## Pre-appointment instructions (PR #160)

After deploy, the operator should confirm the editable per-service prep text feeds both the email and the portal end to end.

1. Sign in as the studio owner. Open `Settings → Services`. Pick any active service.
2. Confirm the textarea labelled "Pre-appointment instructions" exists. Set it to a recognisable string, for example: `"Smoke test: shave the area 24h before your visit. Avoid caffeine the morning of."`
3. Save. Confirm the success state. Refresh the page and confirm the value persisted.
4. As a test client, book that service. Open the booking confirmation email. Expect a `Before your appointment` block carrying the smoke-test string and NO "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph anywhere in the body or subject.
5. Trigger or wait for the 24h reminder. Expect the same `Before your appointment` block with the smoke-test string. Same for the 2h reminder.
6. Open the portal as the same client. Switch to the Care instructions section (PR #159; open by default). Expect the same smoke-test string under "Before your appointment".
7. Go back to `Settings → Services`. Clear the textarea (empty value). Save.
8. Book another appointment for the same service. The confirmation email should now omit the `Before your appointment` block entirely (no empty card, no leftover heading). The portal Care instructions section should also omit the pre-care entry for that service.

SQL backstop:

```sql
select id, name, modality, pre_care_instructions
from public.services
where studio_id = '<studio uuid>'
order by sort_order, name;
```

Expected: the value the studio owner typed in step 2 appears verbatim on the row for the smoke service.

## Portal layout cleanup (PR #159)

After deploy, the operator should confirm the portal's new structure renders end to end.

1. Open the portal as a test client. The top of the page should show: studio eyebrow, "Hello, <first name>.", a short intro line, and a top-right cluster containing an `Email <studio>` button (only when the studio has a postcare contact email on file) + Sign out.
2. If the client has any unsigned forms, unreviewed messages, intake, or unsigned card authorization, the "Needs you" section appears next, unchanged from PR #158.
3. The next four top-level sections appear in order:
   - **Appointments**: next appointment card + "View N more upcoming" disclosure.
   - **Care instructions**: open by default. Summary line reads `"Review these before and after your appointment."` Pre-care + postcare entries render below.
   - **Forms and records**: past messages (if any) + Completed forms (if any). Form rows are quiet (no border cards). Caption verb for non-photo rows reads `"Completed "`. Footnote: `"A viewable copy of signed forms is coming soon."`
   - **Payment method**: the four-state PR #158 surface (no template / authorization needed / signed but no card / active card).
4. Click the `Email <studio>` button in the header. A `mailto:` should open with the subject `Question about my <studio> appointment` pre-filled.
5. Confirm the legacy "Your info" wrapper heading is gone and the bottom "Need help?" section is gone.
6. Smoke the PR #158 guidance once more: for a client with unsigned card authorization, the "Card authorization needed before adding a card" placeholder still renders inside Needs you, and clicking "Review card authorization" still scrolls to the unsigned-forms block via `#forms-to-sign`.

## Card authorization guidance (PR #158)

After deploy, the operator should confirm the client portal and the matching practitioner card render the new explanatory copy.

### Portal (client view)

1. Log into a test client portal at `https://hone.care/portal` (use the magic-link flow) for a client whose studio has an active `card_authorization` template AND the client has NOT yet signed it AND has no card on file.
2. Expect "Needs you" to surface:
   - The `card_authorization` template inside the "Review and sign forms" block.
   - A second calm placeholder titled `"Card authorization needed before adding a card"` with the supporting copy (`"Before you can add a card on file, please review and sign the card authorization form above."` and `"Once that form is signed, the secure card form will appear here. No charge will be made when you add a card."`).
   - A dark `Review card authorization` button. Clicking it scrolls to the "Review and sign forms" block above.
3. Sign the form. The page revalidates; the placeholder disappears and the Add card form appears with supporting copy `"You have signed card authorization. You can now add a card on file."` and `"No charge will be made when you add a card."`.
4. Add a test card. The Add card surface goes away; the "Your info" zone now shows the card summary with a Replace card button.
5. As a separate check, open the portal for a studio with NO active `card_authorization` template at all. "Your info" shows the State A copy: `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."`

### Practitioner (client profile view)

1. Open `/clients/<id>` for the same test client. The "Payment method" card should mirror the portal state:
   - Before signing: yellow/amber block, heading `"Card authorization not signed"`, body explaining the Ask the client to open their portal step.
   - After signing, before adding the card: neutral block, heading `"Card authorization signed, but no card is on file yet."`
   - After the card is added: brand/last4/expiry summary with the authorization-signed timestamp.
   - If the studio has no template at all: amber block, heading `"Card authorization template not configured"`.
2. On a cancelled appointment for the same client (calendar detail), open the manual fee card. The blocked reasons should reflect the new wording: `"Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared."`

## Client profile appointment timeline (PR #157)

After deploy, the operator should confirm the new Sessions-tab timeline behaves correctly:

1. Open `/clients/<id>` for a client with at least one appointment in any status.
2. Switch to the **Sessions** tab.
3. Expect an **Appointments** section at the top with one or more of these groups visible (only non-empty groups render):
   - **Upcoming**: future confirmed appointments. Action: Open appointment.
   - **Needs charting**: past confirmed/completed appointments with no linked session yet. Action: Chart session (plus Open appointment).
   - **Charted**: appointments with a linked session via `appointment_id`. Action: View session (plus Open appointment).
   - **Cancelled**: status cancelled. Shows `cancelled_at` and `cancellation_reason` when present. Action: Open appointment (plus View session in the rare-case linked).
   - **No-show**: status `no_show`. Action: Open appointment (plus View session if linked).
4. Each row shows date/time with AM/PM in the user's browser timezone.
5. Click a **Needs charting** row's "Chart session" button. The destination page should show "Linking this session to the selected appointment." and the URL should carry `?appointment_id=<uuid>`.
6. After picking a modality, the new session row in DB should have `appointment_id` populated:
   ```sql
   select id, appointment_id from public.sessions
   where id = '<new session id>';
   ```
7. Return to the client profile Sessions tab. The same appointment now appears under **Charted**, not **Needs charting**. Click View session to confirm the link points at the new session.
8. The top-level **+ Log session** button still works for the client-scoped case and creates `appointment_id = NULL`.

## Migration 0068 verification (PR #156)

After `supabase db push --linked` lands `0068_sessions_appointment_link.sql`, run the following to confirm the column, FK, and indexes are in place. Do NOT run an UPDATE backfill from this recipe; ambiguous matches must stay null.

```sql
-- 1. Column shape
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sessions'
  and column_name = 'appointment_id';
-- expect: appointment_id | uuid | YES

-- 2. FK definition
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.sessions'::regclass
  and conname ilike '%appointment%';
-- expect: a single row with "FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL"

-- 3. Indexes
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'sessions'
  and indexdef ilike '%appointment_id%';
-- expect: sessions_appointment_id_idx + sessions_studio_appointment_idx, both partial on (appointment_id is not null)

-- 4. Row counts (read-only)
select
  count(*) filter (where appointment_id is not null) as linked_sessions,
  count(*) filter (where appointment_id is null)     as unlinked_sessions
from public.sessions;
-- expect immediately after deploy:
--   linked_sessions = 0
--   unlinked_sessions = current total session row count
-- The linked count climbs only as new appointment-context "+ Chart session" runs.
```

## Quick Import smoke (PR #257)

Quick Import V1 lives at the owner-only `/settings/import` (Settings → Import; the tab shows only for owners). It brings clients + basic historical treatment memory over from CSV/TSV **paste or file**, **preview-first**, into the PR #252 `imported_treatment_memories` schema. It is NOT OCR, AI, API sync, merge, overwrite, or live charting. **Access (non-destructive):** anonymous `curl -sI https://hone.care/settings/import` → `307 -> /login`; a no-studio user → `/no-access`; a non-owner practitioner sees "Only studio owners can import." **Owner flow:** Copy template → paste rows (Google Sheets/Excel TSV or CSV; include the header) → pick a Source → **Preview import** (no writes: shows source rows, grouped clients, ready/review/duplicate counts, treatment areas detected, ignored columns, per-group status chips) → **Confirm import** → summary (clients created, memories created, duplicates skipped, links to created clients). Verify: two rows for the same client (e.g. Upper lip + Chin, same email) group into **one** client with two memory rows; a row whose email/phone/name+DOB matches an existing client is **skipped** (not overwritten/merged); a same-name-only match is created with a "Review" warning, not merged; an imported client appears in Clients and its history is labelled "Imported history, not charted live in Hone." (never as charted-live, no session/appointment created). The raw pasted text is never stored or logged; no email/SMS/payment is sent. **Real imports create real `clients` rows (no hard delete; correction is owner batch soft-void), so use it for genuine setup, not throwaway tests.** Pinned by `tests/lib/import/quick-import.test.ts`, `tests/app/settings/import/quick-import-action.test.ts`, `tests/db/quick-import.db.test.ts`, and `e2e/quick-import.spec.ts`.

## Cron and reminder reliability smoke (PR #258)

**Config check (repo):** `vercel.json` `"crons"` schedules `/api/cron/materialize-recurring-breaks` at `0 8 * * *` (daily). `/api/cron/appointment-reminders` is intentionally **not** in `vercel.json` — `*/15` exceeds the current Vercel plan's once-per-day cron cap, so it runs from an **external scheduler (cron-job.org) every 15 minutes** (`GET` with `Authorization: Bearer $CRON_SECRET`). `/api/cron/no-show-check` is absent (disabled stub). **Auth check (prod):** an unauthenticated `curl -sI https://hone.care/api/cron/appointment-reminders` returns `401` (the route requires `Authorization: Bearer $CRON_SECRET`; the env var must be set in the Vercel project AND the external scheduler must send the same bearer). **Reminder coverage:** the 2h reminder window is `now+105m … now+135m` (30 min); at the every-15-min cadence every appointment minute offset is covered and a single skipped fire still leaves a grid point in-window — proven deterministically by `tests/lib/cron/reminder-schedule.test.ts` (and that suite fails for the old hourly + 30-min combination). So the external scheduler MUST be set to ≤15-minute cadence. **Post-deploy (operator):** confirm the external scheduler is hitting `/api/cron/appointment-reminders` every 15 min (its run history shows `200` + `{ ok: true, reminder_24h, reminder_2h, ... }`) and the Vercel dashboard → Cron tab lists the daily materialize-recurring-breaks job with recent successful runs. If a reminder exhausts 3 attempts a `reminder_send_exhausted` ops alert (warning) is recorded with non-sensitive metadata only (no client email/phone/notes/token). Reminders are only sent for appointments still `status='confirmed'` at send time. Live payments remain disabled.

## Reminder cron status signal smoke (PR #265)

Confirms the external reminder scheduler is operator-visible. **Read-only; no app run, no real cron fire, no production writes.** Primary coverage: `tests/lib/cron/reminder-heartbeat.test.ts` (pure healthy/stale/missing classifier) + `tests/app/cron/reminder-heartbeat-wiring.test.ts` (heartbeat written only after the auth gate, non-sensitive payload, fail-open, admin surfacing) — run `npm test`. **Operator check (`/admin`, read-only):** open the admin console → the **"Reminder scheduler"** card shows **Healthy** with a recent "last successful run" when the external scheduler (cron-job.org) is firing every 15 min; it flips to **Stale** if the last success is over ~45 min old, and **Missing** if none is recorded. The heartbeat carries only a timestamp + aggregate counts — no client email/phone/name, notes, token, URL, or `CRON_SECRET`. If stale/missing: verify the external scheduler is enabled and the `Authorization: Bearer $CRON_SECRET` header matches, then check `/admin/ops-alerts` for `cron_route_failed` / `reminder_send_exhausted`. No reminder-send behavior changed; Stripe gates unchanged; live payments remain disabled.

## Before Today imported memory smoke (PR #259)

Imported (paper/Jane/spreadsheet) treatment memory from Quick Import now appears in the **Before Today** briefing on the client Overview (`/clients/<id>`), read-only and clearly labelled. **Manual (owner):** import a client with at least one treatment-memory row via Quick Import (Settings → Import; e.g. a row with `treatment_area`, `last_visit_date`, `probe_lot`, `tolerance`, `reaction`), then open that client. Confirm the Before Today card shows a distinct **"Imported treatment memory"** section (amber, separate from the blue Hone-charted "Remember today" / "Last treatment" sections) carrying the provenance line **"…not charted live in Hone."**, the source label (e.g. "Imported from paper card"), the date, the treatment area, and chips for modality/probe/lot/tolerance/reaction when present; if the client has more than 5 imported records it shows "Showing the latest 5 of N imported records." The section appears **even when the client has no live charted history** (the card still says "No charted treatment history yet" for the live part). Verify: voided imported rows do NOT appear; no edit/void/merge/convert controls exist; the page does not scroll sideways on a phone; other studios' imported memory never appears (studio+client-scoped RLS). The data behaviour (void-exclusion, newest-first order, cap, provenance labels) is proven by `tests/lib/imported-treatment-memory.test.ts`; the wiring + section by `tests/app/clients/before-today.test.ts`; the full chain by `e2e/before-today-imported.spec.ts`. Live payments remain disabled.

## Rate-limit production env gate smoke (PR #262)

**Config check (repo):** `package.json` `build` runs `node scripts/check-production-env-gates.mjs && next build`. The gate fails the build when `UPSTASH_REDIS_REST_URL` or `UPSTASH_REDIS_REST_TOKEN` is missing **and** `VERCEL_ENV === "production"`; it is a no-op SKIP for local/CI/preview builds (deliberately NOT keyed on `NODE_ENV`, which `next build` sets to `production` everywhere). Run it directly (non-destructive, no writes): `VERCEL_ENV=production node scripts/check-production-env-gates.mjs` with both vars unset → exits `1` and names the missing var(s); with both set → `PASS` exit `0`; without `VERCEL_ENV=production` → `SKIP` exit `0`. It prints variable **names only, never values**. **Deploy check (prod, operator):** the Vercel Production environment MUST have both Upstash vars set or the production build fails loudly (no silent fail-open). A transient Upstash **outage** does NOT trip the gate (the vars stay set) and is handled at runtime by the deliberate, logged fail-open (`ratelimit_backend_unavailable`). There is no emergency bypass. **Runtime (unchanged):** public limiter behavior is unchanged; missing config in production still logs `ratelimit_disabled_env_missing` once per cold start. Pinned by `tests/scripts/check-production-env-gates.test.ts`. Live payments remain disabled.

## Payment outcome zero-row detection smoke (PR #263)

Confirms payment-outcome writes never treat a zero-row update as success. **Test-mode only; do NOT run real charges or mutate production payment rows.** Primary coverage is `tests/lib/billing/payment-outcome-zero-row.test.ts` (source-grep) + the existing `tests/scripts/check-stripe-gates.test.ts` — run `npm test`. **What changed:** the charge executor (`writeSucceededOutcome`/`writeFailedOutcome`), the refund helper (success + terminal-failure writes), and the four webhook reconcilers (`payment-webhook-reconciliation.ts`) each append `.select("id")` to their status-conditional outcome UPDATE and, on zero rows, record a structured `*_zero_rows` / `*_write_failed` ops_alert (and the webhook handlers return `zeroRowNoMutation` instead of claiming a reconcile) rather than silently continuing. **Operator check (`ops_alerts`, read-only, no writes):** if a payment outcome ever fails to persist, a non-PII alert appears in `ops_alerts` (safe ids + status enums only — no raw Stripe payload, card data, secret, or customer email/phone) for manual reconciliation. No payment runtime behavior changed beyond stricter zero-row detection; exactly one `paymentIntents.create` remains; live payments remain disabled.

## Raw cancellation_token column removal smoke (PR #264, migration 0091)

Confirms the legacy raw appointment token is gone at rest and links still work. **Migration 0091 is applied in production — the raw `cancellation_token` column is already dropped (local == remote, none pending); verify read-only below.** Source coverage is `tests/migrations/0091-drop-raw-cancellation-token.test.ts` (migration shape), `tests/db/appointment-token-hash.db.test.ts` (DB lane: hash-only storage, the raw column is gone → INSERT errors `42703`, RPCs reject a raw token, hash lookup still cancels/reschedules), and `tests/app/book/no-raw-appointment-token.test.ts` (no app reads/writes the raw column) — run `npm test` + `npm run test:db` (local Supabase / CI only).

**Schema check (prod, after the migration, read-only):**
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='appointments'
   and column_name in ('cancellation_token','cancellation_token_hash');
```
Expected: only `cancellation_token_hash` is returned; `cancellation_token` no longer exists.

**Behavior check (no production writes):** a previously-emailed `/cancel/<raw>`, `/reschedule/<raw>`, and `/manage/<raw>` link still resolves (the route hashes the URL token and matches the backfilled `cancellation_token_hash`); a fresh booking's confirmation links resolve; `/cancel/not-a-real-token` still shows the generic neutral error. No raw token is stored, and none is logged. Stripe gates unchanged; live payments remain disabled.

## Intake review flags smoke (PR #266)

Confirms practitioner-only intake review flags surface existing intake answers for review — **read-only; no production writes, no new fields, no migration.** Primary coverage: `tests/lib/intake/review-flags.test.ts` (pure deriver: mapping/levels/ordering, empty-and-legacy → no flags, wording safety) + `tests/app/clients/intake-review-flags.test.ts` (deriver is pure/no-I/O, allowed wording present, forbidden wording absent, card mounted on the practitioner page and NOT on the public `/intake/[token]` route) — run `npm test`. **Operator check (`/clients/<id>/intake`, read-only):** for a client whose latest recorded intake reports a flagged answer (e.g. a medical condition, a listed medication, scars-easily, an active cold sore, recent sun), the **"Intake review needed"** card appears above the answer grid, each item showing a level pill — **Medical authorization may be required** / **Review before treatment** / **Precaution noted** — its category, and a "Based on intake response: …" basis line, closing with "Use professional judgment and clinic policy." A clean intake (or an older intake predating these questions) shows **no** flags card. Verify the wording uses ONLY the allowed phrases (and none of the forbidden clinical-decision terms), and that flags never appear on the client-facing `/intake/<token>` page. Live payments remain disabled.

## Intake modality-specific review flags smoke (PR #267)

Confirms chart-mapped flags carry **modality/category badges** from Chloe's clinic reference chart — **read-only; no production writes, no migration, no image/OCR/AI.** Primary coverage: `tests/lib/intake/review-flags-modality.test.ts` (chart mapping per condition, unmapped rows not invented, free-text never parsed, badge wording safety) + the extended `tests/app/clients/intake-review-flags.test.ts` (badges render practitioner-only via `MODALITY_WORDING`, never on the public route) — run `npm test`. **Operator check (`/clients/<id>/intake`, read-only):** for a client whose latest recorded intake reports e.g. a heart condition / pacemaker, the flag shows badges **"Review before continuous/galvanic current"** + **"Medical authorization may be required"**; blood-borne (hepatitis/HIV) shows **"Review before thermolysis"** + **"Review before continuous/galvanic current"**; a generic diabetes answer shows the conservative union of its chart rows. Conditions with no chart row keep the generic review/precaution badge; nothing is invented for chart rows with no structured intake field. Badges use ONLY the allowed phrases, the avoided clinical-decision wording never renders, and badges never appear on the client-facing `/intake/<token>` page. This is practitioner workflow support, not a medical decision. Live payments remain disabled.

## Chart parts / treatment area visibility smoke (PR #268)

Confirms the charted **treatment area** is visible across charting, saved entries, and treatment memory — **charting context only; read-only; no production writes, no migration, no image/upload/sketch/OCR/AI.** Primary coverage: `tests/app/clients/chart-parts-area.test.ts` (memory card labels the area + "Area not recorded" fallback + "Latest recorded setup — <area>" + "Imported area"; saved entries show a "Recorded area" / "Area not recorded" eyebrow; no Jane CDN/thumbnail asset URL anywhere) + the extended `tests/app/clients/before-today.test.ts` (latest setup tied to its area) — run `npm test`. **Operator check (read-only):** chart a session area (e.g. "Chin (Left)") on `/clients/<id>/sessions/<id>` and confirm the saved block shows a **"Recorded area"** eyebrow with the area; open the client Overview and confirm Before Today shows **"Treatment area: …"** and **"Latest recorded setup — Chin"**; a legacy block / last session with no structured area shows **"Area not recorded"**; imported history shows **"Imported area: …"** inside its separate amber section. Reuses existing `session_blocks` area fields (migration 0039) — no schema change. Jane was product-category inspiration only; no Jane assets/UI/thumbnails are present. Live payments remain disabled.

## Visual treatment-area picker smoke (PR #269)

Confirms area selection reads as a **visual chart part** in charting — **read-only; no production writes, no migration, no image/upload/sketch/canvas/OCR/AI.** Primary coverage: `tests/app/sessions/visual-area-picker.test.ts` (the `AreaPicker` maps the `AREA_REGIONS` catalog into region-grouped chips with selected state; the charting form frames it as a "Chart part" / "Treatment area" card with "Choose the area for this chart entry" + a live "Area being charted: …" preview + "Area not recorded" fallback; reuses `primary_area`/`side`/`custom_area_detail`; no upload/canvas/OCR/Jane asset) — run `npm test`. **Operator check (read-only):** open a session block setup on `/clients/<id>/sessions/<id>` and confirm the **"Treatment area"** chart-part card shows region-grouped area chips (Face & neck / Torso / Limbs / Intimate + "Other"); picking a chip highlights it and updates **"Area being charted: Upper lip"** (adds side, e.g. "Left underarm", and specifics); clearing shows **"Area not recorded"**; saved entries still show the PR #268 "Recorded area"; Before Today still shows the PR #268 treatment-area context. Simple visual grouped picker only — no anatomical body-map/image/upload/drawing (deferred). Live payments remain disabled.

## Body-map treatment-area picker smoke (PR #270)

Confirms the built-in **body-map** picker — **read-only; no production writes, no migration, no image/upload/canvas/drawing/OCR/AI.** Primary coverage: `tests/app/sessions/body-map-area-picker.test.ts` (`BODY_ZONES` map only onto existing `AREA_REGIONS` keys and cover every canonical area; `zoneForArea` routes canonical/custom/empty; the component renders an inline `<svg>` schematic with clickable `aria-pressed` zones and no upload/canvas/OCR/Jane asset; the form renders `BodyMapAreaPicker` above the list `AreaPicker`; the treatment-plan editor stays on the unchanged `AreaPicker`) — run `npm test`. **Operator check (read-only):** open a session block setup on `/clients/<id>/sessions/<id>` → the **"Body map"** shows a schematic body figure; clicking a zone (e.g. Face) reveals its area chips (Upper lip, Chin, …); picking one sets **"Area being charted: Upper lip"** and the same value appears selected in the **"Or choose from the list"** `AreaPicker` below; side + specifics still work; clearing shows **"Area not recorded"**. Built-in schematic only — not an uploaded body chart, image, drawing, or annotation (deferred). The treatment-plan editor is unchanged. Live payments remain disabled.

## Secure treatment image storage smoke (PR #271, migration 0092)

Confirms practitioner-only, private image storage. **Migration 0092 is applied in production — the `treatment_images` table exists and the private `treatment-images` bucket exists with `public=false`; Treatment Photos is live.** Primary coverage: `tests/lib/images/treatment-images.test.ts` (MIME allowlist jpeg/png/webp, reject SVG/PDF/oversize, filename sanitize, server-derived studio-prefixed path), `tests/migrations/0092-treatment-images.test.ts` (SQL pin: bucket `public=false`, table + FKs, RLS member policies, no-delete + revoke truncate/delete, storage.objects studio-scoped), `tests/app/clients/treatment-images.test.ts` (signed-URL-only / never `getPublicUrl`, service-role gated by a studio re-check, no public/token route imports the feature, no OCR/AI/Jane) — run `npm test`. **DB-lane (local/CI Supabase only):** `tests/db/treatment-images.db.test.ts` (cross-studio read blocked, member read/insert ok, cross-studio insert denied, soft-delete via `deleted_at`, hard-DELETE/TRUNCATE forbidden) — run `npm run test:db`. **Operator check (read-only on the surface; do not upload production data without explicit approval):** on `/clients/<id>/images` (the **Treatment Photos** tab-bar link) attach a JPEG/PNG/WebP → it lists with "Uploaded <date>"; "View" opens a short-TTL signed URL; "Archive" soft-deletes; the bucket has no public URL and no client/booking/portal/token route shows treatment images. Private storage, practitioner-only, no annotation/OCR/AI (deferred). Live payments remain disabled.

## Treatment Photos gallery UI smoke (PR #272)

Confirms the "Treatment Photos" UI polish — **UI/navigation only; no storage/RLS/signed-URL/validation/security change, no migration.** Primary coverage: `tests/app/clients/treatment-photos-ui.test.ts` (tab bar surfaces a "Treatment Photos" route link; page heading + private wording; styled "Choose image" card with the accessible native `type=file` input + image MIME allowlist; "Selected image" display + "Attach image" disabled until a file is chosen; gallery grid with View/Archive + empty state; manager calls only the existing actions and adds no storage/OCR/AI/annotation) — run `npm test`; PR #271 image tests still pass. **Operator check (read-only):** open a client record → the client tab bar shows a **Treatment Photos** tab/link (no longer buried under Health & Forms) → `/clients/<id>/images` shows the "Treatment Photos" heading + "Stored privately. Visible to practitioners in this studio."; "Choose image" opens the picker and shows the selected filename; "Attach image" is disabled until a file is chosen; existing photos render as a card grid with View/Archive; no photos shows "No treatment photos yet". Thumbnails deferred (viewing stays on-demand). No client/public exposure. Live payments remain disabled.

## Treatment Photos inline preview smoke (PR #273)

Confirms inline gallery previews — **preview polish only; no storage/RLS/signed-URL-security/schema change, no migration, no dependency.** Primary coverage: `tests/app/clients/treatment-photos-preview.test.ts` (page server-signs preview URLs with the service-role client after the studio-scoped load + does not pass raw `storage_path` to the client; grid renders inline `<img>` from the signed preview URL; in-app `role="dialog"` modal with "View larger" and no `window.open` primary path; modal re-signs via the existing ownership-checked action; "Image not available" fallback on `onError`; **no `getPublicUrl`/`publicUrl`** in app/lib; signed URLs not persisted; no public/token route imports the feature; no canvas/OCR/AI/Aesthetic-Record/comparison/export) — run `npm test`; PR #271 + #272 tests still pass. **Operator check (read-only):** on `/clients/<id>/images` photos appear as inline previews in the gallery grid; clicking a photo (or "View larger") opens an in-app larger preview modal (Close button, filename + "Uploaded <date>", "Stored privately…") — no new browser tab; a failed/expired preview shows "Image not available" while keeping filename/date/Archive; empty state unchanged. Signed URLs stay short-TTL, practitioner-only, never public, never stored. Live payments remain disabled.

## Treatment photo context tags smoke (PR #274)

Confirms treatment-context tags — **display-only / context-UI only; no schema/storage/RLS/signed-URL-security change, no migration, no dependency.** Primary coverage: `tests/app/clients/treatment-photo-context.test.ts` (pure units: scope label "Client photo" → "Session photo" → "Block photo" most-specific-wins; area label "Treatment area: <area · side · detail>" with the canonical side display label, "Area not recorded" when a block is attached but has no area, null when no block; UI wiring: `page.tsx` computes labels server-side + embeds `session_blocks ( primary_area, side, custom_area_detail )`, the manager renders `ContextTags` on cards + in the modal, and the client never receives raw `session_id`/`session_block_id`/`storage_path`/bucket/signed-URL text) — run `npm test`; PR #271/#272/#273 tests still pass. **Operator check (read-only):** on `/clients/<id>/images` each photo card shows a scope badge (today: "Client photo", since uploads are client-only), the "Uploaded <date>", and a muted "Clinical reference"; opening the larger preview shows the same tags + filename + "Stored privately…"; no UUIDs, storage paths, bucket names, or signed-URL strings appear in the UI. Session/block/area badges appear only once a future write-path attaches photos to a session/block. Live payments remain disabled.

## Treatment image storage boundary hardening smoke (PR #276, migration 0093)

Confirms the storage trust boundary — **hardening only; no UI/product/payment change.** Primary coverage: `tests/lib/images/treatment-images.test.ts` (the pure `validateTreatmentImagePath`: accepts a same-studio/client path; rejects wrong bucket / wrong studio prefix / wrong client prefix / traversal (raw + `%2e%2f`) / extra segment / whitespace / backslash / bad extension), `tests/migrations/0093-harden-treatment-image-storage.test.ts` (SQL pin: bucket stays private, authenticated `storage.objects` policies dropped, bucket/path CHECKs, block-requires-session CHECK, integrity trigger), and `tests/app/clients/treatment-image-hardening.test.ts` (signer + page call the validator; upload raises `treatment_image_orphan_cleanup_failed`; no `getPublicUrl`/public-route exposure) — run `npm test`; PR #271–#274 image tests still pass. **DB-lane (local/CI Supabase only):** `tests/db/treatment-image-hardening.db.test.ts` — direct authenticated `storage.objects` insert blocked + select returns 0; forged path/bucket and cross-studio client/session/block rejected; identity columns immutable; soft-archive + service-role valid inserts still work — run `npm run test:db`. **Operator check (read-only, after 0093 applied):** in the dashboard `treatment-images` is still PRIVATE (public=off); `select policyname from pg_policies where tablename='objects' and policyname like 'treatment_images_objects%'` returns 0 rows; the Treatment Photos gallery still renders previews (the service-role signer is unaffected). **Migration-first: production migration 0093 must NOT be applied until explicitly approved.** No public URLs; practitioner-only; live payments remain disabled.

## Treatment image content validation + EXIF stripping smoke (PR #277, no migration)

Confirms server-side upload content validation — **upload hardening only; no UI/product/payment change, no migration.** Primary coverage: `tests/lib/images/treatment-image-sanitize.test.ts` (sharp builds fixtures: real JPEG/PNG/WebP accepted; PDF-body-as-PNG, HTML-body-as-JPEG, SVG, HEIC container, empty, corrupt-garbage, and declared≠detected fake-MIME all rejected; **EXIF input → output has no EXIF**; output re-encoded ≠ input; content type deterministic per format), and `tests/app/clients/treatment-image-content-validation.test.ts` (the action calls `sanitizeTreatmentImage` and uploads `sanitized.bytes` with `sanitized.contentType` + `size_bytes: sanitized.bytes.length`; invalid image returns **before** any `.upload()`; orphan-cleanup preserved; sanitizer is `server-only` sharp, never calls a metadata-preserving encode, never logs bytes; no `getPublicUrl`/public-route exposure) — run `npm test`. **Operator check (read-only, no production upload):** uploading a renamed `.png` that is actually a PDF, an `.svg`, or a `.heic` is rejected with "Upload a valid JPEG, PNG, or WebP image."; a genuine JPEG with GPS EXIF uploads and the stored object carries no EXIF/GPS. No public URLs; practitioner-only; live payments remain disabled. (No DB migration — `sharp` promoted to a direct dependency; the build uses it as before.)

## Quick gates a reviewer can run

GitHub Actions CI (PR #154) runs the full validation suite on every PR. The local equivalent is:

```bash
npm run ci    # typecheck + lint + build + test + check:stripe-gates
git diff --check
```

Since PR #220 there is also a DB/RLS integration lane (separate CI job `db-integration`; LOCAL database only, never production):

```bash
supabase db start          # local Docker stack (db port 54322)
supabase db reset --local  # applies migrations 0001-current from scratch
npm run test:db            # tests/db/: RLS, triggers, claim RPCs, constraints
npm run check:db-types     # PR #221: lib/types/database.ts vs migrated schema
```

And since PR #227 a browser E2E lane (separate CI job `browser-e2e`; LOCAL stack only, never production):

```bash
supabase start -x studio,imgproxy,realtime,edge-runtime,logflare,vector,storage-api
supabase db reset --local
npm run test:e2e           # PR #227: Chromium, the core treatment-memory loop
npm run test:e2e:ui        # interactive debugging
```

One-time local setup for the E2E login: `supabase/config.toml` (untracked) must allow-list the E2E app origin for the magic-link redirect. Set `additional_redirect_urls = ["http://localhost:3111/**", "http://127.0.0.1:3111/**"]` in the `[auth]` section and restart the stack. The CI `browser-e2e` job materializes the same setting itself.

The E2E flow covers: public booking, intake wizard, REAL practitioner magic-link login (GoTrue email captured by local Mailpit; no auth bypass), Dashboard incl. the Charted-within-24h card wording, charting a treatment area (area, machine frequency, probe brand + lot, minutes, tolerance, reaction), the For-next-visit note, a second booking, Before Today memory on the client page, the filtered Client Procedure Record + print (incl. the aftercare mark), and anonymous lockout of Records/print/Dashboard. It assumes a DISPOSABLE local database and deliberately does not cover payments, SMS/email providers, multi-practitioner permissions, or cross-browser variants.

Mobile/iPad manual smoke (PR #228; the E2E lane covers the same ground with synthetic pointer events, but native gesture nuance still deserves real fingers): on an iPhone, open Dashboard, Notifications, Records, and Calendar; confirm the page cannot be dragged sideways on any of them; open the Menu button and navigate to each destination; confirm Sign out is reachable in the menu; on Calendar, scroll up/down with a finger over the grid and confirm NO booking drawer or chooser ever appears; swipe sideways within the calendar card (the week grid scrolls inside the card only); create an appointment ONLY via the "+" button at the top of a day column; on an iPad repeat the Calendar scroll/drag check. PR #241 additions (Daily Prep Brief V1): open the Dashboard and confirm a "Daily prep brief" card renders directly under Today with the subtitle "Today's recorded memory and follow-up items."; confirm a returning client with a saved next-visit note shows a "For next visit: ..." line and a recorded caution shows a "Caution noted: ..." line; confirm an appointment needing charting shows "Charting needed", an appointment with an incomplete intake shows "Intake incomplete" (or "Intake awaiting review" / "No intake on file"), and a missing probe lot or unmarked aftercare shows "Probe lot missing" / "Aftercare not marked"; confirm a brand-new client reads "No prior treatment history yet" calmly; confirm tapping a brief item opens that client's page; confirm with no appointments the card shows the calm empty state "Nothing needs special review yet."; on a phone confirm the card wraps cleanly with no sideways scroll. The brief is rules-based only (no AI, no model call); it summarizes recorded facts and takes no action. PR #249 additions (Missing Records / Follow-up Assistant V1): open the Dashboard and confirm a "Follow-up assistant" card renders under Practice Snapshot with the subtitle "Record gaps and follow-ups from recent appointments."; with a recent completed appointment that was never charted confirm a "Charting needed" item with a Chart appointment link, with a recent session whose aftercare/risks were never marked confirm an "Aftercare not marked" item, with a treatment area saved without a probe lot confirm a "Probe lot missing" item, with an intake left in progress confirm an "Intake incomplete" item, and with a for-next-visit note on a client who has no upcoming appointment confirm a "Follow-up" item; confirm tapping an item opens the linked client/session page; confirm with no recorded gaps the card shows the calm empty state "Nothing needs follow-up right now."; on a phone confirm the items stack with no sideways scroll. It is rules-based only (no AI, no model call), read-only and link-only; it flags recorded gaps and takes no action (no auto-charting, no auto-send, no auto-book, no record edits). PR #250 additions (Pilot Love Loop V1): open the Dashboard and confirm a compact "Pilot learning" card renders near the bottom (well below Today) with the copy "Notice a moment where Hone helped you remember something? Send it to Sam." and two buttons, "Send feedback" and "Know another electrologist?"; confirm the Daily prep brief and Follow-up assistant cards each show a quiet "Was this useful?" footer with Yes / Not really / Tell us what it helped with; tap "Send feedback" (or any of these) and confirm it opens the device mail composer to hello@hone.care with a safe subject like "Hone feedback: Pilot learning" and a generic body (surface + sentiment + an "(Add any details here.)" placeholder) — NO client name, phone, address, treatment detail, exposure detail, Stripe id, payment data, token, or audit JSON anywhere in the subject/body; confirm nothing is sent automatically (it only opens the composer) and there are no contact-access, referral, or tracking links; on a phone confirm the prompts and card wrap cleanly with no sideways scroll. Everything is manual mailto only — no automated outreach, no contact importing, no referral automation, no AI/model call. On the public homepage, confirm the "Built from real treatment rooms." origin-story section renders as a balanced two-column story: left has the eyebrow "Why Hone exists", the heading, body copy, and a short supporting line; right has a compact "What gets hard to remember" card (generic question rows, a blue "Hone keeps those details close to the next appointment." band, and chips Used last time / Client response / Caution note / Record gap). Confirm it does not look empty or unfinished, fills the band, and stacks copy-then-card on mobile with no horizontal overflow at phone or desktop; copy only, generic labels only, no metrics, no fake proof, no generic salon/practice-management claims, treatment-memory positioning preserved. PR #238 additions (Chloe pilot feedback cleanup): on an iPhone, tap into the header search input and confirm the page does not zoom awkwardly when the field gains focus (and pinch zoom still works everywhere); open a client and confirm the sections are a Section dropdown on the phone (Overview, Sessions, Treatment Plans, Messages, Health & Forms, Personal Notes), pick two sections and confirm each loads with the dropdown showing the picked section and no sideways scroll, then on an iPad/desktop confirm the underlined tab row is back; chart a session and confirm the Finish up section at the bottom explains that each treatment area, the next-visit note, and the risks/aftercare stamp already saved with their own buttons, then tap Done charting and confirm it exits to the client's Sessions tab (with appointment context, also confirm Review appointment & billing opens the appointment); open Records and confirm the section reads Procedure records with the helper "Use this when you need a procedure record for one client", a Choose a client picker, and unchanged filter + Print/Export behavior; open the Dashboard and confirm Today is the first section, with the Getting started card below Today only while setup steps remain and a small "Setup complete. Getting started checklist" line at the bottom once they are done. PR #237 additions (Before Today hierarchy): open a returning client (one with at least one charted session) and confirm the Before Today card reads in briefing order with Remember today as the prominent blue band on top (the For-next-visit note and any watch lines live there), then a Last treatment snapshot (date, areas, and chips for modality, machine frequency, probe, lot, energy level, minutes when recorded), then Client response (last recorded) with tolerance and reaction chips plus reaction notes when recorded, then Record reminders; open a brand-new client and confirm the empty state explains that treatment memory will appear after the first charted session; on a phone confirm the chips wrap, long notes wrap, and nothing scrolls sideways. PR #236 additions (Dashboard Today actions): open the Dashboard and confirm each Today appointment shows one obvious action button: a brand-new client reads Open client; a returning client reads Review Before Today; a completed-but-uncharted appointment reads Chart appointment with an amber Charting needed chip; a charted appointment reads View session with a Charted chip; tap the action and confirm it lands on the right page; confirm the row body still opens the appointment detail and nothing scrolls sideways on a phone. PR #235 additions (charting on a phone): from a client page tap Log session, chart a treatment area end to end (area chip, machine frequency, probe lot, minutes, tolerance, reaction chip), save, write the For-next-visit note, and mark Risks & aftercare RIGHT ON the session page (new placement; same stamp as the Records row); confirm nothing scrolls sideways and no control is clipped; reopen the client page and confirm Before Today shows the note. PR #234 additions (public client surfaces on a phone): open the public booking page, a manage/cancel/reschedule link, an intake link, and an invalid token URL at phone width; confirm none scroll sideways, forms and buttons fit, and the authenticated app header (menu/search/bell) never appears on any public page. PR #234 additions (mobile sheets): open the Menu on a phone and confirm the panel is a clean full-width sheet under the header with nothing clipped and a compact identity block; open Search via the magnifier and confirm the sheet, its input, and the Close button are fully on-screen; search a client, tap the result, then reopen and dismiss via Close and via Escape; confirm no sideways scroll anywhere. PR #233 additions (client page on a phone): open a client at phone width, confirm no sideways scroll, the name reads at a comfortable size with the Edit button beside it, Log session and Book appointment sit together, all six tabs are reachable by swiping the one-row tab bar (the bar scrolls, the page does not), and Pinned Notes renders cleanly at the top of Overview. PR #232 additions (Global Search V1): in the header, search a known client by name and by phone/email, search a treatment area or probe lot number, click a result and confirm navigation; confirm results only show your studio's data; on mobile, open search via the magnifier icon, confirm the panel fits the screen with no sideways scroll, and confirm tapping a result closes the panel and navigates. PR #231 additions: on desktop, open the account dropdown (your name, top right) and confirm the profile/studio block plus Settings, Getting Started, and Sign out, then confirm outside-click and Escape close it; on mobile, open the Menu and confirm the profile/studio block sits on top with Dashboard/Clients/Calendar/Records then Settings/Getting Started/Sign out. PR #230 additions: from Calendar or Records, tap the Hone wordmark and confirm Dashboard opens; open the Menu and tap anywhere outside it (e.g. the Hone wordmark or page content), confirm the Menu closes without navigating, and confirm it reopens normally. PR #229 additions: tap the header bell and confirm Notifications opens (badge shows the unread count); open Menu and select Records, confirm the Menu closes itself; open Menu and select Calendar, confirm it closes; open Menu on the current page and tap that page's link, confirm it still closes; confirm Sign out remains reachable in the Menu and no sideways drag returned. Live payments remain disabled.

Record Keeping per-client pull (PR #223), manual smoke: on /records → Client Procedure Records, select a client (optionally a date range), Apply filter, confirm only that client's recorded sessions show with the active-filter line; Print / Export must carry the same filter (header shows "Filtered: client ..." and the range) and a filter with no matches must print the empty state, not a broken page. Clear filters must restore the default most-recent view.

New-studio setup (PR #224): when creating a second real studio, follow docs/20_NEW_STUDIO_SETUP_RUNBOOK.md end to end; its sections 2.5 (surface verification), 3 (isolation checks), and 4 (smoke workflow) are the smoke catalogue for that operation.

Charted-within-24h card (PR #225), manual smoke: Dashboard shows the "Charted within 24h" card; with no completed appointments in the last 7 days it reads "No recent completed sessions yet."; after completing and charting an appointment the fraction increments (e.g. 1/1); completing an appointment without charting raises only the denominator.

Lighter manual checks the reviewer can run by hand for spot-checking:

```bash
# Stripe dormancy: diff-only sanity check. The authoritative gate
# is scripts/check-stripe-gates.mjs (run via npm run check:stripe-gates).
git diff | grep -E '^\+' | \
  grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'

# Em-dashes in added lines
git diff -- '*.ts' '*.tsx' '*.sql' | grep -E '^\+' | grep -c '-'

# Static stripe imports that aren't behind the existing key gate
grep -rn '@stripe/' --include='*.ts' --include='*.tsx' . | grep -v node_modules | grep -v .next
```

## What the harness cannot verify

When opening a PR, the report MUST explicitly call out which smoke steps were not run. Items that always require manual execution because GitHub Actions CI (PR #154) cannot exercise them without real credentials or a real browser:

- Anything requiring the practitioner session cookie (`/calendar/[id]`, `/settings/*`, the in-app actions).
- Anything requiring a real Resend send to a real inbox.
- Anything requiring a real Twilio SMS to a real phone number.
- Anything requiring a real Stripe test charge against the connected account.
- Anything requiring a real client portal session cookie.
- Anything requiring the Vercel production env dashboard.

The DB/RLS integration lane (PR #220) removed several items from this list: cross-studio RLS isolation, audit-trail immutability and trigger behavior, the clinical delete posture, the double-booking constraint, and the claim RPCs are now exercised on a real local database in CI instead of requiring manual SQL against production. What the DB lane still cannot verify: production-specific state (data drift, policies edited outside migrations: the prod catalog audit recipe in docs/09 remains the check for that), Stripe/Resend/Twilio behavior, and the browser.
