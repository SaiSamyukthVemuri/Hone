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
- Carries `starts_at`, `ends_at`, `duration_minutes`, `notes`, `cancellation_reason` (free-form text label snapshot since PR #144), `cancelled_at`, `cancelled_by`, `cancellation_token` (random column-based), `buffer_minutes_snapshot` (frozen from `studios.buffer_minutes` at insert time via trigger), email send-tracking columns.
- Created by either public booking (`app/book/[slug]/actions.ts`) or practitioner booking (`app/(app)/calendar/actions.ts`).

### Appointment audit (`appointment_audit`)
- Append-only history of state-changing events on an appointment.
- `actor_type` ∈ `practitioner / client / system`. `action` is the verb. `details` is JSON.
- For client cancellations (PR #144), `details` includes `{source: 'public_token', reason, reason_label, note, follow_up_allowed}`.
- For practitioner cancellations (migration 0033), `details` includes `{source: 'practitioner_action', reason, role}`.
- Studio-member read via RLS; insert-only by the cancellation RPCs.

### Treatment plan (`treatment_plans` + `treatment_plan_areas`)
- Multi-area plan with timeline (PR #51). Status: `in_progress` / `paused`. Each area row records the body area, target sessions, intervals.

### Session (`sessions`) and session blocks (`session_blocks`)
- A session represents the actual treatment that happened during an appointment. Created when the practitioner clicks "Mark complete".
- Session blocks are individual treatment units (area + duration + equipment settings + notes) inside a session. PR #51 reshaped session blocks to use a structured area enum.
- Drives **treatment memory**: next-visit briefings, intake history, postcare.

### Intake (`client_intake_forms`)
- One per client per studio. Status: `in_progress` / `submitted` / `reviewed`.
- Token-gated edit via `/intake/<token>` (HMAC over `(intake_id, expires_at)` plus a per-intake column-based token).
- Practitioner reviews via `/clients/<id>/intake`.

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

## Important security constraints (mental model)

- **Studio is the tenancy unit.** Every studio-scoped table has RLS that gates SELECT on `is_studio_member(studio_id)`. The same email can be a client of two studios; each studio has its own row and no cross-studio leakage.
- **Tokens are bearer credentials.** `cancellation_token`, the portal magic-link token, the intake HMAC, the `practitioners.calendar_feed_token`. Anyone with the URL has the access it confers. Token routes carry `noindex/no-referrer` headers and never mount analytics (PR #142).
- **Card authorization is linked to the card.** `client_payment_methods.card_authorization_signature_id` is the FK; an active card without a signed authorization is a structural error and blocks fee preparation (PR #145).
- **Policy acknowledgement is linked to the appointment.** Fee preparation requires both the active card AND the specific policy ack for that appointment (PR #145).
- **Manual fee charge is evidence-gated.** The `manual_fee_charge_attempts` row carries all four FKs, the snapshotted policy hash, the practitioner id, the internal note, the deterministic idempotency key, and the test-mode-only CHECK. The future Stripe charge action (PR #146) re-validates the full chain before any PaymentIntent call.

## Where the lines are

- "Practitioner can create"; the authenticated app actions, gated by `getCurrentPractitionerWithStudio()`.
- "Client can create"; portal session actions and public token routes; the action resolves studio + client from the session/token, never from the form.
- "Public booking can create"; `app/book/[slug]/actions.ts`; the studio is resolved by slug, the client is find-or-created via the booking RPC, the appointment is inserted via a SECURITY DEFINER RPC that enforces double-booking and buffer constraints.
- "Service role writes"; webhook routes (Stripe, Twilio), the SMS RPCs (revoked from anon/authenticated in PR #141 / migration 0062), the cancel/reschedule/cancel-attempt RPCs.

Read [docs/09_DATABASE_AND_RLS.md](./09_DATABASE_AND_RLS.md) for the full migration table and the RLS audit checklist.
