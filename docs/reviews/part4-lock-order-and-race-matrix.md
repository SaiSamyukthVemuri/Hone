# Part 4 — canonical schedule lock order + race matrix (Item 4)

Every command that mutates a studio's schedule acquires locks in **one** order and
holds them to commit. This single order is why bookings, moves, reassignments,
practitioner retirement and the timezone rebuild can run concurrently without
deadlock and can never commit under a stale winning schedule.

## The order

1. **`studios` row** — `select … from public.studios where id = p_studio_id for update`.
   This also reads `practitioner_capacity_enabled` / `practitioner_capacity_booking_enabled`
   from the row it locks, so no mutation acts on flags that a concurrent
   retirement/rebuild is changing.
2. **Studio capacity advisory lock** — `perform public.acquire_studio_capacity_lock(p_studio_id)`
   (`pg_advisory_xact_lock`). Serializes the whole studio's capacity-sensitive
   mutations against each other.
3. **Target source rows, deterministically** — locked only *after* (1) and (2):
   - booking (`create_internal_appointment_v2`): the `services` row `for update`
     (the authoritative duration is read from the locked row);
   - move / reassign (`move_or_reassign_appointment`): the `appointments` row
     `for update` (the effective target is resolved from the locked row).

The per-resource **GiST exclusion** on `studio_calendar_reservations`
(`no_overlapping_calendar_reservations_per_resource`, migration 0134) is the
FINAL race-safe authority for interval collisions. A `23P01` is never caught by
the commands — it rolls the whole transaction back and reaches the server adapter
for safe "slot taken" mapping. No appointment, shadow row, or audit row survives.

## Mutations that follow the order

| command | migration | (1) studios row | (2) advisory | (3) source rows | availability validator |
|---|---|---|---|---|---|
| `create_internal_appointment` (legacy wrapper) | 0142→**0147** | ✓ | ✓ | `services` FOR UPDATE | ✓ via v2 |
| `create_internal_appointment_v2` | 0146 | ✓ | ✓ | `services` FOR UPDATE | ✓ |
| `move_or_reassign_appointment` | 0143/0144/0145/**0148** | ✓ | ✓ | `appointments` FOR UPDATE | ✓ (Item 4) |
| `practitioner_move_appointment` (wrapper) | 0133/0145 | delegates → move_or_reassign (same order; **no** pre-lock read after 0145) | | | ✓ via move |
| practitioner retirement | 0138 | ✓ | ✓ | — | n/a |
| timezone rebuild | 0138 | ✓ | ✓ | — | n/a |
| `validate_appointment_availability` | 0146 | pure read — runs INSIDE the caller's txn under the caller's locks; takes none itself | | | (self) |

**Availability + schedule writers (Item 2 — complete).** Every application schedule
writer now takes the lock order:

| command | migration | (1) studios row | (2) advisory | atomic | replaces action |
|---|---|---|---|---|---|
| `save_weekly_availability` | 0149 | ✓ | ✓ | all 7 days / txn | saveWeeklyDefaults, customizePractitionerWeek |
| `upsert_availability_day_locked` | **0150** | ✓ | ✓ | 1 upsert | upsertDayDefault, upsertScopedDayDefault |
| `delete_availability_day_locked` | **0150** | ✓ | ✓ | 1 delete (day or whole week) | resetPractitionerDay, resetPractitionerWeek |
| `upsert_availability_override_locked` | **0150** | ✓ | ✓ | 1 upsert | upsertOverride, upsertScopedOverride |
| `delete_availability_override_locked` | **0150** | ✓ | ✓ | 1 delete | deleteOverride, resetPractitionerOverride |
| `set_service_practitioner_eligibility_locked` | **0150** | ✓ | ✓ | 1 write | (READY — no UI writer yet) |
| `set_practitioner_active_locked` | **0150** | ✓ | ✓ | 1 update | removePractitionerAction (deactivation) |

All share `lock_studio_and_assert_owner` (studios row FOR UPDATE → advisory →
active-owner check) and `validate_schedule_scope` (scoped rows require capacity ON +
active same-studio target). Service_role only; the owner + studio come from the
trusted server adapter. **Not app writers (reuse existing, already locked):**
`studios.timezone` (no app writer — operator/migration-only rebuild); the capacity
flags (operator-only `retire_practitioner_capacity`, 0138); blockouts / timed blocks
/ recurring breaks (already lock via the 0138 trigger).

## Serialization policy (the lock gives SERIAL ORDER, not one-must-fail)

A schedule mutation and a booking/move serialize on the shared studios-row +
advisory lock. The ordered outcomes:

**A. Configuration mutation acquires the lock first.** The booking/move WAITS,
then validates against the NEW configuration and rejects if the resulting interval
is no longer valid:
- weekly/day close or date-override close first → later booking/move →
  `practitioner_closed` / `outside_availability`; no appointment/shadow/audit row.
- eligibility removal / deactivation first → later booking/move → `not_eligible` /
  `invalid_practitioner` (or `practitioner_reassignment_required` for a time-only move).
- booking-pause first → later booking/move → `booking_paused`.

**B. Booking/move acquires the lock first.** It commits under the configuration it
locked and validated. The later configuration mutation commits afterward per the
existing product policy; the already-committed appointment is **never** silently
cancelled, reassigned or retimed. An out-of-hours or now-ineligible EXISTING
appointment simply cannot be time-only-moved later without reassignment.

**Invariant:** no booking or move may validate against state S1 and commit after a
schedule mutation to S2 that acquired the shared lock first. This holds because a
booking that starts after the config commit reads the post-commit configuration
inside the same lock it must acquire.

**Timezone** uses the reviewed 0138 rebuild (absolute instants + shadow preserved);
no plain-column bypass exists. **Legacy (capacity OFF)** stays studio-wide with no
per-practitioner requirement.

`validate_appointment_availability` deliberately takes no locks: it is only ever
called after its caller already holds (1)+(2)+(3), so it reads a schedule that no
concurrent mutation can change before this transaction commits — the
"no-commit-under-a-stale-winning-schedule" guarantee.

## Race matrix → proving test

| # | scenario | outcome | proven by |
|---|---|---|---|
| 1 | two bookings, same practitioner + slot | one commits, one `23P01` | `internal-booking-command.db` — "two bookings for A at the same time" |
| 2 | concurrent bookings, same studio | serialize on the advisory lock | `internal-booking-command.db` — "advisory lock serializes concurrent bookings" |
| 3 | booking vs. practitioner retirement | booking blocks under the SAME lock, no deadlock | `internal-booking-command.db` — "booking blocks under the SAME lock while retirement holds it" |
| 4 | scoped A-block vs. A-booking / B-booking | collides for A, not for B | `internal-booking-command.db` — "a scoped A block collides with an A booking, but NOT a B booking" |
| 5 | two concurrent moves, same expected state | one succeeds, one stale | `practitioner-move-appointment.db` — "31: two concurrent moves…" |
| 6 | time-only move vs. concurrent reassign A→B | wrapper keeps B (never reverts), one winner, no deadlock | `move-preserve-target-race.db` — "CONCURRENT reassign A→B then wrapper time-move" |
| 7 | reassign A→B vs. reassign B→A | deterministic winner; wrapper never changes practitioner | `move-preserve-target-race.db` + `move-target-integrity.db` |
| 8 | move onto a timed block / full-day blockout | `23P01` | `practitioner-move-appointment.db` — "17: timed-block conflict", "19: full-day blockout conflict" |
| 9 | buffer snapshot after a move | `blocked_ends_at = ends_at + buffer` holds | `practitioner-move-appointment.db` — "37: buffer snapshot invariant" |
| 10 | booking vs. reassignment into the same target slot | one winner (`23P01` on overlap); both commit when disjoint; no deadlock | `schedule-lock-order.db` — this PR |
| 11 | availability read under a stale schedule | impossible — validator runs under the caller's locks | `duration-and-availability-validator.db` + design above |
