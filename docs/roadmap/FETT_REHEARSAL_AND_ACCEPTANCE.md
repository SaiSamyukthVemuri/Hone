# Fett Derm — synthetic rehearsal and acceptance plan

**Owner:** DB / WAIT lane (#824). **Target:** the Friday 2026-10-16 Fett meeting,
rehearsed Thursday 2026-10-15.

**This document is evidence and a plan, never authority.** It does not authorize
a release, a production write, a studio activation or any claim to Fett. Where it
reports what the product can do, the claim is tied to a file and line on the
**0210** chain (repo max 0210 == hosted 0210 at the time of writing; re-derive
with `npm run migration:state -- --json` before relying on it).

**It labels only what this lane verified.** Rows owned by other lanes are marked
*not verified here* and name the owner. A row this lane did not measure is not
evidence, and must not be read as either a pass or a fail.

---

## 1. The rehearsal fixture

`tests/db/helpers/fett-fixture.ts` (PR #853) seeds the synthetic studio:
`America/Los_Angeles`, owner plus five treating practitioners, two electrolysis
services, Mon–Fri availability, and — load-bearing — the **practitioner-capacity
state**.

```bash
export HONE_LOCAL_DB_URL="postgresql://postgres:postgres@127.0.0.1:<port>/postgres"
npx vitest run --config vitest.db.config.ts tests/db/fett-fixture.db.test.ts
```

Everything it seeds is recognizably synthetic — `SYNTH-FETT` names,
`@synth.local` emails, run-unique ids. **No real tenant, no production, no
patient data, no live message.**

### The one thing a rehearsal must not get wrong

`practitioner_capacity_enabled` and `practitioner_capacity_booking_enabled`
(`0134`, `0136`) **both default false**, which is `LEGACY` — **one studio-wide
resource**. Five practitioners in a LEGACY studio **cannot hold parallel
appointments.** A rehearsal that forgets this does not demonstrate a
five-practitioner studio; it demonstrates a single-chair studio with five names
on it, and the second parallel booking is refused.

| State | `capacity` | `booking` | Meaning |
|---|---|---|---|
| `LEGACY` | false | false | one studio-wide resource — **the default** |
| `CAPACITY_READY_BOOKING_PAUSED` | true | false | configured, or paused, or draining |
| `LIVE` | true | true | practitioner-aware bookings |

`capacity=false + booking=true` is rejected by the CHECK at `0136:52`. The
fixture defaults to `LIVE` and proves it by booking the **same instant for two
different practitioners**, with the `LEGACY` refusal as its control.

---

## 2. Readiness for the ten capabilities #824 requires

#824:175 requires the demo to show ten things. Verified status on the 0210 chain:

| # | Required | Status on 0210 | Evidence |
|---|---|---|---|
| 1 | Five treating practitioners + owner | **Supported and proven**, but only in `LIVE` capacity state | `practitioners` (`0001:18`); `0134`/`0136` flags, default off; two same-instant bookings measured via `create_internal_appointment_v2` (§2.1) |
| 2 | Restricted receptionist | **Not possible on this chain** | `practitioners.role` is `check (role in ('owner','practitioner'))` (`0001:24`); `receptionist` appears in no migration on the chain |
| 3 | Simultaneous resource scheduling | **Per-practitioner: works, and is proven. There is no resource/room model.** | Of the **97** tables created on the chain, none is a resource, room, equipment, device, machine, chair or bay. Concurrency is modelled as practitioner capacity (`0134`/`0136`) and demonstrated in §2.1 |
| 4 | Intake / status | *Not verified by this lane* | Intake surfaces exist under `app/intake`; readiness owned by the ONB/intake lane |
| 5 | Treatment recording | *Partly verified* — clinical records exist | `0119`, `0120` (finalization, corrections/amendments). Depth owned by the clinical lane |
| 6 | Next-visit history | *Not verified by this lane* | Owned by the clinical/records lane |
| 7 | Machine-first selection | **No data model exists** | No device/machine table among the 97. `probe_lots` (`0001:65`) is **consumable** tracking — probe size, lot number, expiry — not a schedulable machine. #829's contract is unverified and Fett's inventory is unknown |
| 8 | Operational administration | *Not verified by this lane* | Owned by the studio-readiness lane (#824 / #825) |
| 9 | USD flows | **Not supported on this chain** | `currency` defaults to **`'cad'`** (`0073:113`, `0187:126`, `0064:141`); `services` has **no** currency column. Owned by the Audit/USD lane (#833 `0214` and stack) |
| 10 | Messaging / failure visibility | *Not verified by this lane* | Owned by the delivery lanes (#832, #843, #846, #849) |

### 2.1 Practitioner-aware concurrent scheduling already works — on the staff path

**Measured on a real 0210 stack, not inferred.**
`public.create_internal_appointment_v2` — the current internal booking command
(`0142` → `0146` → `0147` → `0152`; only the `_v2` name exists at runtime) —
takes **`p_target_practitioner_id`**. On a `LIVE` fixture studio it created
**two appointments at the same instant for two different practitioners**, both
returning `result = 'created'`, two distinct `practitioner_id` values.

The control: on the same fixture seeded `LEGACY`, the second booking is
**refused** by exclusion constraint
`no_overlapping_appointments_studio_wide`, leaving one appointment.

So Friday **can** demonstrate five-practitioner concurrent scheduling through
real product code. Proven by `tests/db/fett-fixture.db.test.ts`, which books
through that command rather than INSERTing, so the availability validator,
duration authority and buffer rules are exercised too.

Two details that bite anyone reproducing this:

* the cancellation token hash must match `^[a-f0-9]{64}$`
  (`0090_appointment_token_hash.sql:89`) — a readable placeholder is rejected
  by the CHECK;
* `node-postgres` returns `timestamptz` as a **Date**, so comparing two equal
  instants with `toBe` fails on object identity. Compare `getTime()`.

### A gap in the ordinary booking path, owned by this lane

`create_public_appointment` (`0170:636`) **takes no practitioner parameter**,
and `public_booking_slot_candidates` (`0209:49`) takes none either. So public
booking cannot select a practitioner — reproduced with a load-bearing control in
PR #840.

What it does instead is sharper than "it picks someone". Assignment is
server-derived from the **active-owner count** (`0170:790-808`), deliberately:

| Active owners | Assigned practitioner |
|---|---|
| 0 | `NULL` — the booking still succeeds |
| 1 | **that owner** |
| 2+ | `NULL` — no arbitrary winner is invented |

The comment there is explicit that an earlier revision's `order by created_at
asc limit 1` "silently invented a product rule" and was removed.

**So for a Fett-shaped studio — one owner plus five electrologists — every
ordinary public booking is attributed to the owner, and none to the five
treating practitioners.** That decides appointment attribution, the
notification recipient and the client-facing practitioner name. It is the
single most visible gap between the current public path and a
five-practitioner practice, and it is not a bug in the function: the function
is behaving exactly as documented for a surface that has no practitioner
concept yet.

The implementation slice is **not blocked on design** — it is blocked on a
migration number. DB/WAIT holds the **`0219` queue position** (see §4).

---

## 3. The Thursday rehearsal sequence

Run in order. Each step names what it proves and what it must not be read as
proving.

1. **Seed** the fixture at `LIVE`. Proves: a five-practitioner LA studio exists
   with real availability. Does **not** prove any production studio is
   configured this way.
2. **Parallel booking through the real command** — `bookFettInternal` →
   `create_internal_appointment_v2`, same instant, two different
   practitioners. Proves: genuinely concurrent practitioner scheduling on the
   staff-facing path, through product code rather than a raw INSERT. The
   `LEGACY` control in the suite is what makes this meaningful.
3. **Capacity pause** — flip to `CAPACITY_READY_BOOKING_PAUSED`. Proves: the
   emergency pause is instant and does not rematerialize existing parallel
   appointments (`0136`'s stated reason for splitting the two flags).
4. **Ordinary public booking** — demonstrate the path as it is, and **say
   plainly** that practitioner selection is not available on it yet (§2).
5. **Treatment recording** against a seeded client. Label depth honestly; this
   lane verified existence, not completeness.
6. **Teardown** — `dropFettStudio`. Proves: nothing persists. Note the
   `appointment_audit` RESTRICT discipline: a studio that has been booked
   cannot be deleted until its trail is purged, and the suite proves a bare
   delete is refused first.

**Not in the rehearsal, because the chain cannot do it:** receptionist access
(2), machine-first selection (7), USD (9). Demonstrating a mock of any of these
as though it were the product would be the one failure this document exists to
prevent.

---

## 4. Schedule risk that is not a code problem

The G1 implementation needs one forward migration, and DB/WAIT is **last in the
queue** at `0219`. `tests/docs/canonical-production-facts.test.ts:568-578`
requires the pending suffix to be **contiguous** from `hosted + 1`, admitting
only permanently-skipped slots (`scripts/migration-state.mjs:43` skips exactly
`0158`). So a `0219` migration **cannot go green on its own branch**: it needs
`0211`–`0218` present, i.e. stacked on them or landed after them.

Verified claims at the time of writing — read from each PR's own head, not from
any list: `0211` #827, `0212` #832, `0213` #831, `0214` #833, `0215` #843,
`0216` #838, `0217` #844, `0218` #850. **Re-census before claiming a number**;
this list is historical the moment it is written.

Consequence for Friday, stated precisely so it is not over-read:
practitioner-aware **public** booking lands **after** eight other migrations,
or not before the meeting. That is a sequencing fact to plan around, not a
defect to fix in this lane.

It does **not** mean multi-practitioner operation cannot be shown. §2.1 proves
concurrent per-practitioner scheduling works today through the staff-facing
command. What Friday cannot show is a **client** choosing their practitioner on
the public booking page.

---

## 5. Labelling rules for the meeting

1. **Name the chain.** "On the current production schema" is part of every
   claim, because `0211`–`0218` are unmerged and change several rows above.
2. **Synthetic is synthetic.** The studio, the practitioners and the client are
   fixtures. Nothing shown is a Fett record or a patient record.
3. **A gap is stated, not skipped.** Receptionist, machine selection and USD are
   named as unavailable, with their owning lane.
4. **No compliance claim.** Nothing here speaks to HIPAA, a BAA, or Fett's
   covered-entity status; #828's evidence gate is separate and green CI does not
   establish it.
