# Three-Practitioner Studio Capacity — Architecture Note (Part 2)

**Scope:** make Hone technically capable of one independent, one-location studio with
three practitioners (separate availability, simultaneous work, correct assignment,
own-identity charting, client selection or "any available", no same-practitioner /
shared-resource double-booking). **Not multi-location.** Addresses HNE-CAL-001,
TEN-06, TEN-07 and the Studio-plan up-to-three-practitioners promise.

> ## ⚠️ CURRENT DEPLOYMENT STATUS — verified 2026-07-27
>
> **This is an architecture note. It describes a design, not a launched capability.**
> The migrations it specifies (`0134`–`0139`, plus the Part-4 command set `0142`–`0150`) are
> **applied and deployed**, but enablement is deliberately narrow:
>
> | Flag | Value |
> |---|---|
> | `practitioner_capacity_enabled` | **true on the controlled test studio ONLY** — **false at Willow Electrolysis** |
> | `practitioner_capacity_booking_enabled` (public assignment kill switch) | **FALSE on every studio** |
>
> **Public booking practitioner selection and assignment is not active anywhere.** Production
> holds 6 practitioners across 5 studios (2 at Willow), 101 appointments.
>
> **Do not read "the schema and code exist" as launch readiness.** Broad multi-practitioner
> rollout requires the deep production/security/code audit (not yet performed) and explicit
> authorization. Note also that flipping `practitioner_capacity_enabled` ON→OFF is **not** a
> truthful instant rollback once a studio has legitimate parallel appointments — that is
> precisely why 0136 split the booking switch out. See
> [capability-register.md §10](../production/capability-register.md) and
> [known-limitations.md L7](../production/known-limitations.md).

**Evidence basis (as researched, 2026-07 — historical):** direct reads of migrations
`0001–0133` + booking/slot/action code, plus a 6-cluster read-only audit (workflow
`wf_643e69e7`, 6 agents, 0 errors), plus read-only hosted checks (migration max `0133` **at
that time — it is now 0157**; 84 appointments / 42 confirmed with **zero** NULL
`practitioner_id`; all 3 synthetic studios have 1 active practitioner; Willow = studio-wide,
unaffected). No production write, migration, or flag change was made to produce this note.

> **Prime directive for every design choice below:** while
> `practitioner_capacity_enabled = false` (all production studios, incl. Willow), the
> observable behaviour of availability and double-booking must be **byte-for-byte the
> current studio-wide behaviour**. Parallelism is a strictly opt-in generalization.

---

## The eight questions

### Q1 — Why does current collision logic block parallel practitioners?

Because a studio is modelled as a **single bookable resource (capacity = 1)**, in three
flag-blind layers, none of which carry a practitioner dimension:

1. `appointments.no_overlapping_active_appointments_per_studio`
   (`0029_double_booking_constraint.sql:235-240`):
   `EXCLUDE USING gist (studio_id WITH =, tstzrange(starts_at, blocked_ends_at,'[)') WITH &&) WHERE (status='confirmed')`.
   `practitioner_id` exists on the row but is **not** in the key.
2. `studio_calendar_reservations.no_overlapping_calendar_reservations_per_studio`
   (`0030_calendar_reservations.sql:556-561`): same shape, cross-kind, no `WHERE` —
   any two overlapping reservations of any source kind in one studio collide.
3. `lib/booking/slots.ts:180-185`: the reservation query filters `studio_id` only, and
   every reservation is a hard conflict regardless of practitioner (196-210).

Postgres exclusion constraints are **AND-ed** and the studio-wide one is strictly
stronger than any per-practitioner one, so *you cannot keep the studio-wide constraint
active for a studio and also let two practitioners work at the same time.* Parallelism
requires that studio's collision key to become per-practitioner.

### Q2 — Can `studio_calendar_reservations` become the canonical resource-capacity model?

**Yes, and it is the right vehicle.** It is *already* the canonical unavailability
shadow: all four source kinds (`appointment`, `timed_block`, `full_day_blockout`,
`recurring_break_occurrence`) funnel into it via SECURITY-DEFINER triggers/RPCs
(`0030` appointments+timed_blocks+blockouts, `0031` recurring breaks, `0032` extended
appointments to mirror `confirmed`+`completed`). Today its only scoping column is
`studio_id`, so it models capacity = 1. Columns today: `id, studio_id, source_kind,
source_id, starts_at, ends_at`; arbiter `unique(source_kind, source_id)`; one GiST
exclusion. Extending it with a **resource dimension** (below) turns the same shadow into
a per-resource capacity model without touching any read path's shape.

### Q3 — Does per-practitioner availability exist? Must it be added?

**Does not exist.** Availability is purely studio-scoped: `studio_availability_default`,
`studio_availability_overrides`, `studio_blockouts`, `studio_recurring_break_rules/
_occurrences`, `studio_timed_blocks` — none carry a practitioner. `getAvailableSlots`
(`slots.ts:115`) takes one `StudioRow` (no practitioner arg), computes
`[studio open window: override wins over weekly default] − [full-day blockout ⇒ []] −
[UNION of every studio reservation]`. One timezone per studio (`studios.timezone`,
default `America/Toronto`).

**Must be added — in PR B, not PR A.** Give three practitioners separate availability by
adding a **nullable** `practitioner_id` to the availability/break/blockout/timed-block
tables (NULL = studio-wide fallback, the backward-compatible default), and a
practitioner-aware slot path. Product contract: studio default hours remain the fallback;
practitioner-specific rows override the fallback **only for that practitioner**; Willow is
never forced to configure anything.

### Q4 — Does service→practitioner eligibility exist?

**No — it is entirely absent.** No `service_practitioners` / `practitioner_services` /
eligibility table in `0001–0133`; `services` never gains `practitioner_id`; no app code
filters practitioners by service. Services and practitioners are each independently
studio-scoped. PR A adds an additive `service_practitioners` join table with a
DB-enforced same-studio invariant and a backfill = **every active practitioner eligible
for every service** (behaviourally identical to today, where booking ignores service when
picking a practitioner). Eligibility is owner-assigned, active-only, never invented
dynamically at booking, and never silently falls back to the owner.

### Q5 — Every path that silently assigns the owner / a single practitioner

| Path | File | Behaviour today |
|---|---|---|
| Public booking | `app/book/[slug]/actions.ts:760-774` | resolves the studio OWNER by role, inserts `practitioner_id: owner?.id ?? null` — silent owner, can even write NULL; no client choice; no browser practitioner id (`PublicBookForm.tsx` has no such field) |
| Internal booking | `app/(app)/calendar/actions.ts:221` | silently self-assigns the authenticated actor |
| Reschedule | `0029:311-343` | copies the original `practitioner_id`, mints a **new** appointment id |
| Move | `0133_practitioner_move_appointment.sql:117-122` | preserves the **same** appointment id, re-syncs the same shadow row atomically, **never** touches `practitioner_id`; authorizes any active practitioner to move any appointment |

No path can *reassign* an appointment's practitioner. PR C replaces the silent-owner
public path with explicit "Any available practitioner" or a specific **eligible**
practitioner, assigned **server-side** (never trusting a browser-supplied id).

### Q6 — Every place that assumes one studio = one schedule

`getAvailableSlots(StudioRow)` with no practitioner arg (`slots.ts:115-121`); the
reservation query filtered on `studio_id` only (`slots.ts:180-185`); the overlap loop
treating all practitioners as one timeline (196-210); both GiST exclusions (Q1); the
studio-wide slot/availability read. PR B makes the read path practitioner-aware **only
when the flag is on**; PR A makes the write/collision path per-resource.

### Q7 — Willow backward-compatibility

The flag *column* is Willow-neutral (proven additive pattern `studios.<name>_enabled
boolean not null default false`, read `studio.flag === true`, from `0119/0120/0121`).
The hazard is that Willow's studio-wide semantics live in **flag-blind** layers (the two
GiST exclusions + the studio-only slot read). The design therefore preserves OFF
behaviour by construction: for an OFF studio, the new resource key **is** `studio_id`, so
the single re-keyed exclusion and the slot read reproduce the current studio-wide result
exactly. No backfill `UPDATE` touches Willow's row; its availability and double-booking
stay studio-wide. **Willow's flag stays `false` and is never flipped by this work.**

### Q8 — Migration + rollback approach

**Expand → verify → contract, all additive; one metadata-only constraint swap; no data
loss.** Detailed below.

**Rollback (corrected in PR B 3B-0).** The *structural* flag
`practitioner_capacity_enabled` is NOT an instant kill-switch once a studio has live
parallel appointments: flipping it OFF rematerializes them into one studio-wide resource,
which the studio-wide exclusion rejects (`23P01`). Migration 0136 therefore separates the
concerns into two operator flags — `practitioner_capacity_enabled` (structural model) and
`practitioner_capacity_booking_enabled` (booking acceptance). The two booleans yield **three
valid technical states** — `LEGACY` (F/F), `CAPACITY_READY_BOOKING_PAUSED` (T/F), `LIVE` (T/T);
the invalid `capacity=false, booking=true` is rejected by a CHECK. "Configuring" vs "draining"
is an *operational* reading of the paused state (reported via indicators like future confirmed
appointments / retirement blockers), not a distinct persisted state. **The emergency rollback is flipping `booking` OFF (instant; existing parallel
appointments stay valid; no rematerialization).** *Structural* deactivation is a preflighted,
service-role-only retirement (`retire_practitioner_capacity`) that fails closed with reason
codes if parallel data would collide. Dropping the additive columns/table/constraints in
reverse remains possible — no row is deleted or rewritten by the forward migrations.

---

## The collision model — the one genuinely subtle decision

**Requirement matrix for a flag-ON studio (practitioners P1, P2, P3):**

1. Two appointments for the **same** practitioner, overlapping ⇒ **BLOCK**.
2. Two appointments for **different** practitioners, overlapping ⇒ **ALLOW** (parallelism).
3. A studio-wide block (break / blockout / timed_block) overlapping **any** practitioner's
   appointment ⇒ **BLOCK** (studio-wide unavailability blocks everyone).
4. A flag-**OFF** studio (Willow): any two overlapping reservations of any kind ⇒ **BLOCK**
   (today's behaviour, unchanged).

**Why a naïve `resource_id WITH =` fails:** requirements 1–2 want the appointment key to be
`practitioner_id`; requirement 3 wants a studio-wide block to collide with *every*
practitioner. A single reservation row has one key and a GiST `=` never matches NULL to
NULL, so one studio-wide block row can conflict with at most one practitioner. **Studio-wide
blocks must therefore fan out into one shadow row per active practitioner** on ON studios.

### Chosen model — `resource_key uuid NOT NULL` + studio-wide fan-out + one exclusion

Add to `studio_calendar_reservations`:

- `practitioner_id uuid NULL` — provenance/observability (references `practitioners(id)`,
  `ON DELETE CASCADE`); NULL for studio-wide rows on OFF studios.
- `resource_key uuid NOT NULL` — the GiST partition key, computed at write time by the
  triggers:
  - **OFF studio** → *every* row (appointments **and** studio-wide blocks) gets
    `resource_key = studio_id`. One studio bucket ⇒ exactly requirement 4 / today.
  - **ON studio, appointment** → `resource_key = practitioner_id` ⇒ requirements 1 & 2.
  - **ON studio, studio-wide block** → **fan out**: one row per active practitioner, each
    `resource_key = that practitioner_id` ⇒ requirement 3.

The arbiter widens from `unique(source_kind, source_id)` to
`unique(source_kind, source_id, resource_key)` (fan-out produces N rows per source).

**One exclusion replaces the studio-wide one** (metadata-only swap — the single non-additive
step, loses no rows):

```sql
EXCLUDE USING gist (resource_key WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
```

No `WHERE` needed — `resource_key` already encodes both scopes. All four requirements fall
out of this single constraint once the trigger sets `resource_key` and fans out correctly.

**The appointments-level exclusion (`0029`)** is re-keyed the same way, for defense in depth
**and** to carry the integrity invariant: add a denormalized `capacity_enabled boolean`
(maintained by trigger from the studio flag) + two partial exclusions
(`WHERE ... AND NOT capacity_enabled` → `studio_id`; `WHERE ... AND capacity_enabled` →
`practitioner_id`) + a CHECK `capacity_enabled IS FALSE OR practitioner_id IS NOT NULL`
(no silent-NULL practitioner can escape the per-practitioner GiST on an ON studio — closes
the NULL-GiST hole and STOP-e). *Alternative considered:* drop `0029` and let the shadow be
sole authority (simpler, still Willow-neutral because the shadow mirrors every confirmed
appointment). The re-key-with-CHECK path is preferred because it keeps a direct
appointment-level guard **and** the NOT-NULL-on-ON invariant.

### Fan-out lifecycle (the real cost of this model)

- **Studio-wide block created (ON studio):** insert one shadow row per practitioner in
  the studio — **all** practitioners, not only active ones. An appointment's shadow row is
  keyed by its `practitioner_id` regardless of that practitioner's active state (a
  practitioner can be deactivated while still holding confirmed appointments), so the block
  must cover them too, or a block could fail to collide with a live appointment — a
  divergence from today's guaranteed studio-wide block. (Adversarial-review finding 1.)
- **Practitioner added (ON studio):** re-fan existing studio-wide blocks to include them.
- **Practitioner removed (ON studio):** the `shadow.practitioner_id` `ON DELETE CASCADE`
  drops their fanned rows and the rebuild re-derives the rest. A mere active-state toggle
  needs no re-fan (the fan set is all practitioners either way).
- **Flag flipped ON for a studio with existing data:** an idempotent
  `rematerialize_studio_reservations(studio_id)` re-derives every row's `resource_key`
  (appointments → their practitioner; blocks → fan-out). This runs only at a
  **separately-authorized activation**, never in PR A's default-off path.

### Which appointments the capacity model touches

`capacity_enabled` and the practitioner-required CHECK are scoped to **collision-
participating statuses only** (`confirmed`, `completed` — the statuses that enter the
per-practitioner exclusion or get a per-practitioner shadow row). `cancelled` / `no_show`
rows are exempt: the public path legitimately writes `practitioner_id = owner?.id ?? null`
and such a row must never (a) block activation of a studio or (b) block the removal of a
practitioner via the `ON DELETE SET NULL` FK. (Adversarial-review findings 2 & 3.)
Consequently, on an ON studio a practitioner holding a **confirmed** appointment cannot be
hard-deleted (the CHECK correctly refuses to null a live booking) — deactivate or reassign
first; a practitioner with only cancelled history deletes cleanly.

For **PR A** (default OFF, no studio activated) the machinery must exist and be proven, but
all production rows keep `resource_key = studio_id`. The 13 DB tests exercise the ON path on
**synthetic** `seedSynthStudioB` (owner + 2 practitioners) by setting the flag in-test and
creating data under the ON triggers.

---

## Stop-condition assessment (all seven)

| Stop condition | Verdict | Basis |
|---|---|---|
| (a) Only-safe implementation requires a **destructive** migration | **NOT triggered** | All changes additive (nullable columns, new table, new flag). The one non-additive step is a metadata-only GiST constraint **swap** — no row/column dropped or rewritten. |
| (b) Appointments cannot be backfilled **unambiguously** into per-practitioner reservations | **NOT triggered (on current data)** | Hosted: **0** confirmed/completed appointments with NULL `practitioner_id` (84 total / 42 confirmed). Every existing appointment maps to exactly one practitioner. The design *also* handles NULL rows safely regardless (they stay `resource_key = studio_id` while OFF; the CHECK forbids NULL only when a studio is ON). If a future prod re-check finds NULLs, activation for that studio is blocked until resolved by policy — but PR A is safe today. |
| (c) Service/practitioner ownership **inconsistent** | **NOT triggered** | `services.studio_id` and `practitioners.studio_id` both NOT NULL, FK→`studios` ON DELETE CASCADE. No null-owner, cross-studio, or orphan rows possible. The new `service_practitioners` table adds a same-studio CHECK/FK so the invariant is enforced going forward. |
| (d) Willow behaviour would change while the flag is **off** | **NOT triggered (by construction)** | Flag column additive default-false read `=== true`; for OFF studios `resource_key = studio_id` so the re-keyed exclusion + slot read reproduce today's studio-wide result exactly; no backfill `UPDATE` touches Willow; eligibility backfill = all-active = today. Any deviation would be a bug the 13 tests must catch (OFF-parity assertions included). |
| (e) Same-practitioner race safety **cannot** be guaranteed at the DB layer | **NOT triggered** | Guaranteed by the per-practitioner GiST exclusion, once ON-studio appointments are `practitioner_id NOT NULL` — enforced by the CHECK above. GiST provides the same transactional 23P01 the studio-wide constraint does today; the `0133` move RPC keeps its conflict safety because the shadow re-sync fires inside its transaction. |
| (f) Production migration or flag change required to proceed | **NOT triggered** | PR A is a **draft**; migration is authored, **not** hosted-applied; no flag flipped. All validation runs on the local db-integration lane against synthetic studios. |
| (g) A legal/identity P1 becomes a prerequisite | **NOT triggered** | No new PII, auth realm, or provider surface; charting-under-own-identity already exists (appointments carry `practitioner_id`; practitioners authenticate). Existing open P1s (P1-01 identity, P1-10 txn boundary) are adjacent, not prerequisite, to an additive default-off capacity foundation. |

**Conclusion:** no stop condition is triggered. The work proceeds as authored (not merged)
draft PRs.

---

## PR breakdown (dependency-ordered; each opened as a **draft**, none merged)

- **PR A — additive resource-capacity foundation.** Migration `0134`: `studios
  .practitioner_capacity_enabled boolean not null default false`; `studio_calendar_reservations`
  + `practitioner_id`, `resource_key`; widen arbiter to `(source_kind, source_id,
  resource_key)`; swap the studio-wide shadow exclusion for the `resource_key` exclusion;
  re-key `0029` via denormalized `capacity_enabled` + CHECK; extend the appointment /
  timed-block / blockout / recurring-break shadow writers to compute `resource_key` + fan out;
  `service_practitioners` table + same-studio invariant + all-active backfill;
  `rematerialize_studio_reservations()` (activation-time, unused while OFF); a no-PII
  verifier; **13 DB tests** (OFF-parity, ON-parallelism, same-practitioner block, block-fans-
  to-all-practitioners, eligibility backfill, NULL-safety, flag-flip rematerialization,
  cross-studio isolation, arbiter idempotency). Default OFF; Willow explicitly false.
- **PR B — practitioner availability + authenticated calendar.** Nullable `practitioner_id`
  on availability/break/blockout/timed-block tables (NULL = studio fallback);
  practitioner-aware `getAvailableSlots`; per-practitioner calendar rendering. Gated on the
  flag; OFF = today.
- **PR C — public practitioner selection + fair assignment.** "Any available practitioner"
  or a specific eligible practitioner; transactional, deterministic, fair rule: *eligible +
  available → lowest booked minutes in the comparison window → oldest last assignment →
  stable practitioner-id tie-break*; server-side only, never trusts a browser id, never
  silently assigns the owner.

Then Part 4 (3-practitioner E2E on synthetic Studio B), Part 5 (feature controls + no-PII
verifier), Part 6 (gates). **Stop before merging PR A, B, or C.** Final recommendation is
for PR A only.

### Scoped calendar sources (PR B 3C–3E)

Timed blocks and recurring break rules/occurrences carry an optional `practitioner_id`
(`NULL` = studio-wide; `= P` = only P; full-day blockouts stay studio-wide). One canonical
`sync_scoped_calendar_reservation` materializes every source by the state table:
**Legacy (capacity OFF) + studio-wide → one studio-keyed row; Legacy + scoped → ZERO rows
(retained but DORMANT — never widened to a studio-wide closure); capacity ON + studio-wide →
fan out to every practitioner; capacity ON + scoped → one `resource_key = P` row.** It
delete-then-inserts inside the source transaction and does not swallow the GiST `23P01`, so any
scope/time transition is atomic and a conflict rolls the source + shadow back together. Every
structural-reservation mutation (source writes via the guard, `materialize_*`/`update_*` RPCs,
and `rematerialize_studio_reservations`) first takes the shared per-studio transaction advisory
lock (0136), so a scoped source cannot appear between a retirement preflight and deactivation.
On re-enable, retained scoped sources rematerialize under their original practitioner scope.

---

## Final pre-merge gates (PR #457)

### Gate 1 — the capacity flag is operator-controlled, not tenant-writable

`studios` has a row-level owner-UPDATE policy (`"studios: owners update"`, 0001), and RLS
cannot restrict columns, so an owner could otherwise `UPDATE studios SET
practitioner_capacity_enabled = true` via a direct table write (UI absence is not
protection). 0134 adds a **SECURITY INVOKER** `BEFORE UPDATE OF practitioner_capacity_enabled`
guard (`guard_capacity_flag_activation`) that raises `42501` when the value changes and
`current_user IN ('anon','authenticated')`. Result: anon / non-owner → 0 rows (RLS); owner →
`42501` (guard); service role / operator → allowed. Activation stays a reviewed operator action.

### Gate 2 — SECURITY DEFINER helpers are not browser-callable

Every mutation-capable / trigger function 0134 creates is `EXECUTE`-revoked from
`public`, `anon`, and `authenticated` (Step 11 loop): `set_appointment_capacity_enabled`,
`studio_capacity_enabled`, `fanout_studio_wide_reservation`, the four
`sync_*_to_calendar_reservation` mirrors, `rematerialize_studio_reservations`,
`on_studio_capacity_flag_change`, `on_practitioner_change_refan`,
`default_eligibility_for_service/_practitioner`, `set_reservation_resource_key_default`, and
both guards. Trigger functions keep firing regardless (trigger execution does not check the
invoker's EXECUTE privilege), but no browser role can call them directly — proven by DB tests
that get `42501` calling `rematerialize`/`fanout`/`studio_capacity_enabled` as `authenticated`/
`anon`. Definer helpers are `SECURITY DEFINER` with `search_path = pg_catalog, pg_temp`; the
Gate-1 guard is deliberately INVOKER so it sees the real caller.

### Gate 3 — `service_practitioners` authorization

RLS on; **member/owner SELECT only, no browser write policy** — writes are service-role /
definer-trigger only until PR B ships the reviewed owner-managed eligibility contract.
Same-studio enforced by composite FKs to the 0032 companion uniques. A `BEFORE INSERT` guard
rejects marking an **inactive** practitioner eligible (`23514`); the backfill + default
triggers only ever add active practitioners. Removal is explicit (a practitioner deactivated
after being eligible keeps existing rows; hard-delete cascades via the composite FK).

### Gate 4 — migration apply impact (real migration, not "just metadata")

0134 takes `EXCLUSIVE` locks on `studio_calendar_reservations` + `appointments`, drops/recreates
two GiST exclusions, adds columns, and backfills derived fields — treat as a real production
migration.

- **Current prod size** (read-only, 2026-07-20): appointments **84** (42 confirmed),
  `studio_calendar_reservations` **74**, studios **3**, active practitioners **3**, services
  **9**; hosted migration max **0133** (0134 not applied).
- **Work done in-txn:** backfill `resource_key = studio_id` (74 rows), `capacity_enabled = false`
  (84 rows), `service_practitioners` (9 services × active practitioners), + rebuild two GiST
  exclusions over ~74/84 rows. `btree_gist` already installed.
- **Estimated lock duration:** sub-second at current size; the GiST rebuilds dominate and are
  trivial at this scale. Even at 100× (~8k appts / 7k reservations) it stays within a few
  seconds. Constraint/index build time is negligible.
- **Live-booking impact while locked:** `EXCLUSIVE` mode allows plain SELECTs but blocks
  concurrent INSERT/UPDATE/DELETE (new bookings, moves, blocks) for the lock's duration —
  sub-second here, so booking writes queue briefly then proceed. Apply in an off-peak,
  studio-local low-traffic window regardless.
- **Timeout / abort plan:** apply the session with a bounded `lock_timeout` (e.g. 5s) and
  `statement_timeout` (e.g. 30s) so it fails fast instead of queueing behind a long lock. Abort
  criteria: `lock_timeout` trips (couldn't acquire the exclusive lock) → retry in a quieter
  window; any statement error → the single `begin…commit` rolls back atomically (no partial
  state) → investigate before retry.
- **Post-apply verification:** run `scripts/verify-practitioner-capacity.mjs` (dormancy,
  OFF-parity, integrity, orphans, eligibility coverage, per-practitioner overlaps); confirm
  hosted migration max = 0134, every studio flag `false`, zero orphan reservations, and every
  reservation `resource_key = studio_id`.

**Merge ≠ apply ≠ activate.** Merging PR #457 lands the code only; hosted apply is a separately
authorized, migration-first window (per [[hone-prod-migration-process]]), and enabling the flag
for any studio is a further separately authorized step gated behind PR B + PR C.
