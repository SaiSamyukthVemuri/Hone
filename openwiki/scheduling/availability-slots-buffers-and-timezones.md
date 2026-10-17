---
type: scheduling mechanism
title: Availability, slots, buffers and timezones
description: How Hone decides which times are bookable — UTC storage with studio-local rules, availability precedence (overrides, practitioner windows, blocks, breaks, blockouts), the TypeScript slot generator and its anchors, the database's hard actual-overlap exclusion and soft buffer trigger, exact public slot membership, the booking horizon, and the parity tests that keep the two engines aligned.
tags: [scheduling, availability, slots, buffers, timezones, parity]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-c367790cf680d78d3d3518d0
    resource: repo://lib/booking/horizon.ts
  - id: openwiki-source-6126097f2637cb2a9ce1bfd7
    resource: repo://lib/booking/slots.ts
  - id: openwiki-source-4196b0cf0bb1afe9f576384d
    resource: repo://lib/booking/tz.ts
  - id: openwiki-source-0474fbf88699e2a33b6931c9
    resource: repo://supabase/migrations/0029_double_booking_constraint.sql
  - id: openwiki-source-bac7b7202f3ee5659b335f23
    resource: repo://supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql
  - id: openwiki-source-e9162711763ff32ea530713a
    resource: repo://supabase/migrations/0170_public_appointment_command.sql
  - id: openwiki-source-656bba36338b19b6cc91ee9d
    resource: repo://tests/db/availability-parity.db.test.ts
  - id: openwiki-source-79f4e8e269bca24a020c7032
    resource: repo://tests/db/duration-and-availability-validator.db.test.ts
  - id: openwiki-source-db6eb90088119cc60b2c5fcd
    resource: repo://tests/db/public-booking-slot-parity.db.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Availability, slots, buffers and timezones

Two engines decide bookable time, and they must agree:

1. **The reader**: `lib/booking/slots.ts` (`getAvailableSlots`) computes the slots a page offers.
2. **The writer**: database commands and triggers decide what a booking may actually store.

Every public booking requires the submitted start to be a member of the database's own re-derived candidate set, and
parity suites run both engines against the same seeded data.

## 1. Time model

- **All stored times are UTC instants** (`timestamptz`); the studio's IANA zone (`studios.timezone`) defines local days,
  opening hours and the horizon ([`lib/booking/tz.ts` L1-L2](../../lib/booking/tz.ts#L1-L2)). Slots carry ISO UTC
  `start`/`end` plus a display label ([`slots.ts` L13-L21](../../lib/booking/slots.ts#L13-L21)).
- `utcInstantFromLocal(date, time, tz)` converts a studio wall-clock time to an instant with a second offset sample so
  DST transitions resolve correctly: an ambiguous fall-back hour resolves to the **first** occurrence and a
  non-existent spring-forward time maps to one hour earlier ([L42-L69](../../lib/booking/tz.ts#L42-L69)). Offsets
  come from `Intl`, with no dependency ([L1-L40](../../lib/booking/tz.ts#L1-L40)).
- Local calendar arithmetic (`addDays`, `startOfWeek`) works on noon-UTC anchors so it never crosses a date boundary;
  `todayInTz` gives the studio's current local date ([L241-L258](../../lib/booking/tz.ts#L241-L258)).
- DST parity between the SQL and TypeScript slot engines is tested for `America/Toronto`
  ([`public-booking-slot-parity.db.test.ts` L215](../../tests/db/public-booking-slot-parity.db.test.ts#L215-L215)).

## 2. What makes a time unavailable

| Source | Where it lives | Effect |
|---|---|---|
| Weekly default hours | per studio (and per practitioner when capacity is on) | the day's open window |
| Dated override | same | **wins over the default**; an override marked closed closes the day ([`pickDayWindow` L223-L258](../../lib/booking/slots.ts#L223-L258)) |
| Practitioner-specific window | `0135` practitioner availability | wins over the studio-wide window when practitioner capacity is enabled |
| Confirmed or completed appointments | `studio_calendar_reservations` shadow rows, **actual** interval since `0152` | reserved, plus the buffer (section 4) |
| Timed blocks, recurring-break occurrences, full-day blockouts | same shadow table, raw interval | reserved, never widened by a buffer; a studio-wide block fans out to every practitioner, a scoped block reserves only its practitioner (`0137`) |

The shadow table is the **race-safe authority** for interval collisions: each row is keyed to a resource (the studio
when capacity is off, the practitioner when on) under a GiST exclusion, and the appointment trigger keeps it in step
with the appointment's actual interval
([`0152` L100-L156](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L100-L156)). Recurring breaks
are materialized ahead by the daily cron (see [Cron jobs and reminders](../communications/cron-reminders-and-idempotency.md)).

## 3. The slot generator (`lib/booking/slots.ts`)

Candidate starts are **anchored**, not a fixed 15-minute grid ([L116-L210](../../lib/booking/slots.ts#L116-L210)):

1. the opening time (left-pack of the first window);
2. immediately after each reservation's protected end (left-pack after a reservation);
3. `reservation.start − duration − buffer` (right-pack before a reservation);
4. a coarse fallback walk from opening;
5. **internal surfaces only**: `close − duration` (right-pack against closing time), enabled by `INTERNAL_SLOT_PACKING`
   for the calendar drawer, client-page booking and move/reassign.

Rules that matter:

- **Protected intervals are source-aware.** An appointment protects `ends_at` plus the current studio buffer; blocks,
  breaks and blockouts protect only their raw interval
  ([`protectedIntervals` L260-L305](../../lib/booking/slots.ts#L260-L305)).
- **The closing edge tests the service end, not the buffered end.** A trailing buffer may spill past closing time,
  matching the capacity-on working-hours check in `validate_appointment_availability`
  ([L150-L165](../../lib/booking/slots.ts#L150-L165), fit filter [L610](../../lib/booking/slots.ts#L610-L610),
  [`0152` L343-L351](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L343-L351)).
- **Public surfaces drop past slots** with `filterFutureSlots`; practitioner surfaces deliberately do not
  ([L23-L52](../../lib/booking/slots.ts#L23-L52)).
- A moved or rescheduled appointment excludes **its own** reservation from conflicts via a server-derived
  `ReservationExclusion` ([L87-L109](../../lib/booking/slots.ts#L87-L109)).

## 4. What the database enforces (`0146`, `0152`)

- **Hard: actual treatment overlap.** Two GiST exclusions on `appointments` over `tstzrange(starts_at, ends_at, '[)')`
  for `confirmed` rows, studio-wide when `capacity_enabled = false` and per practitioner when true. A violation is
  `23P01` and can never be bypassed
  ([`0152` L1-L24](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L1-L24),
  [L76-L98](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L76-L98)).
- **Soft: the buffer gap.** `appointment_buffer_conflict` is true when the buffer-expanded windows of the candidate and
  another confirmed or completed appointment on the same resource overlap **but** their actual intervals do not, so the
  buffer applies on both sides. A `BEFORE INSERT OR UPDATE` trigger runs it for **every** writer and raises `HB001`,
  unless the row is `booked_outside_availability`, which only the owner-gated internal commands can set
  ([L163-L247](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L163-L247)).
- **`validate_appointment_availability`** (introduced in `0146`; the current definition is in `0152` from
  [L252](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L252-L370)). What it checks depends on the
  studio's `practitioner_capacity_enabled`:
  - **Capacity on:** active membership, service eligibility, full-day blockouts and the working-hours window (date
    override first, then weekly default; a practitioner-specific row wins over a studio-wide one; a booking may not
    cross midnight), then the soft buffer check
    ([L305-L366](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L305-L366)).
  - **Capacity off:** **none of those**. Only the soft buffer check runs, so the database accepts an internal booking at
    any hour ([L280-L290](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L280-L290)); the database
    suite pins this as "Legacy (capacity OFF) is a no-op → ok even outside any window"
    ([test L118-L125](../../tests/db/duration-and-availability-validator.db.test.ts#L118-L125)). Public booking is
    unaffected, because `0170` added a separate public validator whose exact candidate set is computed from the working
    hours ([`0170` L44-L59](../../supabase/migrations/0170_public_appointment_command.sql#L44-L59)).
  - **Owner override:** the owner outside-availability override bypasses the working-hours window **and** the soft
    buffer check, never a full-day blockout
    ([`duration-and-availability-validator.db.test.ts` L78-L125](../../tests/db/duration-and-availability-validator.db.test.ts#L78-L125)).
- **Exact public membership.** `create_public_appointment` and `reschedule_appointment_v2` recompute the public candidate
  set in SQL (`public_booking_slot_candidates`, `public_reschedule_slot_candidates`) and refuse a start that is not a
  member (`not_a_public_slot`); internal commands use the broad validator, which is why the closing-edge anchor is
  internal-only (see [Appointment write authority](appointment-write-authority.md)).
- **Buffer snapshot.** `snapshot_appointment_buffer()` stamps `buffer_minutes_snapshot` and `blocked_ends_at` on every
  insert or time change and refuses app-side tampering
  ([`0029` L50-L110](../../supabase/migrations/0029_double_booking_constraint.sql#L50-L110)); since `0152` these columns
  are kept for slot generation and reporting but are no longer the exclusion basis.

## 5. Booking horizon

The horizon applies to **public** booking and reschedule only; internal booking is not limited. Each studio picks 1–12
months; a "month" is **31 days**, so N months always covers N calendar months; the maximum feeds the recurring-break
materialization horizon and the next-available scan cap
([`lib/booking/horizon.ts` L1-L45](../../lib/booking/horizon.ts#L1-L45)). `create_public_appointment` applies the same
rule in the studio's local calendar.

## 6. Tests that pin agreement

| Property | Test |
|---|---|
| SQL candidate set equals the TypeScript offered set (empty day, around appointments and blocks, blockouts, closed days, overrides, DST) | [`public-booking-slot-parity.db.test.ts` L1-L30](../../tests/db/public-booking-slot-parity.db.test.ts#L1-L30), [L116-L215](../../tests/db/public-booking-slot-parity.db.test.ts#L116-L215) |
| On a capacity-enabled studio, the internal writer accepts exactly what the reader offers and rejects what it hides | [`availability-parity.db.test.ts` L68-L120](../../tests/db/availability-parity.db.test.ts#L68-L120) |
| Scoped blocks and breaks: keying, scope transitions, rollback on conflict | [`scoped-blocks-breaks.db.test.ts` L57-L105](../../tests/db/scoped-blocks-breaks.db.test.ts#L57-L105) |
| Owner override versus buffer (browser) | `e2e/manual-override-buffer-booking.spec.ts`, `e2e/client-booking-outside-hours.spec.ts` |

## 7. Contradictions and open questions

1. **Production's buffer-snapshot trigger is not the repository's.** The repository's only definition of
   `snapshot_appointment_buffer()` is in `0029`, but `0173` and `0175` record that production carries out-of-band
   behaviour in that function that no migration contains (see
   [Appointment write authority § 8](appointment-write-authority.md#8-contradictions-and-open-questions)). The values of
   `buffer_minutes_snapshot` and `blocked_ends_at` in production therefore cannot be fully predicted from source.
2. **Two buffer values exist; enforcement uses the live one.** Each appointment snapshots the studio buffer at write
   time, but both the database soft-buffer check and the slot generator use the **current** `studios.buffer_minutes`
   for every existing appointment
   ([`0152` L163-L190](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L163-L190);
   [`slots.ts` L260-L305](../../lib/booking/slots.ts#L260-L305)). Changing a studio's buffer therefore retroactively
   widens or narrows the protected gap around already-booked appointments. `0152`'s comment describes the live value as
   "the value that built `blocked_ends_at`", which holds only until the studio's buffer changes.
3. **Shadow rows and exclusions use different status sets.** The shadow reservation is kept for `confirmed` **and**
   `completed` appointments, while the appointment exclusions apply to `confirmed` only
   ([`0152` L76-L156](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L76-L156)); early completion
   therefore keeps the remaining tail reserved through the shadow table, which is the behaviour `0175` intends.
