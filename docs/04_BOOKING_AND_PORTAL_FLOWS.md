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

### Two-zone portal UX (PR #136)

The portal home (`/portal`) is reorganized into two zones:

- **Needs you**; anything that requires the client to act:
  - Outstanding intake.
  - Outstanding consent forms (treatment, photo, card authorization).
  - Unread messages from the studio.
  - Upcoming appointment with policy not yet acknowledged.
- **Your info**; passive surfaces:
  - Upcoming appointments with cancel/reschedule/manage shortcuts.
  - Signed forms (read-only view).
  - Saved card on file (brand + last4 + status).
  - Studio contact + address.

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
