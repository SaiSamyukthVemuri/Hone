# Part 4 — multi-practitioner internal scheduling: release-candidate review

PR #460 (`claude/practitioner-capacity-part4-booking`). **DRAFT — not merge-ready.**
Migrations 0142–0150 are **repo-only** (hosted max stays 0133); both capacity flags
default **OFF**; Willow untouched; Part 5 (public practitioner selection) deferred.

## 1. Scope delivered

| Item | Delivered |
|---|---|
| 1 | In-DB integrity: authoritative duration, close the 0142 command bypass |
| 2 | Every schedule writer takes the studios-row + advisory lock (0149 full-week + 0150 single-row) |
| 3 | One shared, target-aware availability validator (0146) |
| 4 | Validator wired into move/reassign (0148) + owner outside-availability |
| 5 | Availability parity (writer accepts what the reader offers) |
| 6 | Practitioner-aware internal booking UI (client-profile + calendar Quick Book desktop/mobile) |
| 7 | Owner practitioner reassignment on the shared Move workflow |
| 8 | Adversarial review + defect fixes + this release-candidate boundary |

Not in scope (deferred): public "any available"/practitioner selection, calendar
per-practitioner filters/lanes, hosted apply, flag activation.

## 2. Exact migrations (repo-only)

`0142` internal booking command · `0143` move_or_reassign · `0144` move final-target
integrity + 0133 wrapper · `0145` move preserve-target race fix · `0146` authoritative
duration + availability validator · `0147` legacy booking wrapper · `0148` move/reassign
validator + owner outside-availability · `0149` atomic full-week save · `0150` single-row
schedule writers locked. Intentional **0140/0141 gap** = onboarding PR #459.

## 3. Authoritative DB commands (SECURITY DEFINER, service_role only)

- `create_internal_appointment_v2` (0146) — booking; `create_internal_appointment` (0147) safe legacy wrapper.
- `move_or_reassign_appointment` (0143→0148, 8-arg) — time move / reassign / both.
- `practitioner_move_appointment` (0145 wrapper) — legacy time-only, delegates with NULL target.
- `validate_appointment_availability` (0146) — shared target-aware window authority.
- `save_weekly_availability` (0149); `upsert/delete_availability_day_locked`,
  `upsert/delete_availability_override_locked`, `set_service_practitioner_eligibility_locked`,
  `set_practitioner_active_locked` (0150); shared `lock_studio_and_assert_owner` + `validate_schedule_scope`.

The per-resource GiST exclusion on `studio_calendar_reservations` is the FINAL
collision authority (23P01 → rollback, uncaught by the commands).

## 4. Actor / target authorization

| Operation | Who may | Target rule |
|---|---|---|
| Book self | any active practitioner | target = self |
| Book another | OWNER + capacity ON | target validated active + same-studio + service-eligible (DB re-checks) |
| Custom-duration / outside-hours | OWNER only | re-checked on server-resolved role; members cannot forge |
| Time-only move | owner (any appt) / member (own only) | NULL target = preserve current |
| Reassign / move+reassign | OWNER + capacity ON | validated eligible target ≠ current; member/forged → NULL (time-only) |
| Schedule config writes | active OWNER only | server-derived studio+actor; scoped rows need cap ON + active target |
| Deactivate practitioner | OWNER only | not the owner/self |

Actor + studio are always resolved server-side (`getCurrentPractitionerWithStudio`);
no browser-supplied role/studio/practitioner id is trusted; every target is
re-validated inside the DB command.

## 5. Flag states (both default OFF)

| `capacity_enabled` | `booking_enabled` | Behaviour |
|---|---|---|
| OFF | OFF | **Legacy** — studio-wide, no selectors, validator no-op, byte-for-byte today |
| ON | OFF | Capacity-ready / **paused** — config visible; new bookings + move/reassign that occupy a new interval/target → `booking_paused` |
| ON | ON | **Live** — practitioner-aware booking + reassignment |

`studios_capacity_booking_valid` CHECK rejects cap=OFF+book=ON. Turning capacity OFF
after configuring leaves practitioner-specific rows **dormant** (retained, not
deleted); turning it back ON restores them without duplication (0138 dormancy).

## 6. Reservation model

`studio_calendar_reservations.resource_key`: studio_id when capacity OFF (byte-for-byte
today), practitioner_id when ON (parallelism). Studio-wide sources (timed blocks,
recurring breaks, blockouts) fan out to every practitioner; appointments key to their
practitioner. Reassignment re-keys the appointment's shadow row and removes the stale
orphan (0134 trigger). Appointment `ends_at` in the shadow = `blocked_ends_at`
(buffer-inclusive); the GiST compares `[starts_at, ends_at)` per resource.

## 7. Lock order + concurrency

Canonical order: **studios row FOR UPDATE → capacity advisory lock → source rows**
(services / appointments) FOR UPDATE. See `part4-lock-order-and-race-matrix.md`.
Proven (real-Postgres, two-connection, barrier-coordinated — no sleep-only tests):

| Race | Outcome | Test |
|---|---|---|
| two bookings same practitioner/slot | one commits, one 23P01 | internal-booking-command.db |
| A + B same time | both commit (distinct resource) | availability-parity / internal-booking-command.db |
| two moves, same snapshot | one wins, other stale/collision | move-reassign-appointment.db |
| booking vs day-close | config-first → reject; booking-first → appt intact | single-row-schedule-writers.db |
| eligibility-removal / deactivation first → booking | reject (`not_eligible` / `invalid_practitioner`) | single-row-schedule-writers.db |
| booking vs full-week save | serialized on studios-row lock | save-weekly-availability.db |
| booking vs reassignment same slot | one winner, no deadlock | schedule-lock-order.db |
| wrapper time-move vs concurrent reassign | wrapper preserves winner, never reverts | move-preserve-target-race.db |

Rolled-back commands leave no partial appointment update, orphan reservation, or
success audit (reassignment-integrity.db, move-reassign-appointment.db).

## 8. Privilege matrix (migrations 0142–0150)

All 14 SECURITY DEFINER functions: pinned `search_path = pg_catalog, pg_temp`;
`revoke execute` from public + anon + authenticated; `grant execute` to service_role
only (0142–0149 via literal lines adjacent to each definition; 0150 via a `do`-block
loop over its 8 functions). Direct anon/authenticated calls → **42501**; a foreign
studio id in a denied call exposes no cross-tenant data (proven in
internal-booking-command.db, move-reassign-appointment.db, move-target-integrity.db,
+ migration structure tests 0142/0146/0147/0148/0149/0150). The service-role call-site
allowlist (`tests/security/service-role-allowlist`) gates every admin-client adapter;
Part 4 added exactly one entry (`settings/team/actions.ts`). The Item 6/7 selector
reads use the RLS `createClient` (member-select policy on `service_practitioners` +
studio-scoped practitioners) — no new admin call-site.

## 9. Browser Studio B matrix

`e2e/practitioner-booking-studio-b.spec.ts` (Item 6), `e2e/practitioner-reassignment-studio-b.spec.ts`
(Item 7), `e2e/practitioner-schedule-studio-b.spec.ts` (Part 3E scoped config) —
all green on the exact head. Owner O, active A + B, inactive C, member logins:
- owner books A then B (distinct assignments; C absent); target switch clears slots;
- owner reassigns A→B (DB shows B + `moved_and_reassigned` audit); reassignment target
  switch clears the picked time;
- member sees no selector and books/moves only self;
- Legacy capacity-OFF studio shows no selector, unchanged flow;
- scoped studio-wide vs A-only vs B-only blocks/breaks affect the right resource only.

## 10. Legacy rollback

Capacity OFF = studio-wide, no selectors, existing booking + time-only move unchanged
(browser + DB proven). Scoped practitioner data is dormant (not deleted) and restores
on re-enable without duplication.

## 11. Notification behaviour

`notify-appointment-moved` builds TRUTHFUL copy per committed result kind — `moved`
(time changed), `reassigned` (new practitioner, **time unchanged**, never claims a
time change), `moved_and_reassigned`. Includes the new practitioner display name,
never a practitioner id. Fail-open (provider failure → `degraded`, appointment stays
moved); never reuses the one-time confirmation email/SMS claim slots; email only.

## 12. Privacy / logging review

No raw Supabase/Postgres/provider message reaches the client (Item 8 fixed the 3
confirmed leaks in the booking action). Structured logs carry only
`event:stage:sqlstate`/category codes — no client name/email, appointment id,
practitioner id, notes, token, or provider body. Post-commit side effects are
fail-open (booking dispatch wrapped; move notification best-effort). Selector option
lists carry display names only.

## 13. Known limitations

- Item 8's e2e browser specs use today's studio-local-morning window
  (`timezoneWithLocalMorning`); the DB integrity/concurrency suites use fixed future
  dates (e.g. 2031-09-15). The browser specs are deterministic per-run but not
  wall-clock-independent across the day boundary.
- SMS is not sent for a move/reassignment (email only, by design).
- PR #460 CI proves 0135–0139 + 0142–0150 applied together on a fresh DB, but **not**
  the exact combined #458 + #459 + #460 hosted state — an integrated release-candidate
  branch is still required (see §16).

## 14. Deferred Part 5 boundary

Public booking practitioner selection ("any available" / specific eligible
practitioner), calendar per-practitioner filters + simultaneous lanes, hosted
migration apply, and flag activation are **out of scope** and NOT implemented here.

## 15. Migration + merge order (deployment unit)

1. **#458** (`0135–0139`) — per-practitioner availability + scoped sources engine.
2. **#459** (`0140–0141`) — studio onboarding (separate session; frozen).
3. **#460** (`0142–0150`) — this PR.

Applies cleanly from a fresh DB and after 0135–0139 (CI db lane applies 0001→0150 each
run). No duplicate/ambiguous overload (the 0143 7-arg `move_or_reassign_appointment`
is dropped and recreated 8-arg in 0148). No migration created for docs/tests.

## 16. Integrated release-candidate + staging

An integrated RC branch must be assembled from **#458 head `af32009`**, **#459 head
`2a1f67d09cb7ac6a9459e9484b9f085efef38512`**, and the final **#460 Item 8 head**, then
run through the full CI to prove the exact combined `0135→0150` application state
(PR #460's own CI does not, because it omits 0140/0141). Hosted apply is migration-first
and separate; both flags stay OFF; a controlled new-studio (synthetic, never Willow)
staging acceptance test — configure availability, book A/B, move, reassign, verify
Legacy untouched — is the gate before any flag activation. Rollback = flip
`booking_enabled` OFF (instant pause, no rematerialize); structural rollback via the
0138 `retire_practitioner_capacity` command after draining.

## 17. Evidence

- Item 2 exact-head CI: run `29855662488` (attempt 5) on `f47c640`.
- Item 6 exact-head CI: run `29866860757` on `cc3dcb0`.
- Item 7 exact-head CI: run `29871331592` on `83335c3`.
- Item 8 adversarial review: 6 hotspot reviewers + per-finding refuters — 3 confirmed
  low-severity defects (fixed), 1 refuted.
- Final Item 8 CI: recorded in the PR body on the final head.
