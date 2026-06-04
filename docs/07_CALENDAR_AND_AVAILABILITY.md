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
- Lifecycle actions: Mark complete / Mark no-show / Cancel (only for `confirmed + starts_at > now()`).
- Session block surface (when complete): record area + duration + equipment + notes.
- Postcare send button.
- Cancelled section (PR #144): reason label, client note, follow-up-okay badge, "Cancelled N minutes after booking" hint if applicable.
- Manual cancellation/no-show fee card (PR #145 + #146): renders only for `cancelled` / `no_show` status. Test-mode banner. Per-status panels (ready / pending_stripe / succeeded / failed / cancelled).

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

- `practitioners.calendar_feed_token` is the bearer credential. **Token storage is raw today**; hashing is on the deferred-hardening list ([docs/03](./03_SECURITY_AND_PRIVACY.md) §8).
- 30-day past + all future window.
- `SUMMARY` is always "Hone appointment" (no service name; lock-screen safe).
- `DESCRIPTION` includes client name, modality (`Electrolysis / Laser / Consultation`; generic, not the specific service name), a `View in Hone` link to `/calendar/<id>` (which is auth-gated).
- Cancelled appointments excluded.
- No intake responses, allergies, EpiPen flags, prices, session notes ever appear.
- Cache headers: short max-age + must-revalidate so token rotations propagate fast. No CDN caching.
- Token route privacy headers (`X-Robots-Tag`, `Referrer-Policy`) apply per `next.config.ts`.
