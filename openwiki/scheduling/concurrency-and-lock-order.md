---
type: concurrency contract
title: Scheduling concurrency and lock order
description: The single lock order every schedule-mutating command follows (studios row, then the per-studio capacity advisory lock, then source rows), the GiST exclusions that are the final collision authority, the serialization policy for configuration-versus-booking races, the nested order used by waitlist booking conversion, and which races are proven by DB tests versus only argued.
tags: [concurrency, locks, advisory-lock, exclusion-constraint, races, scheduling, waitlist]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-2a670c1b18c3d3c3da0bf632
    resource: repo://docs/reviews/part4-lock-order-and-race-matrix.md
  - id: openwiki-source-87f9ee8798ff987eda6ce2de
    resource: repo://supabase/migrations/0136_practitioner_capacity_booking_flag.sql
  - id: openwiki-source-1ae43cbf61885ff5ff5d32ea
    resource: repo://supabase/migrations/0138_scoped_sources_lock_and_dormancy.sql
  - id: openwiki-source-5f8178f6903797b6920bcf36
    resource: repo://supabase/migrations/0145_move_preserve_target_race_fix.sql
  - id: openwiki-source-ee6502faff602359a7f9a90d
    resource: repo://supabase/migrations/0150_single_row_schedule_writers_locked.sql
  - id: openwiki-source-e9162711763ff32ea530713a
    resource: repo://supabase/migrations/0170_public_appointment_command.sql
  - id: openwiki-source-8b8be5b28e40991c64830be0
    resource: repo://supabase/migrations/0173_appointment_repair_commands.sql
  - id: openwiki-source-282ef9a6314da1dc97cc53f2
    resource: repo://supabase/migrations/0175_appointment_transition_integrity.sql
  - id: openwiki-source-4dfecfd03b5b8d11602a352b
    resource: repo://supabase/migrations/0195_waitlist_atomic_booking_conversion.sql
  - id: openwiki-source-8de1a24e11446e3c52161e26
    resource: repo://tests/db/double-booking-constraint.db.test.ts
  - id: openwiki-source-7c8dd39f7c48bd2ffeb19e8b
    resource: repo://tests/db/helpers/waitlist-concurrency.ts
  - id: openwiki-source-11648a9666718de27ec6edcf
    resource: repo://tests/db/internal-booking-command.db.test.ts
  - id: openwiki-source-9f3deeb32a77d575cfb3e159
    resource: repo://tests/db/move-preserve-target-race.db.test.ts
  - id: openwiki-source-d4da4b8de2f4b04ef2b22744
    resource: repo://tests/db/public-booking-concurrency.db.test.ts
  - id: openwiki-source-1f1a42fda711e3baeb21c859
    resource: repo://tests/db/public-reschedule-concurrency.db.test.ts
  - id: openwiki-source-592b6f4d2a956029fd6a6e27
    resource: repo://tests/db/schedule-lock-order.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Scheduling concurrency and lock order

## 1. The canonical order

Every command that changes a studio's schedule acquires locks in **one** order and holds them to
commit:

1. **`studios` row `FOR UPDATE`** — which also re-reads the capacity flags from the locked row;
2. **the studio capacity advisory lock** — `acquire_studio_capacity_lock(studio_id)` =
   `pg_advisory_xact_lock(hashtextextended('studio_capacity:' || studio_id, 0))`, transaction-scoped,
   per studio, never a table lock
   ([`0136` L210-L245](../../supabase/migrations/0136_practitioner_capacity_booking_flag.sql#L210-L245));
3. **the target source rows** — the `services` row for a booking, the `appointments` row for a move,
   reassignment or repair.

The order is written into the commands themselves: `create_public_appointment` locks the studio row
then the advisory lock "matching `create_internal_appointment_v2`"
([`0170` L675-L688](../../supabase/migrations/0170_public_appointment_command.sql#L675-L688)), and the
repair commands' `lock_appointment_for_command` reuses the same three steps
([`0173` L52-L62](../../supabase/migrations/0173_appointment_repair_commands.sql#L52-L62)).
`validate_appointment_availability` takes **no** locks; it runs inside the caller's transaction after
(1)–(3), so it can never validate against a schedule a concurrent writer is about to change.

**Final authority.** The per-resource GiST exclusion on `studio_calendar_reservations` (`0134`) and the
actual-overlap exclusions on `appointments` (`0152`) decide interval collisions. A `23P01` is not caught
inside the commands; it rolls the transaction back (no appointment, shadow row or audit row survives) and
the server adapter maps it to "slot taken". See
[Availability, slots, buffers and timezones](availability-slots-buffers-and-timezones.md).

## 2. Who follows the order

- **Booking / move / repair**: `create_public_appointment`, `create_internal_appointment_v2`,
  `move_or_reassign_appointment`, `reschedule_appointment_v2`, the cancel/complete/no-show commands and
  the `0173` repair commands (see [Appointment write authority](appointment-write-authority.md)).
- **Schedule configuration writers** (`0149`, `0150`): weekly saves, single-day upserts/deletes,
  date-override upserts/deletes, service eligibility and practitioner deactivation are
  `SECURITY DEFINER`, owner-only commands that take studios row → advisory lock before writing; the
  browser-role writes they replaced are gone
  ([`0150` L1-L30](../../supabase/migrations/0150_single_row_schedule_writers_locked.sql#L1-L30)).
- **Blocks, blockouts and recurring breaks**: since `0138` a lock-only trigger on all four source tables
  takes the advisory lock for INSERT/UPDATE/**DELETE** (previously DELETE bypassed it), the lock order is
  studio row → advisory, and materialization locks then **re-reads** the rule under a row lock
  ([`0138` L1-L22](../../supabase/migrations/0138_scoped_sources_lock_and_dormancy.sql#L1-L22)).
- **Practitioner-capacity retirement and the timezone rebuild** (operator-only, `0138`).

## 3. Serialization policy

The shared lock gives **serial order**, not "one must fail"
<!-- openwiki: broken internal link [../../docs/reviews/part4-lock-order-and-race-matrix.md#L62-L94] heading anchor "L62-L94" does not exist in "../../docs/reviews/part4-lock-order-and-race-matrix.md". Fix the href or restore the target, then delete this comment. -->
([design: `part4-lock-order-and-race-matrix.md` L62-L94](../../docs/reviews/part4-lock-order-and-race-matrix.md#L62-L94)):

- **Configuration first** → the waiting booking/move re-validates against the new configuration and is
  refused (`practitioner_closed`, `outside_availability`, `not_eligible`, `invalid_practitioner`,
  `booking_paused`), leaving no rows.
- **Booking/move first** → it commits under the configuration it validated; the later configuration
  change never silently cancels, reassigns or retimes an existing appointment.
- Invariant: no booking or move validates against state S1 and commits after a schedule change to S2 that
  acquired the lock first.

## 4. The move/reassign stale-target fix (`0145`)

A time-only move used to read the current practitioner **before** taking the locks and pass it back as the
target, so a concurrent A→B reassignment could be silently undone. Since `0145`, a `NULL` target means
"keep the current practitioner", resolved from the **locked** row; an explicit target is a reassignment
([`0145` L1-L20](../../supabase/migrations/0145_move_preserve_target_race_fix.sql#L1-L20)).

## 5. Waitlist booking conversion — the nested order

`create_waitlist_public_appointment` (`0195`) documents an executable lock sequence that **starts
differently** and then nests the canonical order: `studios FOR NO KEY UPDATE` → the waitlist entry
`FOR UPDATE` → the bound `clients` row `FOR SHARE` → **upgrade** to `studios FOR UPDATE` inside
`create_public_appointment` → advisory lock → `services FOR UPDATE` → `appointments FOR UPDATE` (overlap
scan) → entry (already held) → invitation `FOR UPDATE` → `studios` FK key-share from the entry-event
trigger ([`0195` L78-L100](../../supabase/migrations/0195_waitlist_atomic_booking_conversion.sql#L78-L100)).
See [Waitlist recipient journey and booking conversion](../waitlist/recipient-journey-and-booking-conversion.md).

## 6. Races and their proof

| Race | Outcome | Proven by |
|---|---|---|
| Two internal bookings, same practitioner + slot | one commits, one `23P01` | [`internal-booking-command.db.test.ts` L105-L112](../../tests/db/internal-booking-command.db.test.ts#L105-L112) |
| Concurrent internal bookings, same studio | serialize on the advisory lock | [L174-L180](../../tests/db/internal-booking-command.db.test.ts#L174-L180) |
| Booking vs reassignment into the same slot | one winner on overlap, both commit when disjoint, no deadlock | [`schedule-lock-order.db.test.ts` L1-L5](../../tests/db/schedule-lock-order.db.test.ts#L1-L5), [L67-L110](../../tests/db/schedule-lock-order.db.test.ts#L67-L110) |
| Public booking vs cancellation of its source; vs a timed-block insert; vs a competing row lock | serial order, refusal with `not_a_public_slot` when the cancellation wins, no deadlock | [`public-booking-concurrency.db.test.ts` L131-L290](../../tests/db/public-booking-concurrency.db.test.ts#L131-L290) |
| Duplicate public reschedule with the same token; reschedule vs lifecycle transitions; target taken first | exactly one successor; later actions see the committed state; original survives a lost race | [`public-reschedule-concurrency.db.test.ts` L133-L300](../../tests/db/public-reschedule-concurrency.db.test.ts#L133-L300) |
| Time-only move vs concurrent reassignment | the move keeps the new practitioner, one winner, no deadlock | [`move-preserve-target-race.db.test.ts` L70-L130](../../tests/db/move-preserve-target-race.db.test.ts#L70-L130) |
| Overlapping confirmed appointments / buffer proximity | `23P01` for actual overlap; `HB001` inside the buffer; touching intervals allowed | [`double-booking-constraint.db.test.ts` L56-L130](../../tests/db/double-booking-constraint.db.test.ts#L56-L130) |
| Racing session starts / whole-session copies | exactly one session / one batch, no deadlock | [`multi-studio-session-start-concurrency.db.test.ts` L92-L190](../../tests/db/multi-studio-session-start-concurrency.db.test.ts#L92-L190), [`whole-session-copy-concurrency.db.test.ts` L108-L260](../../tests/db/whole-session-copy-concurrency.db.test.ts#L108-L260) |

Blocking is observed for real: the waitlist concurrency helpers poll `pg_stat_activity` until a backend is
genuinely waiting on a lock rather than inferring it from elapsed time
([`tests/db/helpers/waitlist-concurrency.ts` L1-L35](../../tests/db/helpers/waitlist-concurrency.ts#L1-L35)).

**Argued, not separately tested here:** the "availability read under a stale schedule is impossible"
property rests on the validator running under the caller's locks (design §11 of the review); the timezone
rebuild's interaction with bookings is covered by the shared-lock design rather than a dedicated race test
in the files listed above.

## 7. Contradictions and open questions

1. **The lock-order review lists functions that no longer exist.** Its tables still include the legacy
   `create_internal_appointment` wrapper and `practitioner_move_appointment`, name `0148` as the latest
   `move_or_reassign_appointment`, and its race #6 refers to a "wrapper time-move"
<!-- openwiki: broken internal link [../../docs/reviews/part4-lock-order-and-race-matrix.md#L29-L42] heading anchor "L29-L42" does not exist in "../../docs/reviews/part4-lock-order-and-race-matrix.md". Fix the href or restore the target, then delete this comment. -->
   ([L29-L42](../../docs/reviews/part4-lock-order-and-race-matrix.md#L29-L42),
<!-- openwiki: broken internal link [../../docs/reviews/part4-lock-order-and-race-matrix.md#L96-L110] heading anchor "L96-L110" does not exist in "../../docs/reviews/part4-lock-order-and-race-matrix.md". Fix the href or restore the target, then delete this comment. -->
   [L96-L110](../../docs/reviews/part4-lock-order-and-race-matrix.md#L96-L110)); `0175` dropped both legacy
   functions and `0174` holds the latest `move_or_reassign_appointment`. Treat the review as design intent.
2. **A test title outlived its assertion.** `double-booking-constraint.db.test.ts` calls its buffer case
   "the studio buffer extends the blocked range", but the body now expects the soft `HB001` rather than an
   exclusion failure ([L94-L120](../../tests/db/double-booking-constraint.db.test.ts#L94-L120)).
3. **Waitlist audit writes take a studio key-share lock.** The `0195` sequence lists a `studios` FK
   key-share taken by the entry-event audit trigger; any change that makes waitlist exits or conversions
   touch `studios` differently must re-check this order against ordinary booking.
