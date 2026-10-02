---
type: product workflow
title: Practitioner calendar, move/reassign and capacity
description: The practitioner-side scheduling surfaces — quick-book, move and reassign with the owner-only custom-time override, schedule editing through locked commands — and the practitioner-capacity model (LEGACY / CAPACITY_READY_BOOKING_PAUSED / LIVE), including where working hours are enforced by the database and where only by the application, with dated enablement status.
tags: [calendar, move-appointment, reassignment, practitioner-capacity, availability-settings, scheduling]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-2839b99018288867e9b2b1b6
    resource: repo://app/(app)/calendar/actions.ts
  - id: openwiki-source-2a45eed605f09ae83b7baf67
    resource: repo://app/(app)/calendar/move-appointment-actions.ts
  - id: openwiki-source-1e545865285afd5d8ce22413
    resource: repo://docs/07_CALENDAR_AND_AVAILABILITY.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-c13816ac4ce4ea8d0627e370
    resource: repo://supabase/migrations/0134_practitioner_capacity_foundation.sql
  - id: openwiki-source-87f9ee8798ff987eda6ce2de
    resource: repo://supabase/migrations/0136_practitioner_capacity_booking_flag.sql
  - id: openwiki-source-bac7b7202f3ee5659b335f23
    resource: repo://supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql
  - id: openwiki-source-e9162711763ff32ea530713a
    resource: repo://supabase/migrations/0170_public_appointment_command.sql
  - id: openwiki-source-a5b14bd2ac4cc9c166ea04b5
    resource: repo://supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql
  - id: openwiki-source-282ef9a6314da1dc97cc53f2
    resource: repo://supabase/migrations/0175_appointment_transition_integrity.sql
  - id: openwiki-source-11648a9666718de27ec6edcf
    resource: repo://tests/db/internal-booking-command.db.test.ts
  - id: openwiki-source-66a80acf1cb92fa9a6f351f9
    resource: repo://tests/source-guards/move-appointment-guards.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Practitioner calendar, move/reassign and capacity

## 1. Practitioner capacity: three states

`0134` made per-practitioner parallel booking possible but **default off**; while
`practitioner_capacity_enabled = false` the collision behaviour is byte-for-byte the old studio-wide
single-chair model ([`0134` L1-L40](../../supabase/migrations/0134_practitioner_capacity_foundation.sql#L1-L40)).
`0136` split structure from booking acceptance with a second flag,
`practitioner_capacity_booking_enabled`, giving three valid states (capacity off + booking on is rejected
by a CHECK) ([`0136` L1-L30](../../supabase/migrations/0136_practitioner_capacity_booking_flag.sql#L1-L30)):

| State | capacity | booking | Collision resource | New bookings |
|---|---|---|---|---|
| LEGACY | false | false | the studio (single chair) | allowed |
| CAPACITY_READY_BOOKING_PAUSED | true | false | each practitioner | **refused** (`booking_paused`) |
| LIVE | true | true | each practitioner | allowed, practitioner-aware |

The pause is enforced inside the internal booking command right after the lock
([`0174` L706-L726](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L706-L726);
proved in [`internal-booking-command.db.test.ts` L155-L172](../../tests/db/internal-booking-command.db.test.ts#L155-L172)),
and the move command returns `booking_paused` too. Switching capacity off on a studio with parallel
appointments would re-key them to one resource and fail with `23P01`, which is why retirement is an
operator-only, locked, preflighted command rather than a flag flip.

**The public surface is always capacity-off**: the public slot loader passes no practitioner, and
`create_public_appointment` uses its own validator built on the studio-wide model
([`0170` L44-L60](../../supabase/migrations/0170_public_appointment_command.sql#L44-L60)).

### Where working hours are enforced

`validate_appointment_availability` runs its practitioner, eligibility, closed-day and working-hours
checks **only when capacity is on**; with capacity off it reduces to the soft-buffer check
([`0152` L290-L366](../../supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql#L290-L366)). Blocks and
blockouts still collide through the shadow-table exclusion in every state. So at a capacity-off studio,
working hours for **internal** bookings and moves are enforced by the server actions (slot re-verification,
owner-only custom time — §2, §3), not by the database; public bookings are covered by their exact-slot
membership check.

## 2. Quick-book from the calendar

`bookAppointmentForClientAction` builds the slot list with `INTERNAL_SLOT_PACKING` (per practitioner when
capacity is on), and calls `create_internal_appointment_v2` through the service-role client with
server-resolved studio and actor; the outside-availability override is **owner-only** and re-checked
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
server-side ([`app/(app)/calendar/actions.ts` L88-L330](../../app/(app)/calendar/actions.ts#L88-L330)).
Drag-to-book and the client-page booking form use the same command.

## 3. Move and reassign

`app/(app)/calendar/move-appointment-actions.ts` holds the one move workflow for every device
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([L13-L22](../../app/(app)/calendar/move-appointment-actions.ts#L13-L22)):

- **`loadMoveSlotsAction`** — only a `confirmed` appointment that has **not started** can be moved;
  `canUseCustomTime` is derived solely from the live server role (`owner`); reassignment is offered only to
  an owner of a capacity-on studio, listing active, service-eligible practitioners (display names only,
  failing closed on lookup errors); slots exclude the appointment's own reservation
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  ([L49-L104](../../app/(app)/calendar/move-appointment-actions.ts#L49-L104),
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  [L106-L218](../../app/(app)/calendar/move-appointment-actions.ts#L106-L218)).
- **`moveAppointmentAction`** — `custom_time` mode is owner-only and acknowledgement-gated
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  ([L276-L290](../../app/(app)/calendar/move-appointment-actions.ts#L276-L290)); `available_slot` mode
  **regenerates** the slot list server-side and refuses a time that is not offered
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  ([L329-L350](../../app/(app)/calendar/move-appointment-actions.ts#L329-L350)); the move then goes through
  `move_or_reassign_appointment` with expected start/end for optimistic concurrency, a `NULL` target for a
  time-only move, and `p_allow_outside_availability` only for custom time
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  ([L360-L380](../../app/(app)/calendar/move-appointment-actions.ts#L360-L380)). Results map to typed
  outcomes (`moved`, `reassigned`, `stale_appointment`, `appointment_not_movable`, `outside_availability`,
  `buffer_conflict`, `booking_paused`, `practitioner_reassignment_required`, …) and a `23P01` maps to safe
  "slot taken" copy.
- The client is notified only after commit, and the app origin is resolved before the mutation.

A source guard pins the shape: one RPC, never cancel-and-rebook, server-resolved tenant, closed outcome
mapping, origin-before-mutation and notify-after-commit
([`move-appointment-guards.test.ts` L36-L100](../../tests/source-guards/move-appointment-guards.test.ts#L36-L100)).
Race behaviour is on [Scheduling concurrency and lock order](concurrency-and-lock-order.md).

## 4. Editing the schedule

`app/(app)/settings/availability/actions.ts` exposes weekly defaults, per-practitioner weeks and days,
date overrides, full-day blockouts, timed blocks and recurring-break rules. Weekly saves are atomic
(`save_weekly_availability`, `0149`) and single-row edits use the owner-only locked commands of `0150`, so
every schedule change serializes with booking and moves (see
[Concurrency](concurrency-and-lock-order.md#2-who-follows-the-order)). Blocks, blockouts and recurring
breaks reach `studio_calendar_reservations` through triggers that take the same advisory lock (`0138`);
recurring-break occurrences are materialized daily (see
[Cron jobs](../communications/cron-reminders-and-idempotency.md)).

## 5. Production status (dated)

<!-- openwiki: broken internal link [../../docs/production/current-state.md#L908-L925] heading anchor "L908-L925" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
From [`current-state.md` L908-L925](../../docs/production/current-state.md#L908-L925), re-verified across all
tenants on 2026-08-23: `practitioner_capacity_enabled` is **true only on the controlled test studio** and
false on the real-customer studio; `practitioner_capacity_booking_enabled` is **false on every studio**;
the per-practitioner availability, scoped blocks/breaks and atomic booking/move/reassign commands
(`0135`–`0150`) are deployed and follow the flags. Broad multi-practitioner rollout requires the deep audit
and explicit authorization.

## 6. Contradictions and open questions

1. **The booking flag is described as a public-booking kill switch, but it pauses all booking for a
   capacity-on studio.** `current-state.md` calls `practitioner_capacity_booking_enabled` "the
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L919-L920] heading anchor "L919-L920" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
   public-booking kill switch" ([L919-L920](../../docs/production/current-state.md#L919-L920)); in code,
   capacity on + booking off makes `create_internal_appointment_v2` return `booking_paused`
   ([`0174` L722-L725](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L722-L725)),
   while the public surface ignores capacity altogether. With the recorded flag values, the controlled
   test studio is in CAPACITY_READY_BOOKING_PAUSED, where new internal bookings are refused.
2. **`docs/07_CALENDAR_AND_AVAILABILITY.md` still names the 0133 RPC** `practitioner_move_appointment` as
<!-- openwiki: broken internal link [../../docs/07_CALENDAR_AND_AVAILABILITY.md#L52-L95] heading anchor "L52-L95" does not exist in "../../docs/07_CALENDAR_AND_AVAILABILITY.md". Fix the href or restore the target, then delete this comment. -->
   the atomic move backend ([L52-L95](../../docs/07_CALENDAR_AND_AVAILABILITY.md#L52-L95)), and the move
   action's own header says "via the 0133 RPC"
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
   ([L19](../../app/(app)/calendar/move-appointment-actions.ts#L19-L19)); the action calls
   `move_or_reassign_appointment`, and `0175` dropped the 0133 function.
3. **Database-side working-hours enforcement depends on the capacity flag** (§1): for every
   capacity-off studio the database does not reject an internal booking or move outside working hours;
   only the server actions do.
