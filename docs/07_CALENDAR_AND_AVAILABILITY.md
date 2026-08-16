# 07 Calendar and availability

## Availability model

| Layer | Source | Behavior |
|---|---|---|
| Weekly defaults | `availability_defaults` (rows per day-of-week) | `is_open` + `open_time` + `close_time` define the studio's default window for that weekday. |
| One-off overrides | `availability_overrides` | Per-date open/close override that wins over the weekly default. Used for shortened days, holiday hours, etc. |
| Blockouts | `blockouts` | Multi-day vacation / closed dates. Closes the entire date range; public booking excludes them. |
| Timed blocks | `studio_timed_blocks` (PR #139) | Single-event blocks. May be timed (`starts_at` / `ends_at`) or all-day. Drag-to-block creates these. Excluded from public booking. |
| Existing appointments | `appointments` | Any `confirmed` appointment with `starts_at > now()` reserves its window plus `buffer_minutes_snapshot` trailing. |
| Buffer | `buffer_minutes_snapshot` on each appointment row | Frozen from `studios.buffer_minutes` at insert time via trigger. Migration 0029 added the trailing-only protected interval. |

The composite "is this slot available?" answer is computed by `lib/booking/queries.ts` server-side and used by both public booking and the practitioner Quick-Book flow.

## Practitioner calendar (`/calendar`, `/calendar/[id]`)

Day and week view. Click + drag opens the new chooser (PR #139) "Book appointment" or "Block time". Bare click opens Quick-Book (PR #128).

### Drag-to-book (PR #128)

Calendar drag selects a time range, opens `QuickBookDrawer`, pre-fills the start time + duration. The `autoOverrideRef` pattern lets the practitioner soft-override an inferred service duration without the form resetting on every keystroke. Submit creates the appointment via `bookAppointmentForClientAction`.

### Drag-to-block (PR #139)

Same drag interaction, but the chooser routes to `QuickBlockDrawer`. Submit creates a `studio_timed_blocks` row.

- **Timed block:** `studio_timed_blocks(starts_at, ends_at)` exact bounds.
- **All-day block:** synthesizes `[utc(date 00:00), utc(date+1 00:00))` so a midnight-spanning block is exclusive at the end. The studio's local timezone is used to anchor the `date 00:00`.

PR #140 / migration 0061 added an RLS policy that lets any **active** practitioner INSERT into `studio_timed_blocks` for their own studio (previously the policy was owner-only ALL, which broke the action). Owners can still UPDATE/DELETE.

### Quick-Book

Bare click on an empty slot opens `QuickBookDrawer`:

- Pre-fills the slot start.
- Service picker; duration follows the service's default unless the practitioner overrides.
- Client picker (live search) or "Add new" inline.
- Buffer-aware availability check on submit.
- Soft-override on the inferred duration (`autoOverrideRef` in `QuickBookDrawer.tsx`) so explicit edits stick.

### Appointment detail (`/calendar/[id]`)

- Briefing block: client name, pinned notes, allergies, fitzpatrick, last-session summary, treatment plan progress.
- Lifecycle actions: Mark complete / Mark no-show / Cancel / **Move** (Cancel + Move only for `confirmed + starts_at > now()`).
- Session block surface (when complete): record area + duration + equipment + notes.
- Postcare send button.
- Cancelled section (PR #144): reason label, client note, follow-up-okay badge, "Cancelled N minutes after booking" hint if applicable.
- Manual cancellation/no-show fee card (PR #145 + #146): renders only for `cancelled` / `no_show` status. Test-mode banner. Per-status panels (ready / pending_stripe / succeeded / failed / cancelled).

### Appointment preview drawer (desktop week grid)

Clicking a card on the desktop week grid opens `AppointmentPreviewDrawer` in place —
the URL stays on `/calendar`. It is the practitioner's **prep workspace**: enough to
walk into the room and take the usual next action without navigating away.

Sections: summary (client / date-time / service / status), allergies, **prep for this
client**, **intake**, **appointment notes**, then **actions**.

**It owns no business logic.** Every fact and action belongs to an authority that
already exists, and the drawer only arranges them:

| Concern | Owner |
|---|---|
| Last treatment | `loadLastChartedTreatmentForClient` — the shared newest-charted-treatment rule; rendered by the same `TodayTreatmentMemory` / `AppointmentPrepMemoryCard` pair the dashboard uses |
| Intake | `practitionerIntakeReviewHref` — the authenticated `/clients/<id>/intake` route, never the client's `/intake/<token>` page |
| Notes | `AppointmentNotesEditor` + the governed 0173 `set_appointment_notes` command |
| Reschedule | the shared `MoveAppointmentButton`, relabelled through its `label` prop (the dialog keeps its own "Move appointment" identity) |
| Cancel | `PractitionerCancelForm` → `practitioner_cancel_appointment` |
| Cancel/Move visibility | `isAppointmentCancelable` (`lib/calendar/appointment-actionability.ts`) — the ONE predicate, shared with `/calendar/[id]`, which previously held a second, slightly different copy |

**Performance.** The week RSC payload carries no clinical or prep data. Loading prep
for every appointment on screen to serve the one that gets clicked would be an N+1, so
the drawer issues **one bounded load for the clicked appointment, on open**
(`loadAppointmentPreviewAction` → `lib/calendar/appointment-preview-detail.ts`). Cost is
constant in the size of the week: one studio-scoped appointment read, then a parallel
wave of the intake read and the shared last-treatment authority.

**Authority.** The action re-derives practitioner + studio server-side on every call.
The browser supplies only an appointment id, and it is a pointer, never authority — an
id from another studio resolves to "not found in this studio". The read is RLS-scoped
(`createClient()`), never service-role.

**Freshness and races.** Action gating uses the **re-read** status, not the possibly
stale week payload, so an appointment cancelled in another tab is not still offered
Cancel. A practitioner scanning a week clicks fast, so more than one load can be
outstanding, and **server actions carry no documented ordering guarantee**. Every
response must therefore satisfy `shouldApplyPreviewResponse`
(`app/(app)/calendar/preview-request.ts`): it must be the newest request issued **and**
describe the appointment currently open. Otherwise appointment A's late payload would
render under appointment B's name — a clinical mis-read, not a cosmetic glitch.

Stated honestly: Next.js *currently* dispatches server actions serially, so B is not
sent until A settles and the late-A case is not reachable from the UI today. The guard
does not rely on that — it is defence in depth against an undocumented implementation
detail, and it goes live the moment the load moves to a route handler. Its logic is
proved directly in `tests/app/calendar/preview-request.test.ts`; the e2e spec asserts
the end state a practitioner would actually see (switching from A to B never leaves A's
prep on screen) and says so rather than claiming to have won a race it cannot stage.

The mobile day view is unchanged: it still navigates to `/calendar/[id]`.

## Move appointment (practitioner) — migration 0133

A practitioner can move a `confirmed`, still-future appointment to a new time. Unlike the
**public reschedule** flow (which cancels the old row and creates a new one, so the id
changes), a **move UPDATES the same appointment row**: the id, client, service,
practitioner, payment records, and any linked clinical session are all preserved — only
`starts_at` / `ends_at` change. Trigger-owned derived fields (`buffer_minutes_snapshot`,
`blocked_ends_at`, the `studio_calendar_reservations` shadow, `sync_version`) re-derive
themselves; the move code never writes them.

**One shared workflow across every viewport.** The same `MoveAppointmentDialog` +
`MoveAppointmentButton` + the two server actions in `move-appointment-actions.ts` drive
the move on mobile (full-width bottom sheet), tablet, and desktop (centered modal). Entry
points: the appointment detail page (`/calendar/[id]`, all viewports) and the desktop
in-grid preview drawer. There is no separate mobile/desktop mutation path.

- **Atomic backend** — `public.practitioner_move_appointment(...)` (SECURITY DEFINER,
  hardened `search_path`, `service_role`-only EXECUTE). It re-checks the caller is an
  active practitioner of the studio, locks the row (`FOR UPDATE`), enforces
  `confirmed + future`, applies **optimistic concurrency** (the caller's expected
  `starts_at`/`ends_at` must still match — two concurrent moves cannot both win), keeps the
  duration, `UPDATE`s the one row, and writes a `moved` `appointment_audit` event. It does
  **not** catch the GiST exclusion violation (`23P01`); a double-book / block / break /
  blockout conflict bubbles up and the server action maps it to safe copy. On conflict the
  transaction rolls back — the appointment does **not** move.
- **Slot list** — `loadMoveSlotsAction` calls the shared `getAvailableSlots` generator with
  a server-only `excludeReservation` for the appointment's OWN shadow reservation, so its
  current time is offered again while **every other** reservation still blocks. The id fed
  to the exclusion is resolved server-side, never from the browser.
- **Timezone** — the chosen studio-local date + time is converted to a UTC instant with the
  studio timezone (`utcInstantFromLocal`, DST-correct), never the browser timezone.
- **Notification** — after (and only after) the commit, a best-effort, PHI-free
  "your appointment time has changed" **email** is sent (stateless HMAC manage/reschedule
  link; it does **not** reuse the one-time confirmation claim). A provider failure returns
  `degraded` and records a safe ops signal — it never reports the move as failed. SMS for
  moves is deferred (the SMS paths claim the confirmation slot; a dedicated moved-SMS type
  would need a migration).
- **Boundary** — the move touches no Google Calendar sync control and no Stripe state. It is
  additive: migration 0133 adds only the one RPC.

### Two modes (available times + owner custom-time override)

Move has a **closed mode contract** (`mode: "available_slot" | "custom_time"`); an unknown
mode is rejected. Both modes go through the SAME `moveAppointmentAction` + the SAME 0133 RPC
— no second mutation path, no migration change.

- **Available times (default, every authorized practitioner).** The dialog shows generated
  slots. On submit the server **recomputes** the offered slots (same studio / duration /
  own-reservation exclusion) and requires the submitted time to match a current slot **by
  start instant** — browser state is not proof, so a crafted request for a time that was
  never offered is refused (`"That time is no longer available…"`) before the RPC is called.
- **Custom time (owner-only override).** `loadMoveSlotsAction` returns
  `canUseCustomTime = true` **only** when the live server-resolved `practitioner.role ===
  "owner"`; the UI renders the custom option solely from that flag, and the action
  re-authorizes on submit. The owner enters a studio-local time (native `<input type=time>`,
  15-min step) that **may be outside published operating hours**, and must tick
  *"I understand this time overrides regular availability."* (`outsideAvailabilityConfirmed`).
  A non-owner request is rejected (`"Only the studio owner can move appointments outside
  regular availability."`); a missing acknowledgement is rejected too.

Custom time overrides **only** the studio's published availability. It does **not** bypass any
concrete reservation: the RPC has no operating-hours gate, so an out-of-hours move still
succeeds only when no confirmed appointment, buffer, timed block, recurring-break occurrence,
or full-day blockout conflicts — otherwise the GiST `23P01` rolls it back and the appointment
stays put. Owner role, studio, and practitioner are always resolved server-side; `role` /
`isOwner` / `studioId` / duration / end-time are never accepted as browser authority.

## Public booking exclusion of blocks

The slot-list computation in `fetchPublicAvailableSlotsAction` walks the studio's open window for the requested date and excludes:

1. Any time range covered by a `blockouts` row for that date.
2. Any time range covered by a `studio_timed_blocks` row (timed or all-day).
3. Any time range covered by an existing `confirmed` appointment + its trailing `buffer_minutes_snapshot`.

Only the remaining sub-windows produce bookable slots. The trim happens server-side; the client never sees blocked time as bookable-then-rejected.

## Visual style for blocks (PR #138)

Blocked time renders with a warm-tan background (`#F4F1EA`), a calm border (`#C9C4B6`), an `#8C8579` left accent, `#3F3F3F` text. Hover styles are in Tailwind classes (PR #138 also fixed a hover-precedence bug where an inline style was beating Tailwind hover).

## Calendar feed (`/calendar-feed/<token>.ics`)

Read-only iCal subscription per practitioner.

- `practitioners.calendar_feed_token_hash` is the bearer credential lookup. **CORRECTION (2026-07-27): storage is HASH-ONLY** — migration **0116 dropped the raw `practitioners.calendar_feed_token` column**; the raw token is surfaced only once at generate/rotate. Existing subscriptions kept working (hash lookup), no reconnect was needed. The earlier "token storage is raw today" note and its deferred-hardening list ([docs/03](./03_SECURITY_AND_PRIVACY.md) §8).
- 30-day past + all future window.
- `SUMMARY` is always "Hone appointment" (no service name; lock-screen safe).
- `DESCRIPTION` includes client name, modality (`Electrolysis / Laser / Consultation`; generic, not the specific service name), a `View in Hone` link to `/calendar/<id>` (which is auth-gated).
- Cancelled appointments excluded.
- No intake responses, allergies, EpiPen flags, prices, session notes ever appear.
- Cache headers: short max-age + must-revalidate so token rotations propagate fast. No CDN caching.
- Token route privacy headers (`X-Robots-Tag`, `Referrer-Policy`) apply per `next.config.ts`.
