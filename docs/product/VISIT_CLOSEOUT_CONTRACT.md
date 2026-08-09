# Visit Closeout — product + engineering contract

**Status:** SPECIFICATION ONLY. No runtime code, no migration, no schema, no
production access. Nothing in this document has been built.

**Written against:** `ac3af8490d52928f3a8ecc50c5c5abaac242de45` (production head,
PR #532 / B3 merged).

**Scope note on numbering:** this document proposes no migration number. Where
schema or a governed command is required, it says so and stops there.

---

## 1. Executive product contract

Hone should not merely remember treatments. It should make sure each visit
actually gets **closed**.

```
Treat → Chart → Close → Collect → Rebook
```

The product rule, stated once and enforced everywhere:

> **Completed work disappears. Unfinished work returns to To do.**

Two corollaries that most of this document exists to defend:

1. **A visit is not operationally complete because its scheduled end passed.**
   Time is not evidence. Neither is the existence of a treatment record.
2. **Absence of evidence is never converted into a fact.** An old appointment
   with no payment row is not "unpaid"; it is *unknown*. An appointment that
   nobody ever marked is not "attended"; it is *unresolved*.

A visit is closed when every dimension that *applies* to it is resolved. It is
not closed because a clock advanced.

### The gap this closes, in one sentence

Hone already computes four of the five dimensions somewhere, but no single
surface asks "is this visit finished?", and **money is absent from the to-do
model entirely** — so a treated, charted, completed visit with nothing collected
looks identical to a finished one.

---

## 2. Current truth

Truth is stated at three different confidence levels throughout this document.
Conflating them is the most likely way this contract goes wrong.

| Tier | Meaning |
|---|---|
| **DEPLOYED** | In the production tree *and* the corresponding database state is applied. Safe to build on. |
| **MERGED, NOT APPLIED** | Code is in the production tree; the database half is not applied. **Must not be assumed at runtime.** |
| **DRAFT** | Unmerged PR. **Must not be depended on at all.** |

### 2.1 Appointment status — DEPLOYED

`supabase/migrations/0010_booking_v1.sql:183`

```sql
status text not null default 'confirmed'
  check (status in ('confirmed','cancelled','completed','no_show'))
```

Four statuses, default `confirmed`. There is no `attended`, no `in_progress`,
no `closed`.

### 2.2 Who writes the terminal statuses — DEPLOYED

- `mark_appointment_complete` (RPC, migration 0032), called from
  `app/(app)/calendar/actions.ts:551` and
  `app/(app)/clients/[id]/sessions/new/actions.ts:49`.
- `mark_appointment_no_show` (RPC, migration 0033), called from
  `app/(app)/calendar/actions.ts:609`.

Both are SECURITY DEFINER and service-role invoked. Completion is gated on the
appointment having ended.

> **Correct a stale comment before relying on it.**
> `app/api/cron/no-show-check/route.ts:17` still says *"There was no application
> UI calling `mark_appointment_complete()`"*. That was true when the cron was
> disabled; it is **no longer true**. Completion UI exists. The cron itself
> remains genuinely non-mutating and `studios.auto_mark_no_shows` is
> **FORCE-OFF** (`app/(app)/settings/studio/actions.ts:129`).

**Consequence that drives this whole contract:** nothing advances an appointment
out of `confirmed` automatically. A visit that happened, and was charted, can sit
at `confirmed` forever if nobody pressed the button. Production bears this out —
Probe 6 on 2026-08-09 read 152 appointments: 70 `confirmed`, 47 `completed`,
31 `cancelled`, 4 `no_show`.

### 2.3 Charting authority — DEPLOYED

Charted means **at least one non-deleted `session_block` on a linked,
non-deleted session**. Not "a session row exists".

Three places already agree on this, and they must not diverge:

- `lib/sessions/finish-appointment.ts` — `chartedBlockCount > 0 → "charted"`
- `lib/dashboard/next-action.ts:20` — `hasChartedArea`
- `lib/dashboard/practice-metrics.ts` (charted-within-24h) — *"'Charted'
  requires at least one treatment area: a session row with zero areas has no
  recorded treatment details and does not count."*

Linkage is `sessions.appointment_id` (migration 0068). Before 0068 sessions had
no appointment link at all — see §7. `session_blocks` soft-delete via
`deleted_at` (`0019_session_blocks.sql:35`), so "non-deleted" is load-bearing.

### 2.4 The closeout presenter that already exists — DEPLOYED

`lib/sessions/finish-appointment.ts` is, in effect, **Visit Closeout v0**. It is
pure, clock-injected, and resolves four dimensions:

| dimension | states |
|---|---|
| charting | `charted` / `empty` |
| aftercare | `recorded` / `not_marked` |
| completion | `unlinked` / `before_end` / `ready` / `completed` / `cancelled` / `no_show` |
| postcare | `unlinked` / `no_client_email` / `not_configured` / `sending` / `sent` / `failed` / `not_sent` |

It **has no payment dimension and no rebooking dimension.** That is the hole.

Its self-description is also the governing principle for everything proposed
here: *"This module decides WHAT TO SHOW. It decides nothing about what is
ALLOWED."* Every state in this contract is a **presenter** state, re-derived
server-side before any write.

Note its postcare rule, which is the model for how this contract treats money:
**a claim is not a send.** `sent` requires a provider-confirmed `sent_at`;
attempts and claims do not count.

### 2.5 The to-do model that already exists — DEPLOYED

`lib/dashboard/missing-records-assistant.ts` (PR #249), five item types:

| # | rule | type |
|---|---|---|
| 1 | completed appointment with no charted session | `charting` |
| 2 | recorded session, aftercare/risks not marked | `aftercare` |
| 3 | recorded treatment area with no probe lot | `probe_lot` |
| 4 | intake started but not submitted | `intake` |
| 5 | for-next-visit note with no upcoming appointment | `follow_up` |

Rules-based only; no AI, no autonomous action; every item links to an existing
studio-scoped route; it writes nothing. It explicitly mirrors
`lib/sessions/before-today.ts` and `lib/dashboard/next-action.ts` *"so the two
can never disagree"* — a constraint this contract inherits rather than
re-litigates.

**There is no payment item type.** Money is absent from the to-do model.

### 2.6 Financial truth — DEPLOYED

Two different tables, two different meanings. Confusing them is the single
biggest financial risk in this design.

**`appointment_payments`** (`0032_stripe_connect_phase_1.sql:746`) — the
booking-time card binding, PK'd on `appointment_id`:

```sql
payment_status text not null default 'method_saved' check (payment_status in (
  'method_saved', 'charged', 'authentication_required',
  'failed', 'partially_refunded', 'refunded', 'disputed',
  'double_charged', 'reconciliation_required'))
```

The default is `method_saved`. **A saved card is not money.** The product
requirement "payment method saved is NOT the same as collected" is not an
aspiration here — it is the literal default value of the column.

**`payment_charge_attempts`** (`0073_payment_charge_attempts.sql`) — described
in `lib/billing/session-payment-charge.ts` as *the canonical ledger*:

```sql
charge_reason in ('session_payment','late_cancellation_fee','no_show_fee')
status        in ('ready','blocked','cancelled','pending_stripe','succeeded','failed')
amount_cents  > 0 and <= 200000,  currency 'cad'
```

Plus `stripe_refunds` / `stripe_refund_attempts` for refunds, and
`manual_fee_charge_attempts` (0064) for the late-cancel / no-show fee flow,
which requires an `appointment_policy_acknowledgement_id`.

### 2.7 The existing metric contracts — DEPLOYED, and binding

`lib/dashboard/practice-metrics.ts` already defines the studio's money words,
and **this contract adopts them rather than inventing a second vocabulary**:

- `bookedValueCents` / `completedValueCents` are **service-menu price totals**,
  not collected revenue. The module says so explicitly: *"nothing here is
  'revenue': the UI labels everything as booked/completed SERVICE VALUE based on
  service menu prices."*
- Appointments with no service price contribute **nothing** — *"never
  invented"*. Same posture this contract takes toward unknown payment state.
- `summarizeAppointments` counts `completed`, `cancelled`, `noShows`,
  `lateCancellations` (the last keyed on `cancellation_reason === 'late_cancellation'`).

**Therefore: Visit Closeout must never emit a number that looks like revenue.**
"Collected" in this contract is a *per-visit resolution state*, never a studio
total. If a studio-level collected total is ever wanted, it belongs in
practice-metrics under its own reviewed definition, not here.

### 2.8 Appointment DML boundary — MERGED, NOT APPLIED ⚠️

`0172_revoke_authenticated_appointment_dml.sql` is in the production tree as of
`ac3af84`. It revokes `insert/update/delete` (plus `truncate/references/trigger/maintain`)
on `public.appointments` and `public.appointment_audit` from `anon` and
`authenticated`.

**It is NOT applied to the production database.** Hosted migration max is
**0171**; `0172` is pending. Verified 2026-08-09 by `supabase migration list --linked`
and a dry run listing exactly that one file.

So at runtime today, direct browser DML on appointments is *still technically
reachable*, even though zero shipped writers use it. Any closeout design must
therefore be correct **before and after** 0172 is applied — which it is, if it
only ever writes through governed commands.

### 2.9 B4 / appointment repair — DRAFT, DO NOT DEPEND ⚠️

PR #534 (`security/appointment-dml-b4-0173`) is **open, draft, never merged**.
It proposes governed appointment repair commands and includes
`AppointmentOutcomeRepair.tsx` and `appointment-repair-contract.ts`, plus
migration 0173.

That is very close to the "Resolve outcome" capability this contract needs.
**It is not available.** Everything below is specified so that:

- the closeout **read** model works today with zero dependency on B4, and
- the closeout **write** path for outcome correction is deferred to B4/B5 rather
  than duplicated.

---

## 3. Closeout dimensions

Five dimensions. Each is independently resolvable — see §4 for why this is a
checklist, not a pipeline.

### 3.1 Chart

| question | authority | today? |
|---|---|---|
| Does a treatment record exist? | linked non-deleted `sessions` row | ✅ |
| Is it actually charted? | ≥1 non-deleted `session_blocks` row | ✅ |
| Is charting *complete*? | see below | ⚠️ partial |

**"Exists" ≠ "charted" ≠ "complete".** Three different questions, and Hone
already answers the first two. The third exists only in the record-keeping
completeness sweep (`summarizeProcedureCompleteness`), which checks client
DOB/phone/email/address, operator, ≥1 treatment area, a probe lot on every area,
and the aftercare mark.

**Decision:** Closeout adopts *charted* (≥1 area) as the chart dimension, and
treats probe-lot and aftercare as their **own existing to-do items** rather than
folding them in. They already exist as item types 2 and 3 (§2.5); folding them
into "chart" would duplicate them, violating the no-duplication rule in §6.

**Appointment outcome is not charting.** A charted visit at `confirmed` is
charted-and-unresolved. A `completed` visit with no session is
resolved-and-uncharted. Both are real and both occur.

### 3.2 Outcome

| state | meaning |
|---|---|
| `confirmed` | **unresolved** — nobody has said what happened |
| `completed` | attended, resolved |
| `no_show` | client did not attend, resolved |
| `cancelled` | visit did not happen, resolved |

**What is ambiguous today, honestly stated:**

1. `confirmed` is overloaded. It means both "upcoming, expected" *and* "in the
   past, nobody resolved it". Only the clock separates them, and the clock is
   not evidence — it only tells us the question is *now askable*.
2. There is no `attended-but-not-yet-completed` state. Marking complete is the
   only affirmance.
3. Nothing auto-resolves. `auto_mark_no_shows` is force-off and the cron is
   non-mutating, deliberately — the disabled cron's own comment records that its
   `starts_at + 30min` heuristic wrongly flipped attended visits to `no_show`.
   **This contract does not propose re-enabling it.** A past `confirmed`
   appointment is *unresolved*, never *presumed no-show*.

### 3.3 Collect

Ordered from weakest to strongest evidence. **Only the last is money.**

| signal | source | means |
|---|---|---|
| card on file | `appointment_payments.payment_status = 'method_saved'` | nothing has been charged |
| attempted | `payment_charge_attempts.status in ('ready','pending_stripe')` | in flight, not money |
| blocked/failed | `status in ('blocked','failed')` | **outstanding**, needs action |
| cancelled | `status = 'cancelled'` | attempt abandoned |
| **collected** | `status = 'succeeded'` | **money** |
| refunded | `stripe_refunds` / `partially_refunded` / `refunded` | money returned |

**Authoritative for "collected": a `succeeded` row in `payment_charge_attempts`.**
Nothing else. Per §2.7 this is a per-visit state, never summed into a
revenue-looking figure.

**The hard part is "outstanding", and it cannot be answered from these tables
alone.** Outstanding requires knowing an amount was *owed*, and Hone has no
per-visit "amount due" concept. Available price signals:

- `appointment_payments.booked_price_cents_snapshot` — only for card-required
  bookings that went through the pending-session flow;
- the service-menu price join used by practice-metrics — a *menu* price, not an
  invoice, and explicitly "never invented" when absent.

**Therefore:** Closeout must **not** compute "outstanding = price − collected".
That would invent an obligation the studio never recorded. The truthful states
are `collected`, `attempt_failed` (a real, actionable outstanding), `not_charged`,
and `unknown`. See §8.

### 3.4 Rebook

| question | authority | today? |
|---|---|---|
| Does a future appointment exist? | `appointments` where `starts_at >= now` and `status != 'cancelled'` | ✅ |
| Does this client *need* rebooking? | `sessions.next_session_note` (migration 0082) | ✅ |
| What cadence? | **not modelled** | ❌ |

The existing follow-up rule (`missing-records-assistant.ts:172`) fires only when
that note is present **and** no upcoming appointment exists. That is practitioner
intent, recorded by a human.

> ⚠️ **Two similarly-named fields, one of which is a trap.** The plan-for-next-visit
> note that drives this rule is **`sessions.next_session_note`** (0082, clinical
> memory) — the same column `lib/dashboard/clients-needing-attention.ts:47` reads.
> There is a *different* `next_visit_note` column on the **imported treatment
> memory** table (0089), surfaced by `lib/imported-treatment-memory.ts:130`; it
> does **not** feed this rule. To complete the trap, the assistant's TypeScript
> field is called `nextVisitNote` while it is populated from `row.next_session_note`
> (`missing-records-assistant.ts:361`). Any implementation must read the column,
> not the field name.

**This contract explicitly refuses to invent generic cadence** (no 90-day rule,
no "usually rebooks every N weeks"). Absent a recorded intent, the rebooking
dimension is `unknown` — not "needs rebooking".

⚠️ **A precision limit worth stating plainly:** the existing rule resolves
upcoming-ness **per client**, not per visit (`upcomingClientIds`,
`missing-records-assistant.ts:365-377`). A client with *any* future appointment
satisfies it. That is correct and sufficient for "does this person have a next
visit booked?", and this contract keeps it rather than silently tightening it to
per-visit, which would surface follow-ups for clients who are in fact booked.

---

## 4. State model — a checklist, not a pipeline

**The linear model in the brief does not survive contact with the repository.**
A worked example: a client is treated and charted, pays cash outside Hone, and
rebooks at the desk — but nobody pressed *Mark completed*. Chart ✅, Collect
n/a, Rebook ✅, Outcome ❌. A pipeline that gates payment behind outcome would
report this visit as "needs outcome" and hide the fact that everything else is
already done; worse, a pipeline implies rebooking cannot be assessed until money
is resolved, which is simply false.

So: **five independent dimensions, each with its own state**, plus one derived
roll-up.

```
                    ┌───────────────────────────────────┐
   visit underway → │  chart    outcome   collect       │ → visit_closed
                    │  postcare rebook                  │
                    └───────────────────────────────────┘
                       each resolves independently
```

### 4.1 Per-dimension state vocabulary

Every dimension resolves to exactly one:

| state | meaning | counts as resolved? |
|---|---|---|
| `not_applicable` | dimension cannot apply to this visit | ✅ yes |
| `complete` | affirmatively done, with evidence | ✅ yes |
| `unresolved` | applies, not done, actionable now | ❌ no |
| `blocked` | applies, not done, **cannot** be actioned yet | ❌ no |
| `unknown` | insufficient recorded evidence to say | ❌ no — but never actioned |

`blocked` and `unknown` are distinct and both are necessary:

- **`blocked`** — real precondition failure. *Postcare* when the client has no
  email (`no_client_email`) or the studio has not written aftercare text
  (`not_configured`); *outcome* when the appointment has not ended yet
  (`before_end`).
- **`unknown`** — the record cannot answer. Historical visits (§7). An `unknown`
  dimension **never becomes a to-do item** — you cannot action an absence.

### 4.2 The one ordering constraint that is real

There is exactly one genuine dependency, and it comes from the database, not
from product preference: **completion is gated on the appointment having ended.**
`resolveCompletion()` returns `before_end` until `ends_at <= now`, and the RPC
enforces it server-side. That is `blocked`, and it resolves itself with time.

Everything else is independent. Charting does not require completion — the
sessions/new path charts and completes together, but a `confirmed` appointment
can be charted without ever being completed.

### 4.3 Applicability by outcome

| outcome | chart | collect | rebook | postcare |
|---|---|---|---|---|
| `confirmed`, not ended | `blocked` | `blocked` | `blocked` | `blocked` |
| `confirmed`, ended | applies — **outcome itself is `unresolved`** | applies | applies | applies |
| `completed` | applies | applies | applies | applies |
| `no_show` | **`not_applicable`** — nothing was treated | applies (fee may be owed) | applies | `not_applicable` |
| `cancelled` | **`not_applicable`** | applies (late-cancel fee may be owed) | applies | `not_applicable` |

`no_show` and `cancelled` keep a live **collect** dimension precisely because
`manual_fee_charge_attempts` exists for exactly those two cases
(`charge_reason in ('late_cancellation_fee','no_show_fee')`). A no-show is not
financially closed by virtue of being a no-show.

---

## 5. Definition of closed

```
visit_closed = true
  ⟺  every dimension ∈ { not_applicable, complete }
```

Equivalently: no dimension is `unresolved`, `blocked`, or `unknown`.

### 5.1 Per-dimension completion criteria

| dimension | `complete` requires | `not_applicable` when |
|---|---|---|
| **chart** | ≥1 non-deleted `session_block` on a linked non-deleted session | outcome ∈ {`no_show`,`cancelled`} |
| **outcome** | status ∈ {`completed`,`no_show`,`cancelled`} | never |
| **collect** | a `succeeded` `payment_charge_attempts` row for this visit | studio has no payment configuration, **or** no obligation was ever recorded (§8.2) |
| **rebook** | a future non-cancelled appointment exists for the client | no `sessions.next_session_note` recorded (§9.2) |
| **postcare** | provider-confirmed `sent_at` | outcome ∈ {`no_show`,`cancelled`}, or no linked appointment |

### 5.2 What `visit_closed` is not

- **Not stored.** It is derived at read time from the five dimensions. No
  column, no cache, no `closed_at`, no new status value. This is deliberate:
  a stored flag would immediately be capable of disagreeing with its own inputs,
  and the four statuses in §2.1 are a DB `CHECK` that no application may extend.
- **Not a permission.** It gates no action and blocks nothing.
- **Not retroactive.** Historical visits are not closed *or* open — see §7.
- **Not a payment guarantee.** `visit_closed` with `collect = not_applicable`
  means "no obligation was recorded", not "nothing is owed".

---

## 6. To-do integration

Closeout feeds the **existing** unified to-do model
(`lib/dashboard/missing-records-assistant.ts`), extending its item vocabulary. It
does not create a competing widget.

Each unresolved item carries four things:

| field | rule |
|---|---|
| **subject** | the client and the visit |
| **reason** | recorded-history statement of what is missing. Never clinical advice, never a diagnosis |
| **action** | one existing, studio-scoped route |
| **disappearance rule** | the exact condition that removes it — the "completed work disappears" half of the product rule |

### 6.1 Item types

| item | fires when | action | disappears when |
|---|---|---|---|
| **Chart treatment** | outcome `completed`, chart `unresolved` | `Chart appointment` | ≥1 non-deleted `session_block` on a linked session |
| **Resolve outcome** | past `ends_at`, status still `confirmed` | *(see §6.3 — read-only until B4)* | status ∈ {`completed`,`no_show`,`cancelled`} |
| **Collect payment** | a `payment_charge_attempts` row for this visit in `blocked`/`failed` | `Open payment` | a `succeeded` row exists, or the attempt is `cancelled` |
| **Rebook client** | `sessions.next_session_note` recorded, no upcoming appointment | `Open client` | a future non-cancelled appointment exists |

Types 1 and 4 **already exist** (`charting`, `follow_up`) and are reused
verbatim, not re-implemented. Types 2 and 3 are new.

### 6.2 No duplication — the binding rule

A visit must appear **once per unresolved dimension, in one place.**
Specifically:

- Closeout does **not** re-emit `aftercare` or `probe_lot`; those remain items 2
  and 3 of the existing assistant.
- Closeout does **not** re-emit `intake`; that remains item 4, and Today already
  carries the intake CTA.
- "Clients needing attention" (`lib/dashboard/clients-needing-attention.ts`)
  keeps caution/watch notes exclusively — the assistant already excludes them
  for exactly this reason, and closeout inherits that exclusion.
- Where a rule already exists, closeout **calls it**; it does not fork it. The
  assistant's own header commits to mirroring `before-today.ts` and
  `next-action.ts` "so the two can never disagree", and a forked closeout copy
  would break that guarantee on day one.

### 6.3 Resolve outcome is READ-ONLY until B4 ⚠️

*Resolve outcome* can be **surfaced** today — it is derived from `status` and
`ends_at`, both already loaded. Its **action** is the problem:

- `mark_appointment_complete` / `mark_appointment_no_show` exist and are governed
  (§2.2), so "attended" and "no-show" are actionable now.
- **Correcting a wrong outcome is not**. That is precisely B4/#534's
  `AppointmentOutcomeRepair`, which is **draft and unmerged**.

**Therefore:** ship *Resolve outcome* pointing at the existing calendar
appointment surface, whose existing governed controls the practitioner already
uses. Do not build a repair path. Do not pre-empt B4's contract.

---

## 7. Historical compatibility

The governing sentence: **absence of evidence is never converted into a fact.**

Never infer, from missing data, any of: `no_show`, attended, paid, closed,
rebooked.

### 7.1 Known historical discontinuities

| discontinuity | consequence |
|---|---|
| `sessions.appointment_id` added in **0068** | Sessions before it have **no** appointment link. A pre-0068 visit can be fully charted and still look uncharted to a link-based rule. |
| `payment_charge_attempts` added in **0073** | No ledger row can exist for an earlier visit. Payment state is `unknown`, never "unpaid". |
| Completion UI added after the no-show cron was disabled | A long tail of genuinely-attended past visits sit at `confirmed`. They are `unresolved`, **not** no-shows. |
| Imported treatment memory (**0089**) | Imported history carries its own `next_visit_note` on a **separate table**, with no Hone appointment lineage. It does not feed the follow-up rule (§3.4), so imported clients produce no rebooking signal at all — an honest gap, not a bug to paper over. |

### 7.2 Rendering rule

For a visit predating a dimension's machinery, that dimension renders `unknown`
with truthful copy — *"Not recorded"* / *"No payment record for this visit"* —
and **produces no to-do item**.

This is the same discipline already shipped elsewhere in Hone and should reuse
its vocabulary rather than invent a third: the intake review surface
distinguishes *"Not collected on this intake"* (record predates the question)
from *"Not answered"* (client was asked), precisely so an omission is never
attributed to someone who was never asked. Closeout needs the identical
distinction for money and outcome.

### 7.3 No backfill

No migration, no data repair, no retroactive marking. A studio that wants
history corrected does it through the ordinary governed path, visit by visit,
as a deliberate act — not as a silent sweep.

---

## 8. Payment truth

### 8.1 The ladder, restated as a contract

```
card saved      →  NOT collected   (appointment_payments.payment_status='method_saved')
attempt ready   →  NOT collected   (payment_charge_attempts.status='ready')
pending_stripe  →  NOT collected   — in flight is not money
blocked/failed  →  NOT collected   — and ACTIONABLE
succeeded       →  COLLECTED       ← the only source of truth for money
refunded        →  money returned  (stripe_refunds / 'refunded' / 'partially_refunded')
```

`method_saved` being the column **default** is the point: every card-required
booking starts life looking payment-adjacent while nothing has been charged.

### 8.2 What Closeout must NOT do

1. **Must not compute "outstanding" from menu price.** There is no per-visit
   invoice. Deriving `owed = service price − collected` would invent an
   obligation the studio never recorded, and would contradict
   practice-metrics' explicit "never invented" posture for missing prices.
2. **Must not emit revenue.** Per §2.7, `bookedValueCents` / `completedValueCents`
   are *service value*, not revenue, and the money vocabulary lives in
   practice-metrics. Closeout reports **per-visit resolution states only** and
   defines no new aggregate.
3. **Must not treat a saved card as collection**, in copy or in state.
4. **Must not treat cash/e-transfer as failure.** A studio taking payment
   outside Hone has no ledger row; that is `not_applicable` or `unknown`,
   never "unpaid".

### 8.3 Resulting collect states

| state | condition |
|---|---|
| `complete` | a `succeeded` attempt exists for this visit |
| `unresolved` | an attempt exists in `blocked` or `failed` |
| `blocked` | attempt in `pending_stripe` (in flight; resolves itself) |
| `not_applicable` | studio has no payment configuration for this visit |
| `unknown` | no attempt row and no recorded obligation — **including all pre-0073 visits** |

Only `unresolved` produces a to-do item. This is conservative by construction:
Hone will under-report money problems rather than accuse a client of not paying.
That asymmetry is deliberate and should not be "fixed" without a real per-visit
obligation model (§11).

---

## 9. Rebooking truth

### 9.1 Authority

- **Has a next visit:** an `appointments` row for the client with
  `starts_at >= now` and `status != 'cancelled'`.
- **Needs rebooking:** a recorded `sessions.next_session_note` with no such row —
  practitioner intent, entered by a human.

### 9.2 No invented cadence

Hone does not model treatment cadence. There is no field for "return in N
weeks", and inferring one from history would be exactly the clinical inference
the agentic-safety posture forbids (*assistant not decider; flag not diagnose;
summarize recorded history, do not invent*).

**Absent a recorded intent, rebooking is `not_applicable`, not `unresolved`.**
Hone does not nag a studio to rebook a client the practitioner never said
should return.

### 9.3 Stated limitation

Upcoming-ness is resolved **per client**, not per visit (§3.4). A client with
any future appointment satisfies the rebooking dimension for all their past
visits. This is intentional and matches the deployed rule; changing it is a
separate product decision, not an implementation detail.

---

## 10. Security / authority boundaries

| field / state | authoritative source | time authority | writer | direct browser DML? | governed command? | data sufficient today? |
|---|---|---|---|---|---|---|
| appointment status | `appointments.status` (CHECK, 0010) | `starts_at` / `ends_at` | `mark_appointment_complete` / `mark_appointment_no_show` (SECURITY DEFINER) | **No** — 0172 revokes it (⚠️ merged, not applied) | **Yes** | ✅ |
| outcome *correction* | — | — | **B4 / #534, DRAFT** | No | Yes — not yet available | ❌ blocked |
| charted | `session_blocks` (non-deleted) on linked `sessions` | `session_blocks.created_at` | existing charting actions | governed by clinical boundary (0169) | Yes | ✅ |
| aftercare | `sessions.aftercare_and_risks_explained_at` | that column | `markAftercareExplainedAction` | No | Yes | ✅ |
| postcare sent | provider-confirmed `sent_at` | that column | `sendPostcareEmailAction` (first-send claim) | No | Yes | ✅ |
| collected | `payment_charge_attempts.status='succeeded'` | attempt row | charge executor + Stripe webhook | **No** | Yes | ✅ for collected; ❌ for *outstanding* |
| card on file | `appointment_payments.payment_status` | `payment_completed_at` | Stripe webhook / finalize RPC | No | Yes | ✅ |
| manual fee | `manual_fee_charge_attempts` (requires policy acknowledgement) | `created_at` | manual-fee prepare/execute | No | Yes | ✅ |
| next appointment | `appointments` future rows | `starts_at` | booking commands (0170/0171) | **No** | Yes | ✅ |
| rebooking intent | `sessions.next_session_note` (0082) | session | charting actions | No | Yes | ✅ |
| `visit_closed` | **derived** | n/a | **nothing — never written** | n/a | n/a | ✅ |

**Two boundary rules for any implementation:**

1. **Read-only by default.** Closeout is a projection. Every write continues
   through the command that already owns it. This is the property that makes it
   correct both before and after 0172 is applied.
2. **No new appointment status.** The four values are a DB `CHECK`. "Closed" is
   derived, never stored — see §5.2.

---

## 11. Engineering gaps

| # | capability | classification | before B5/B6? |
|---|---|---|---|
| 1 | Per-visit closeout projection (5 dimensions) | **query-only + application logic** | ✅ **yes** |
| 2 | `Resolve outcome` to-do item (surface only) | **query-only** | ✅ **yes** |
| 3 | `Collect payment` to-do item (`blocked`/`failed` attempts) | **query-only** | ✅ **yes** |
| 4 | Extend assistant item vocabulary | **application logic** | ✅ **yes** |
| 5 | Reuse `finish-appointment` presenter, add collect + rebook | **application logic** | ✅ **yes** |
| 6 | Outcome **correction** (wrong outcome recorded) | **command/RPC** | ❌ **blocked by B4 / #534** |
| 7 | Per-visit **obligation** ("amount due") → real `outstanding` | **schema/data** | ❌ needs product decision first |
| 8 | Treatment cadence model | **schema/data + product** | ❌ explicit non-goal (§13) |
| 9 | Auto-resolution of stale `confirmed` | **command + product** | ❌ non-goal (§13) |
| 10 | Studio-level collected-revenue metric | **application logic** | ❌ belongs to practice-metrics, not here |

**Items 1–5 ship with zero schema change, zero migration, zero new write path.**
They are joins and pure functions over data Today already loads.

Item 6 is the only closeout to-do whose *action* is unavailable; §6.3 ships it
read-only rather than blocking the other four.

---

## 12. Proposed implementation sequence

Each phase is independently shippable and independently revertible.

**Phase 1 — projection (query + pure logic).** Extend
`lib/sessions/finish-appointment.ts`'s shape into a `resolveVisitCloseout()`
pure function covering all five dimensions plus `visit_closed`. Clock injected.
No I/O. Unit-tested against the deployed authorities in §2. Ships nothing to the
UI.

**Phase 2 — surface on the visit.** Render the checklist where the practitioner
already finishes a visit. Read-only; every action links to the existing governed
control.

**Phase 3 — to-do integration.** Add `Resolve outcome` and `Collect payment` to
the existing assistant, reusing `charting` and `follow_up` unchanged. Enforce
§6.2 no-duplication with a test that asserts one visit yields at most one item
per dimension.

**Phase 4 — historical honesty pass.** Prove `unknown` renders truthfully and
generates no to-do, using pre-0068 / pre-0073 fixtures.

**Phase 5 — after B4 merges and 0173 applies.** Wire `Resolve outcome`'s action
to the governed repair command. **Not before.**

**Ordering note:** phases 1–4 are safe while 0172 is pending, because they write
nothing. Nothing here should be sequenced against the 0172 apply.

---

## 13. Explicit non-goals

1. **No new appointment status.** Not `attended`, not `closed`, not `open`.
2. **No auto-resolution.** No cron flips an outcome. The disabled no-show cron
   stays disabled and `auto_mark_no_shows` stays force-off. Time is not evidence.
3. **No invented cadence.** No 90-day rule, no inferred return interval.
4. **No invented obligation.** No `outstanding = price − collected`.
5. **No revenue reporting.** Money words stay in practice-metrics (§2.7).
6. **No backfill or historical repair.**
7. **No clinical inference.** Closeout reports recorded state; it never
   evaluates treatment.
8. **No second to-do surface.** Extends the existing assistant.
9. **No dependency on unmerged B4.**
10. **No stored `visit_closed`.**
11. **This document starts no implementation and no B5.**

---

## 14. Acceptance criteria

A future implementation satisfies this contract when:

**Correctness**
1. `visit_closed` is true iff every dimension ∈ {`not_applicable`, `complete`}.
2. A past `confirmed` appointment is `unresolved`, never `no_show`.
3. A charted visit that was never marked complete shows chart `complete` **and**
   outcome `unresolved` — proving dimensions are independent.
4. A `no_show` visit has chart and postcare `not_applicable` and collect still live.
5. A saved card with no succeeded attempt is **never** `collect = complete`.
6. `collect = complete` requires a `succeeded` `payment_charge_attempts` row —
   asserted against a fixture where `appointment_payments.payment_status='method_saved'`.

**Historical honesty**
7. A pre-0068 session with no `appointment_id` does not render as uncharted-with-a-to-do.
8. A pre-0073 visit renders collect `unknown` and emits **no** to-do item.
9. No fixture produces `no_show`, attended, paid, closed, or rebooked from absent data.
10. No stored row is mutated by any read path (asserted, not assumed).

**To-do model**
11. One visit yields **at most one** item per dimension, and never an item for
    `unknown` or `not_applicable`.
12. Each item's disappearance rule is tested: satisfy the condition, item is gone.
13. Closeout emits no `aftercare`, `probe_lot`, `intake`, or caution/watch item.
14. Reuses the existing `charting` and `follow_up` rules rather than forking them —
    asserted by a test that a shared rule has exactly one implementation.

**Boundaries**
15. The projection performs zero writes and calls no RPC.
16. No new appointment status value; no `visit_closed` column.
17. Behaviour is identical before and after 0172 is applied.
18. No reference to B4 symbols, routes, or migration 0173.
19. Rebooking with no recorded intent is `not_applicable`, not `unresolved`.
20. No aggregate that could be read as revenue.

---

## Appendix — production baseline (read-only, 2026-08-09)

Captured during the B3 pre-push ceremony, at `ac3af84`, hosted migration max
0171. Scalars only.

| metric | value |
|---|---|
| appointments | 152 |
| confirmed | 70 |
| cancelled | 31 |
| completed | 47 |
| no_show | 4 |
| appointment_audit rows | 240 |
| policy acknowledgements | 13 |
| calendar reservations | 127 |

**70 of 152 appointments (46%) sit at `confirmed`.** Some are genuinely
upcoming; the remainder are the unresolved-outcome tail this contract exists to
surface. That distinction cannot be made from these scalars alone, and this
document deliberately does not guess at the split — establishing it is Phase 1
work, not a claim to be made here.
