# 02 Domain model

Every business object in Hone is **studio-scoped**. The `studio_id` column appears on every table that holds practice data; RLS uses `is_studio_member(studio_id)` to gate read access. Cross-studio data sharing does not exist by design.

## Core objects

### Studio (`studios`)
- Represents one practice. Pilot studio: Willow Electrolysis.
- Carries the studio's name, slug (public booking identifier, not a token), timezone, branding, cancellation/no-show policy text, postcare aftercare text, SMS toggles, late-cancel/no-show fee amounts.
- Created by hand. Self-serve onboarding is not built.

### Practitioner (`practitioners`)
- One row per `(studio_id, user_id, role)` triple. Roles: `owner`, `practitioner`.
- Linked to Supabase Auth user via `user_id`.
- Carries `display_name`, `color`, `calendar_feed_token`, `active`.
- The owner can change studio settings; non-owner practitioners can run sessions and chart.

### Client (`clients`)
- Belongs to one studio. The same person can be a client of multiple studios; each gets a separate `clients` row.
- Carries name, normalized_email, phone, pronouns, allergies, fitzpatrick_type, skin_notes, status (`active` / `archived`).
- Archived clients are read-only across the app and cannot receive new appointments or messages.
- Mental model: the `clients` row is the studio's record of this person. The same email may exist on two studios' `clients` tables; portal sign-in is studio-scoped (`/portal/login?studio=<slug>`) when the same email lands on multiple.

### Service (`services`)
- Studio-defined offering. Modalities: `electrolysis`, `laser`, `consultation`.
- Carries `default_duration_minutes`, `price_cents`, `active`. Free consultations (`price_cents = 0` or `modality = 'consultation'`) are treated specially in the readiness checklist and are exempt from the future card-required flow.

### Appointment (`appointments`)
- One booking. Status union: `confirmed`, `cancelled`, `completed`, `no_show`.
- Belongs to one studio, one client, one service, one practitioner.
- Carries `starts_at`, `ends_at`, `duration_minutes`, `notes`, `cancellation_reason` (free-form text label snapshot since PR #144), `cancelled_at`, `cancelled_by`, `cancellation_token_hash` (SHA-256 of the high-entropy cancel/reschedule/manage bearer token; the raw token is never stored — PR #260, and the legacy raw `cancellation_token` column was dropped in PR #264 / migration 0091), `buffer_minutes_snapshot` (frozen from `studios.buffer_minutes` at insert time via trigger), email send-tracking columns.
- Created by either public booking (`app/book/[slug]/actions.ts`) or practitioner booking (`app/(app)/calendar/actions.ts`).

### Appointment audit (`appointment_audit`)
- Append-only history of state-changing events on an appointment.
- `actor_type` ∈ `practitioner / client / system`. `action` is the verb. `details` is JSON.
- For client cancellations (PR #144), `details` includes `{source: 'public_token', reason, reason_label, note, follow_up_allowed}`.
- For practitioner cancellations (migration 0033), `details` includes `{source: 'practitioner_action', reason, role}`.
- Studio-member read via RLS; insert-only by the cancellation RPCs.

### Treatment plan (`treatment_plans` + `treatment_plan_areas`)
- Multi-area plan with timeline (PR #51). Status: `in_progress` / `paused`. Each area row records the body area, target sessions, intervals.

### Practitioner notifications (`practitioner_notifications`, PR #164)

Business events for the practitioner workflow. **Separate from `ops_alerts`** (PR #153 / migration 0067), which captures system/operator failures for Sam. `practitioner_notifications` captures things Chloe cares about: a new public booking, a client cancellation, a client reschedule.

- **Visibility:** studio-wide in v1. Every authenticated studio member sees every row for their studio (`is_studio_member(studio_id)` RLS). `practitioner_id` is stored but not yet used for per-practitioner filtering; a future PR can tighten without another migration.
- **Write path:** server-only via `lib/notifications/practitioner-notifications.ts:recordPractitionerNotification`. Uses the admin/service-role client because the three event sources (public booking, public cancel, public reschedule) are anonymous visitor / token-bearing flows that cannot satisfy the member-RLS insert policy. The helper is the trust boundary: all fields are derived server-side from already-committed appointment/client/studio rows.
- **Read + mark-read path:** authenticated RLS client. `/notifications` page reads via `createClient` (RLS-scoped); the `markAllNotificationsAsReadAction` server action updates `read_at` scoped to the resolved studio.
- **Never-throws contract:** the write helper is fire-and-forget; the caller does not await it and a failure inside the helper logs to `ops_alerts` via the existing `recordOpsAlert` path but cannot roll back the booking / cancel / reschedule that just committed.

### Thermolysis duration (PR #165, migration 0071)

`electrolysis_entries.thermolysis_duration_seconds` is `numeric` (was `integer` in migration 0042). A thermolysis flash is often a fraction of a second; Chloe logged values like `0.15` and saw the read view collapse to `0 seconds` because the integer column was truncating at insert. The widened column carries decimals losslessly; the form input uses `step="0.01"` + `inputMode="decimal"`, and the entry-row display routes through `lib/sessions/format-seconds.ts:formatSeconds` which yields `"0.15 seconds"` / `"1 second"` / `"2 seconds"`. Galvanic duration stays integer (Chloe did not flag it); intensity-percent fields stay integer (they are 0–100 percentages).

### Session block side label (PR #162)

`session_blocks.side` accepts the same canonical lowercase values it always has: `center`, `left`, `right`, `bilateral`, `n/a` (migration 0039 CHECK constraint + the `SessionBlockSide` TS union). The stored value did NOT change. PR #162 only changed the practitioner-facing label for `bilateral` from `"Bilateral"` to `"Both sides"` after Chloe's charting feedback ("does Bilateral mean both sides?"). The label mapping lives in `lib/sessions/side-labels.ts` and is the single source of truth for every charting surface (setup form dropdown, read-only blocks view). Saved records with `side='bilateral'` continue to render with the new label end to end.

### Session (`sessions`) and session blocks (`session_blocks`)
- A session represents the actual treatment that happened during an appointment. Created when the practitioner clicks "+ Log session" or, as of PR #156, "+ Chart session" from the calendar appointment detail page.
- Session blocks are individual treatment units (area + duration + equipment settings + notes) inside a session. PR #51 reshaped session blocks to use a structured area enum.
- **Chart parts / treatment area visible (PR #268, no migration).** The structured area (`primary_area` + `side` + `custom_area_detail`, migration 0039; chosen via the `AreaPicker` over the `AREA_REGIONS` catalog, side via the [single-source side-label helper](#session-block-side-label-pr-162)) is the first "chart part." V1 surfaces it as a labeled "Recorded area" on saved entries and a "Treatment area" line + "Latest recorded setup — <area>" on the Before Today / treatment-memory card, with an "Area not recorded" fallback for legacy blocks; imported area (`ImportedTreatmentMemory.treatment_area_text`, 0089) stays separate, labeled "Imported area." Reuse-only — no schema change; not image storage / body-map / sketch / upload / OCR / AI. Jane's "Chart Parts" guide was product-category inspiration only (no assets/UI copied). PR #269 frames the charting-form `AreaPicker` (region-grouped chips) as a visual **"Chart part" → "Treatment area" card** with a live "Area being charted" preview — still reuse-only, still a simple grouped picker. PR #270 adds a built-in **body-map** picker above it — a schematic inline-SVG body with clickable zones (`lib/sessions/body-zones.ts` `BODY_ZONES`, mapped to existing `AREA_REGIONS` keys) that set the same `primary_area`; still reuse-only, no schema change, no image/upload/canvas/OCR/AI (anatomical image storage/annotation deferred).
- Drives **treatment memory**: next-visit briefings, intake history, postcare.
- **PR #156 (migration 0068).** Sessions now carry an optional `appointment_id` FK to `appointments(id) ON DELETE SET NULL`. Two write-forward surfaces stamp the FK today:
  - **Calendar appointment detail page** "+ Chart session" affordance forwards `?appointment_id` to the new-session page; the action validates `(studio_id, client_id, practitioner_id)` lineage before stamping the FK.
  - **Client profile Sessions tab appointment timeline (PR #157)** "Chart session" link on each "Needs charting" row forwards the same query parameter.
- **PR #157.** The client profile's Sessions tab leads with an Appointments timeline that groups every appointment for the client (Upcoming / Needs charting / Charted / Cancelled / No-show). Each row shows date/time in the user's local 12-hour format, service name, status badge, and the appropriate primary affordance (Open appointment / Chart session / View session). The query helper `getAppointmentsForClientProfile` returns up to 100 rows newest-first and joins to the latest linked session via the PR #156 FK; no service role; studio + client RLS gates apply.
- Client-scoped session creation (the legacy "+ Log session" button on the client profile, no appointment in scope) continues to insert with `appointment_id = null`. Helper copy under the button labels it as the path for sessions not tied to a booked appointment. Historical sessions remain null; no backfill has been run.
- **Dedup rule for past confirmed appointments**: the PR #157 timeline reads the FK directly, so the legacy `+/- 2 hour` proximity helper (`getPastConfirmedAppointmentsForClient`) is no longer wired in the page. The helper stays in `lib/supabase/queries.ts` as a reusable utility for any future surface that needs the same dedup; its invariants are still pinned in `tests/lib/supabase/past-appointments-dedup.test.ts`.
- One session belongs to zero or one appointment. One appointment may have zero or more sessions. No unique constraint enforces one-to-one.
- **PR #190 (migration 0082), clinical memory moat.** Every session block can carry a structured client response: `tolerance_rating` (1 struggled to 5 very comfortable), `reaction_type` (allowlisted vocabulary: none / mild redness / moderate redness / swelling / sensitivity / irritation / other), `reaction_notes`, `caution_for_next_session` + `caution_note`. Captured in the one-page charting form's optional "Client response" section; all fields nullable so historical blocks render unchanged. Sessions carry `next_session_note`: the plan for the NEXT visit, written while charting this one ("Plan for next visit" card on the session page).
- **Where the memory surfaces (PR #190):** the appointment detail "Last session" card shows a compact clinical summary (areas, settings, probe, tolerance, response, caution, next-visit note); the new-session page shows a "Previous session context" panel with the same summary; the charting screen shows a "From last visit, for today" banner with the previous session's note. All three go through the unit-tested `lib/sessions/clinical-summary.ts` formatter, which nulls absent lines so old records never show empty labels.

### Intake (`client_intake_forms`)
- One per client per studio. Status: `in_progress` / `submitted` / `reviewed`.
- Token-gated edit via `/intake/<token>` (HMAC over `(intake_id, expires_at)` plus a per-intake column-based token).
- Practitioner reviews via `/clients/<id>/intake`. The review page also derives read-time, practitioner-only **review flags** from the existing `responses` answers (PR #266; `lib/intake/review-flags.ts`) — no new field/migration; surfaces answers for review only, not a clinical decision. PR #267 adds **modality/category badges** to chart-mapped flags (thermolysis / continuous-galvanic / medical authorization / precaution) from Chloe's static clinic reference chart; still derive-only, still not a medical decision.

### Portal message (`client_portal_messages` + `client_portal_message_replies`)
- One-way studio-to-client messages (PR #129/#130) with replies (PR #130 RLS hardening).
- Subject, body. Status flags for read / replied / archived.
- Practitioner sees client replies in their portal-message thread surface; an email notification with no message content fires when the client replies (PR #130 portal-side reply action).

### Consent template + signature (PR #134 / migration 0057)
- `consent_form_templates`: studio-authored. `form_type` ∈ `general / treatment_consent / policy_acknowledgement / card_authorization / photo_consent`. Versioned. Status: `active / draft / archived`. Bodies and titles are free-form text.
- `client_consent_signatures`: append-only immutable. Each row carries the full snapshot of `(title, body, version)` the client saw plus a SHA-256 hash of that tuple. Photo consent extends this with a `response` column (`accepted` / `denied`) so a deny is still a signed record (PR #137).

### Card payment method (`client_payment_methods`, PR #135 / migration 0058)
- One row per `(studio, client)` with `status='active'` (partial unique enforced).
- Carries the connected-account Stripe ids (`stripe_account_id`, `stripe_livemode`, `stripe_customer_id`, `stripe_payment_method_id`, `stripe_setup_intent_id`) and the safe card fields (`brand`, `last4`, `exp_month`, `exp_year`).
- `card_authorization_signature_id` links to `client_consent_signatures(id)`; every active card row points at the signature the client gave to authorize card storage.
- `added_via` ∈ `portal / practitioner` (only `portal` is wired today).

### Treatment image (`treatment_images`, PR #271 / migration 0092)
- Practitioner-only image storage so treatment memory can include visual reference material. `studio_id` + `client_id` are required; `session_id` / `session_block_id` are optional links.
- Bytes live in the **private** Supabase Storage bucket `treatment-images` (`public=false`); this table is metadata only (`storage_bucket`, `storage_path`, sanitized `original_filename`, `content_type`, `size_bytes`, `uploaded_by`, soft-delete `deleted_at`/`deleted_by`). studio-scoped RLS (`is_studio_member` select/insert/update, no delete).
- **No public URLs.** Viewing mints a short-TTL signed URL via a server action that re-checks the row's studio; upload + signing use the service-role client after that ownership check. Server-generated path `<studio_id>/<client_id>/<uuid>.<ext>`. Practitioner UI at `/clients/<id>/images`, surfaced as the **"Treatment Photos"** tab-bar link (PR #272 polish: styled upload card + gallery grid; PR #273: inline previews — the page server-pre-signs a short-TTL preview URL per image and the grid renders inline `<img>` + an in-app modal; signed URLs stay short-TTL, never public, never stored in the DB). Not reused: the legacy unwired `photos` table (0001). No annotation/OCR/AI/public exposure/side-by-side comparison (deferred).

### Customer mapping (`client_stripe_customers`, migration 0032)
- Maps `(client, studio, stripe_account_id, stripe_livemode)` to a Stripe Customer object on the connected account. Reused by both 0032's dormant flow and PR #135's portal flow.

### Policy acknowledgement (`appointment_policy_acknowledgements`, PR #132 / migration 0056)
- One row per `(client, appointment, action ∈ {cancel, reschedule})`.
- Carries `cancellation_policy_text_snapshot`, `no_show_policy_text_snapshot`, `policy_snapshot_hash` (SHA-256 of canonical concatenation).
- Required at cancel/reschedule time only when the studio has any policy text. PR #133 added `hasAnyPolicy()` so a studio with no policies doesn't see a confusing checkbox.

### Manual fee charge attempt (`manual_fee_charge_attempts`, PR #145 / migration 0064 + PR #146 / migration 0065)
- One per practitioner-prepared fee attempt. Status machine: `ready` → `pending_stripe` → `succeeded` / `failed`. Plus `cancelled` (practitioner withdraws before charging) and reserved `blocked` (never written by the action).
- Carries the four evidence FKs (`client_payment_method_id`, `card_authorization_signature_id`, `appointment_policy_acknowledgement_id`, `policy_snapshot_hash`), the snapshotted `amount_cents` + `currency`, the required `internal_note`, the `timing_classification = 'practitioner_asserted'`, and the Stripe result fields (`stripe_payment_intent_id`, `stripe_charge_id`, `stripe_idempotency_key`, `charged_at`, `failed_at`, `failure_code`, `failure_message`, `cancelled_at`, `cancelled_by_practitioner_id`, `cancelled_reason`).
- DB CHECK: `stripe_livemode = false`. Future live-mode PR must replace this.
- Partial unique on `(appointment_id, charge_type) WHERE status IN ('ready', 'pending_stripe', 'succeeded')` blocks double-prepare and double-charge.

### Studio timed block (`studio_timed_blocks`, PR #139 / migration 0061)
- Calendar block created by drag-to-block. All-day blocks span `[utc(date 00:00), utc(date+1 00:00))`. Member-INSERT RLS policy added in PR #140 / migration 0061 so active practitioners (not only the owner) can insert their own block.

### Studio payment settings (`studio_payment_settings`, migration 0032)
- One row per studio with `stripe_account_id`, `stripe_account_status` ∈ `pending / restricted / enabled / rejected`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_onboarding_completed_at`, `require_card_on_file` (defaults `false`; never flipped in any current code path), `default_charge_currency = 'cad'`, `stripe_livemode`.

### Session payment model (PR #169 product model; PR #172 prepare flow shipped, test-mode only)
- **Canonical charge reasons** (the only three the system supports): `session_payment` (client received treatment), `late_cancellation_fee` (client cancelled inside policy window), `no_show_fee` (client did not attend).
- **One charge primitive** parameterized by `charge_reason`. The proven `runManualFeeCharge` pattern (claim/lock + deterministic idempotency key + Stripe PaymentIntent on connected account + persisted attempt row + webhook reconciliation + ops_alert) is the contract every future charge path follows. `late_cancellation_fee` and `no_show_fee` already use it in test mode (PR #146); `session_payment` will reuse it.
- **Charge AFTER the session, not at booking.** Electrolysis final pricing varies by actual treatment time, area, practitioner judgement, discounts, and corrections. The booking price is a quote; the charge happens when the practitioner confirms the final amount at session end. Upfront-checkout is a different product and is out of v1 scope.
- **Practitioner-confirmed amount.** Auto-charge from `services.price_cents`, appointment duration, session duration, treatment area, hair count, or machine settings is forbidden. The amount is entered or confirmed by the practitioner before any Stripe call.
- **Off-session SetupIntent.** Cards saved via portal Add or Replace use `usage: "off_session"` in `lib/stripe/setup-intent.ts:202`. Every saved card can be charged later without the client present; no SetupIntent rework needed before live charging.
- **Paid status derived from charge rows.** No `appointments.paid` or `sessions.paid` boolean. The "paid" UI badge reads the existence of a `status='succeeded'` charge attempt row for the `(appointment_id, charge_reason)` pair. `sessions.price_paid_cents` (migration 0003) is a separate historical record of what the client paid, regardless of whether Hone moved the money.
- **0% Hone platform fee in v1.** `studio_payment_settings.stripe_application_fee_bps` stays null / unused; studio is the merchant of record; 100% of the captured amount (less Stripe processing) goes to the studio's connected account. Hone bills its subscription out of band, not through Stripe `application_fee_amount`.
- **No tax calculation in v1.** Practitioner enters the all-in gross amount; studio is responsible for tax pricing + remittance. Stripe Tax integration is deferred to a future PR.
- **Studio is merchant of record.** Client receipt + statement descriptor identify the studio, not Hone. Disputes are filed against the studio's connected account.
- **Risk-ordered enablement.** Live `session_payment` ships before `late_cancellation_fee` and `no_show_fee` because the client received a service (lower dispute risk vs charging a client who did not receive treatment). The DB CHECK constraint that blocks live writes is per-reason, not all-or-nothing.
- Full architecture lives in [docs/16 §12 "Session payment product model (PR #169)"](./16_LIVE_PAYMENTS_READINESS.md#12-session-payment-product-model-pr-169).
- **Prepare flow (PR #172, test mode only).** The session detail page (`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx`) now renders a `SessionPaymentPrepareCard` immediately after `SessionInfoCard`. The card resolves eligibility server-side via `lib/billing/session-payment-eligibility.ts:getSessionPaymentEligibility` and dispatches between three states: blocked (lists blocking reasons), existing prepared attempt (shows the row), or ready (form with amount + internal note). The `prepareSessionPaymentChargeAction` (`app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts`) writes one row to `public.payment_charge_attempts` with `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`, the practitioner-confirmed amount, the active card's lineage (`client_payment_method_id`, `stripe_account_id`, `stripe_customer_id`, `stripe_payment_method_id`), and the current `card_authorization_signature_id` from the PR #170 `signed_current` branch. **NO Stripe call.** No PaymentIntent. No charge. No refund. The prepare action is the first runtime writer of `payment_charge_attempts`; manual_fee_charge_attempts remains the legacy test-mode ledger for cancellation + no-show fees until a separate unification PR lands.

## Important security constraints (mental model)

- **Studio is the tenancy unit.** Every studio-scoped table has RLS that gates SELECT on `is_studio_member(studio_id)`. The same email can be a client of two studios; each studio has its own row and no cross-studio leakage.
- **Treatment images are practitioner-only + private (PR #271).** The `treatment-images` bucket is private (no public URLs); images are viewed only via short-TTL signed URLs minted server-side after a studio-ownership re-check. No client/portal/booking surface exposes treatment images.
- **Tokens are bearer credentials.** the appointment cancel/reschedule/manage token (stored hashed at rest as `cancellation_token_hash`; raw column dropped in PR #264), the portal magic-link token, the intake HMAC, the `practitioners.calendar_feed_token`. Anyone with the URL has the access it confers. Token routes carry `noindex/no-referrer` headers and never mount analytics (PR #142).
- **Card authorization is linked to the card.** `client_payment_methods.card_authorization_signature_id` is the FK; an active card without a signed authorization is a structural error and blocks fee preparation (PR #145).
- **Policy acknowledgement is linked to the appointment.** Fee preparation requires both the active card AND the specific policy ack for that appointment (PR #145).
- **Manual fee charge is evidence-gated.** The `manual_fee_charge_attempts` row carries all four FKs, the snapshotted policy hash, the practitioner id, the internal note, the deterministic idempotency key, and the test-mode-only CHECK. The future Stripe charge action (PR #146) re-validates the full chain before any PaymentIntent call.

## Where the lines are

- "Practitioner can create"; the authenticated app actions, gated by `getCurrentPractitionerWithStudio()`.
- "Client can create"; portal session actions and public token routes; the action resolves studio + client from the session/token, never from the form.
- "Public booking can create"; `app/book/[slug]/actions.ts`; the studio is resolved by slug, the client is find-or-created via the booking RPC, the appointment is inserted via a SECURITY DEFINER RPC that enforces double-booking and buffer constraints.
- "Service role writes"; webhook routes (Stripe, Twilio), the SMS RPCs (revoked from anon/authenticated in PR #141 / migration 0062), the cancel/reschedule/cancel-attempt RPCs.

Read [docs/09_DATABASE_AND_RLS.md](./09_DATABASE_AND_RLS.md) for the full migration table and the RLS audit checklist.
