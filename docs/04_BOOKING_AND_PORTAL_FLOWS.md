# 04 Booking and portal flows

## Public booking

Surface: `/book/<studio-slug>`.

```
visitor opens /book/<slug>
  -> PublicBookForm renders
  -> "Next available day" / explicit date picker (PR #131)
  -> fetchPublicAvailableSlotsAction(slug, date)
        rate-limit (Upstash, fails open)
        resolve studio by slug
        compute available windows from availability + overrides + blockouts
            and existing appointments + buffer minutes
        return slot list (server-trimmed; never includes blocked time)
  -> visitor picks slot, fills name/email/phone/notes, ticks SMS consent if shown
  -> publicBookAppointmentAction
        rate-limit
        resolve studio by slug; refuse if studio is inactive
        find-or-create client via RPC by normalized email
        validate the slot is still free; pick consultation if first-time client
        generate column-based cancellation_token
        insert appointment via RPC with double-booking and buffer guards
        insert appointment_audit row
        send confirmation email via Resend (cancel/reschedule/manage links)
        send confirmation SMS if studio + client opted in
        revalidate /calendar surfaces for the studio
  -> visitor lands on a thank-you page
```

### Referral attribution (PR #163, migration 0069)

The public booking form carries an optional **"How did you hear about us?"** dropdown after the "Anything else?" notes textarea. Options live in `lib/booking/referral-source.ts`:

| Internal value | Display label |
|---|---|
| `google` | Google |
| `instagram` | Instagram |
| `friend_or_referral` | Friend or referral |
| `existing_client` | Existing client |
| `studio_website` | Studio website |
| `other` | Other |
| `prefer_not_to_say` | Prefer not to say |

The dropdown's empty entry (`""`) means the visitor did not answer; the action layer normalises it to `null`. A non-empty value MUST be in the canonical option set; an unknown value is rejected with the visitor-facing generic booking error so a probing caller cannot enumerate the option set. No free-text "Other details" field in v1; the option list is closed.

The answer is stored as a lowercase string in the nullable `appointments.referral_source` column (migration 0069). The practitioner sees it on the calendar appointment detail page in a small "How they heard about us" row (only rendered when the value is non-null) and in the practitioner new-booking notification email body. Client-facing surfaces (confirmation email, reminder emails, portal, public booking confirmation page) deliberately do NOT render the value.

v1 is appointment-level: a returning client who books again may answer differently each time. A future PR can promote any of these values to a client-level first-touch or latest-touch attribution model without changing the per-appointment shape here.

### New / existing client split

The booking form chooses the path based on `find_or_create_client_for_booking`:

- **New client (no `clients` row in this studio):** the visitor can only pick a consultation service. The booking RPC enforces this via the `isConsultationService(service)` predicate. Reason: the studio needs a consult before any treatment.
- **Existing client:** the visitor sees the studio's full active service list. The booking proceeds as normal.

### Next available day (PR #131)

The "Next available day" button on `/book/<slug>` calls a helper that walks forward from the visitor's local "today" through the studio's booking horizon, returning the first day with at least one bookable slot. Used when the public booking horizon is long and the picker would otherwise default to a date with no availability.

### Confirmation email content

- Studio name, service name, formatted starts-at in the studio's timezone.
- `/cancel/<token>`, `/reschedule/<token>`, `/manage/<token>` links.
- Intake link if the client has an `in_progress` intake.
- Optional treatment-time hint line (`show_treatment_time_to_clients`).
- Owner-of-studio CC-style "new booking" notification email (configurable per studio via `notify_practitioner_on_new_booking`; PR #47).

## Cancel / reschedule / manage

| URL | Surface |
|---|---|
| `/manage/<token>` | Single neutral entry point added in newer email/SMS templates. Renders a summary, both policies, and two buttons: "Reschedule" and "Cancel". Lets the client choose without committing. |
| `/cancel/<token>` | Cancel surface. Policy reminder card, optional cancellation insight section (PR #144: reason dropdown / note / follow-up checkbox), reschedule nudge for schedule-shaped reasons, required policy acknowledgement before cancel. |
| `/reschedule/<token>` | Reschedule surface. Pick a new slot from the same studio's availability. Issues a new column-based token; the old appointment is cancelled with `reason='Rescheduled via email link'`, a new appointment is created via the same RPC chain. **Reschedule safety (PR #149):** every read + submit path refuses the token unless the original appointment is `status='confirmed'` AND `starts_at > now()`. The slot list hides same-day past slots via the shared `filterFutureSlots` helper. The submit action rejects `newStartsAt <= now()` before any RPC call. The `reschedule_appointment` RPC (migration 0066) independently rejects past originals and past `p_new_starts_at` as defence in depth. Public reschedule actions never return raw DB or RPC error text; failures collapse to the generic "This reschedule link can't be used right now." copy while a structured `logInternal` line records the detail server-side. |

### Cancellation reason capture (PR #144)

When the client picks a reason from the dropdown, the server validates it against `CANCELLATION_REASONS` and derives the label snapshot server-side (never trusts the form-submitted label). Audit row carries:

```json
{
  "source": "public_token",
  "reason": "schedule_changed",
  "reason_label": "Schedule changed",
  "note": "I had a conflict come up.",
  "follow_up_allowed": true
}
```

`appointments.cancellation_reason` now stores the human label snapshot (for clean rendering on the appointment detail page and CSV exports).

### Reschedule nudge

When the picked reason is `schedule_changed` or `prefer_reschedule`, the cancel form surfaces a small callout above the destructive button:

> **Would another time work better?**
> You can reschedule this appointment instead of cancelling.
> [Reschedule instead]   or continue cancelling below

"Reschedule instead" links to `/reschedule/<token>` (same token). Cancellation is never blocked by the nudge.

## Client portal

Surface: `/portal` (post-magic-link), `/portal/login`, `/portal/verify/<token>`.

### Magic-link sign-in

See [docs/03 §3](./03_SECURITY_AND_PRIVACY.md#3-portal-session-model). Generic-success response on `requestPortalMagicLinkAction` regardless of match. GET on `/portal/verify/<token>` is non-consuming so email scanners do not burn the token; POST consumes via conditional UPDATE.

### Card on file: Add vs Replace (PR #135, PR #151, PR #158)

The portal card-on-file surface has two affordances depending on whether the client already has an active card:

- **No active card AND card authorization NOT signed** (`/portal` "Needs you" zone, PR #158): the unsigned `card_authorization` template appears in the existing "Review and sign forms" block AND a calm placeholder appears in the card section explaining the implication: `"Card authorization needed before adding a card. Before you can add a card on file, please review and sign the card authorization form above. Once that form is signed, the secure card form will appear here. No charge will be made when you add a card."` A `Review card authorization` button deep-links to `#forms-to-sign` (the unsigned-forms section carries that id since PR #158). Add card is intentionally NOT rendered in this state. Chloe's smoke-test feedback ("I don't know how to add a card. It should give you instructions.") is what drove this placeholder; before PR #158 the card section was silently hidden and the only on-page mention of card_authorization was the form entry in the list above.
- **No active card AND card authorization signed** (`/portal` "Needs you" zone, only when the publishable-key gate also resolved ok): a calm "Add card on file" button mounts `PortalPaymentMethodForm` in `mode='add'`. Supporting copy reads: `"You have signed card authorization. You can now add a card on file. No charge will be made when you add a card."` Submitting confirms a SetupIntent on the connected account; the webhook's `setup_intent.succeeded` arm inserts the `client_payment_methods` row.
- **Active card on file** (`/portal` "Your info" zone, when the same publishable-key gate is open): `PortalCardOnFileCard` renders the read-only card summary AND a "Replace card" button. Replace mounts `PortalPaymentMethodForm` in `mode='replace'` with explicit copy ("Your current card will be replaced after the new card is saved. No charge will be made.") and an inline Cancel.
- **Studio has no active `card_authorization` template at all** (`/portal` "Your info" zone): a single calm line: `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."` (PR #158 replaced the prior `"Card-on-file authorization is not configured yet."` line with this wording.)

Replace reuses the same `createCardSetupIntentAction` server action. The action does not branch on the `mode` prop; it derives the client's current card state from the DB. The webhook's `setup_intent.succeeded` handler (PR #135) pre-flips any existing `status='active'` row for the `(studio_id, client_id)` pair to `status='removed'` BEFORE inserting the new active row, inside the same transaction. The PR #135 idempotency SELECT on `(studio, client, account, mode, setup_intent_id)` short-circuits a Stripe re-delivery without re-flipping the new active row to removed. The partial unique `(studio_id, client_id) WHERE status='active'` from migration 0058 is the structural backstop.

What this preserves:

- **One active card per (studio, client).** Always.
- **Card authorization signature linkage.** The replacement card still requires a signed `card_authorization` template; the latest signature row is linked via `card_authorization_signature_id` on the new `client_payment_methods` row.
- **Manual fee charge eligibility (PR #145).** The eligibility helper continues to require an active card with a non-null `card_authorization_signature_id`; after a Replace, the new active card carries the same FK, so prepared fee attempts that reference the prior `client_payment_method_id` will fail their lineage recheck. Future fee attempts pick the new card.

What Replace does NOT do:

- No card delete. The prior row stays as `status='removed'` with `removed_at` stamped.
- No charge. No PaymentIntent. No refund. No invoice. No receipt.
- No live mode. The same `STRIPE_ALLOW_LIVE_MODE=false` posture applies.
- No practitioner-side card replace UI. `client_payment_methods.added_via` accepts `practitioner` but no UI exists today.

### Portal layout (PR #136 zones, PR #159 cleanup)

The portal home (`/portal`) renders one header + one Needs you block + four top-level information sections. The legacy "Your info" wrapper used to group everything below Needs you under a single heading; PR #159 retired it after Chloe's smoke-test feedback ("the portal's a little cluttered looking").

**Header (PR #159).** Studio name eyebrow, greeting, one-line intro. Top-right cluster carries the contact-the-studio action (`Email <studio>` button, gated on `studio.postcare_contact_email`) and the Sign out button. Same `mailto:` shape as the previous bottom-of-page block; the bottom block is now removed to avoid duplicating the affordance.

**Needs you**: anything the client must act on. Renders inline cards (not links to detail pages):
- Outstanding intake.
- Outstanding consent forms (treatment, photo, card authorization). The unsigned-forms section carries `id="forms-to-sign"` since PR #158 so the card-authorization placeholder can deep-link to it. **PR #167:** only templates with `is_live=true` AND `status='active'` reach this list; draft / not-live templates stay editable in `Settings -> Consent forms` but never render in the portal. The signing action applies the same two-clause gate so a client who guessed a draft template id still gets the generic "no longer available" error rather than the legal text.
- "Card authorization needed before adding a card" placeholder (PR #158) when `card_authorization` template exists, client has not signed, and no active card.
- Unreviewed messages from the studio.
- Add card form (when `card_authorization` is signed AND no active card AND publishable key gate resolved).

**Appointments** (top-level, PR #159): next confirmed appointment + a `View N more upcoming` disclosure for later upcoming appointments. Manage / Cancel / Reschedule live on `/manage/<token>`, linked from each row.

**Care instructions** (top-level, PR #159): rendered open by default via `<details open>`. Chloe asked for this explicitly; collapsing behind a disclosure made the surface easy to miss. The summary line reads `"Review these before and after your appointment."` Pre-care entries appear before postcare entries; both sub-blocks render only when their content exists.

**Pre-appointment instructions are studio/service-owned (PR #160).** The pre-care text lives on `services.pre_care_instructions` (nullable, migration 0025) and is edited from `Settings → Services`. The same field feeds three surfaces: the portal Care instructions section (PR #159), the booking confirmation email (`buildClientConfirmationEmail`), and the 24h + 2h reminder emails (`build24hReminderEmail` / `build2hReminderEmail`). Before PR #160 the confirmation email also rendered a hardcoded "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph above the editable text; that constant was removed so Chloe (and Laura later) own the wording end to end. When a service has no prep text on file, the prep block is omitted entirely from both the email and the portal.

**Forms and records** (top-level, PR #159): read-only history grouping for past messages + Completed forms. The "Signed forms" heading is renamed to "Completed forms"; each row uses a soft border-top divider list (no bordered cards) so the surface reads as a record, not as an actionable card. Caption verb is `"Completed "` for non-photo rows; photo-consent rows retain `"Consent granted · "` / `"Consent denied · "` because the response itself is the record. Footnote: `"A viewable copy of signed forms is coming soon."` honestly sets the expectation for the future signed-form viewer.

**Payment method** (no top-level wrapper; uses the inner h3 heading shipped by PR #135): four states (no template configured / authorization needed / signed but no card / active card) per PR #158. Active card surface uses `<PortalCardOnFileCard>` with the Replace card affordance from PR #151.

### Messages and replies

PR #129 introduced one-way studio-to-client messages with client replies (PR #129) and RLS hardening (PR #130). Threads are visible in `/portal`; the client can reply from the same surface. The studio-side surface lives at the client profile.

Email notification for a reply (PR #129): when the client replies, an email goes to the studio owner with a deep-link to the client profile; no message content in the email.

### Mark reviewed

Practitioner-side message thread surface has a "Mark reviewed" action that flips the studio-side read status on the message (and on its replies). Clients do not see this state.

### Archived client behavior

`clients.status = 'archived'`. An archived client:

- Cannot receive new appointments (booking RPC refuses).
- Cannot sign into the portal (`getCurrentPortalSession()` refuses).
- Cannot receive messages (the practitioner-side compose action refuses).
- Stays visible to the studio in read-only mode.

## Edge cases

| Case | Behavior |
|---|---|
| Same email in two studios | Each studio has its own `clients` row. Portal sign-in goes through `/portal/login?studio=<slug>`; the action narrows the find-or-create to that studio. |
| Archived client tries to sign in | `findActiveClientsForPortalLogin` only returns `status='active'`. No magic link is sent; the generic success message hides the archived state. |
| Invalid / unknown / expired cancel token | All three collapse to the same generic "this cancellation link can't be used right now" message. |
| Expired portal magic link | Same collapse to the generic unavailable surface; the visitor requests a new link from `/portal/login`. |
| No availability in the booking window | `PublicBookForm` shows "no available slots in this window" plus the "Next available day" button. |
| Drag-to-block carved out of availability | The public booking slot list excludes any window intersecting a `studio_timed_blocks` row. The all-day block uses `[utc(date 00:00), utc(date+1 00:00))` so a midnight-spanning block is exclusive of the end. |

## What the cancellation flow taught us (PR #144 origin)

A real client at Willow Electrolysis booked a New Client Consultation and cancelled it 7 minutes after booking. The audit row showed `reason: ""` because the form had a free-form textarea the client left blank. Chloe could see the cancellation but not why.

PR #144 added the structured insight section (reason dropdown, optional note, follow-up checkbox, reschedule nudge) so future cancellations carry the WHY. On the practitioner side, the appointment detail page now surfaces:

- Cancellation reason label (snapshotted).
- Client note (if provided).
- "Follow-up okay" badge (if the client opted in).
- "Cancelled N minutes after booking" badge (if `cancelled_at - created_at ≤ 15 minutes`).
- Collapsible suggested follow-up message (template; practitioner copies into an email manually; no auto-send).
