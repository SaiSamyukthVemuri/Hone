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

**Availability writers (Item 2 — partial).** The FULL-WEEK writers now take the
lock and are atomic:

| command | migration | (1) studios row | (2) advisory | atomic |
|---|---|---|---|---|
| `save_weekly_availability` (studio-wide + practitioner scope) | **0149** | ✓ | ✓ | all 7 days in one txn |

`saveWeeklyDefaultsAction` + `customizePractitionerWeekAction` route through it, so
a partial-week save is no longer possible and both serialize with booking /
retirement / the timezone rebuild.

The SINGLE-ROW writers (date-override upsert/delete, day upsert/reset,
service-eligibility add/remove, practitioner activation/deactivation, timezone,
booking-pause) are each already atomic (one statement) but do **not yet** take the
studios-row + advisory lock. That lock is a consistency improvement, not a
double-book safety fix (the per-resource GiST exclusion remains the collision
authority regardless), and is the remaining Item 2 work.

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
