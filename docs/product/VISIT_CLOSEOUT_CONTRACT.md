# Visit Closeout — product + engineering contract

**Status:** SPECIFICATION ONLY. No runtime code, no migration, no schema, no
production access. Nothing in this document has been built.

**Written against:** `a6b5e9e0c31837f172c3c89445aea0285c6cd523` (production head,
PR #540 / Dashboard V2 Part 2B merged).

**Reconciled:** originally written against `ac3af84` (post-#532/B3). Refreshed
onto current production after Part 1, Part 2A (#537), Part 2B (#540) and
**B4 (#534, now merged)** landed, and after **0172 and 0173 were both applied**.
The design is unchanged; the *truth claims* were re-verified line by line
against current source. Where the repository advanced past a claim, the claim
was corrected — not the design.

**Scope note on numbering:** this document proposes and reserves **no migration
number**. Current truth: repo max **0173**, hosted max **0173**, next free
**0174**, nothing pending — and **0174 is deliberately NOT claimed**. Another
security ticket may legitimately own it. Where schema or a governed command
would be required, this document states the dependency and stops.

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
surface asks "is this visit finished?", and **per-visit collection truth is
absent** — so a treated, charted, completed visit with nothing collected looks
identical to a finished one.

> **Corrected from the original draft.** It previously read *"money is absent
> from the to-do model entirely"*. After Part 2B that is no longer literally
> true: the canonical To-do model carries a **`payment_setup`** kind. But that is
> studio-level Stripe configuration, not visit collection — see §7.0, which makes
> the distinction explicit and testable. The gap is **per-visit collection
> truth**, not "all payment-related UI".

---

## 2. Current truth

Truth is stated at three different confidence levels throughout this document.
Conflating them is the most likely way this contract goes wrong.

| Tier | Meaning |
|---|---|
| **DEPLOYED** | In the production tree *and* the corresponding database state is applied. Safe to build on. |
| **MERGED, NOT APPLIED** | Code is in the production tree; the database half is not applied. **Must not be assumed at runtime.** *(As of this refresh, **no claim in this document sits in this tier** — 0172 and 0173 are both applied. The tier is retained because it is the failure mode this document exists to prevent.)* |
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
at `confirmed` forever if nobody pressed the button. See the historical snapshot
in the appendix — **not** a current count.

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

It **has no payment/collection dimension and no rebooking dimension.** That is
the hole.

> **Re-verified at `a6b5e9e0`: this file is byte-identical to the version the
> original contract was written against** (`git diff ac3af84 a6b5e9e0 --
> lib/sessions/finish-appointment.ts` is empty). It remains pure, clock-injected,
> owns no provider, holds no write authority, and still models exactly charting,
> aftercare, completion/outcome and postcare. The thesis survived four merged PRs
> untouched.
>
> **Therefore, stated explicitly:** `finish-appointment.ts` is Visit Closeout's
> **existing foundation, not a competing model.** Visit Closeout **extends and
> reuses** it — composing its four resolved dimensions and adding collection and
> rebooking. It does **not** introduce a second closeout state machine, and it
> does not re-derive charting, aftercare, completion or postcare independently.

Its self-description is also the governing principle for everything proposed
here: *"This module decides WHAT TO SHOW. It decides nothing about what is
ALLOWED."* Every state in this contract is a **presenter** state, re-derived
server-side before any write.

Note its postcare rule, which is the model for how this contract treats money:
**a claim is not a send.** `sent` requires a provider-confirmed `sent_at`;
attempts and claims do not count.

### 2.5a The CANONICAL To-do model — DEPLOYED (Part 2B) ✅

`lib/dashboard/todo-model.ts` (PR #540) is now **the** practitioner work queue.
Part 1 had put one "To do" heading over four independent products; Part 2B
normalizes them into one list:

```
domain facts  →  buildDashboardTodo() normalization / dedupe  →  one To-do list
```

It is **pure**: no client, no query, no clock (`todayLocal` is injected), no
model call. `DashboardTodoItem` carries `id`, `kind`, `subject`, `reason`,
`detail`, `action`, `priority`, `occurredAt`, `tone`.

**Eleven `TodoKind`s today:** `intake_review`, `no_services`, `payment_setup`,
`charting`, `aftercare`, `probe_lot`, `intake_incomplete`, `follow_up`,
`treatment_memory`, `records_details`, `supply_expiry`.

**Identity and dedupe — the law this contract must obey:**

- `DashboardTodoItem.id = ${kind}:${subject.id}` — *"Deterministic domain
  identity, never rendered text."*
- **`subject.id` is a client id** (or a supply id, or the literal `"studio"`).
  Assistant rows are keyed `${kind}:${item.clientId}`. There is **no per-visit
  subject granularity today** — a decisive fact for §9.
- One cross-kind rule exists (`treatment_memory` vs `follow_up`), and things
  deliberately *not* collapsed are enumerated in the module.
- `moreCount` preserves each domain's "showing N of M" so the list never
  pretends to be exhaustive.

**`TODO_PRIORITY` tiers** — deterministic, documented, no AI:

| tier | meaning | members |
|---|---|---|
| **10s** | BLOCKING | `intake_review` 10, `no_services` 11, `supply_expiry` (expired) 12 |
| **20s** | RECORD GAPS | `charting` 20, `aftercare` 21, `probe_lot` 22, `intake_incomplete` 23, `follow_up` 24 |
| **30s** | CONTEXT | `treatment_memory` 30, expiring-soon supply 31, `records_details` 32 |
| **40s** | SOFT SETUP NUDGES | `payment_setup` 40 |

Ties break by `occurredAt` **newest first**, then `id` ascending — a *total*
order, so the list is stable across renders.

The module states the product law this contract was independently written
around: *"completed work disappears, unfinished work comes back. Every item is
derived from live domain state on each render... Nothing is cached, snapshotted
or acknowledged away."*

### 2.5b The gap loaders behind it — DEPLOYED

`lib/dashboard/missing-records-assistant.ts` (PR #249) still supplies five of
those kinds, and is **unchanged** since the original contract was written
(verified by diff against `ac3af84`). Its five item types:

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

### 2.8 Appointment DML boundary — DEPLOYED ✅

**`0172` is applied** (2026-08-09T02:41:45Z). On `public.appointments` and
`public.appointment_audit`, `anon` and `authenticated` retain **SELECT only** and
are false on all seven of INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
Direct browser DML on appointments is **no longer reachable**.

> This corrects the original contract, which was written while 0172 was merged
> but pending and therefore had to reason about a runtime where direct DML was
> still technically possible. That caveat is now obsolete. The design needed no
> change, because it never wrote anything directly — which is exactly why it
> survived the transition unmodified.

### 2.9 B4 / governed appointment repair — DEPLOYED ✅

**`0173` is applied** (2026-08-09T12:06:47Z) and **PR #534 is merged**, so the
B4 application layer is live. Repo max = hosted max = **0173**; nothing pending.

Six SECURITY DEFINER functions, EXECUTE granted to `service_role` **only**
(PUBLIC / `anon` / `authenticated` all false):
`appointment_actor_role`, `lock_appointment_for_command`,
`appointment_has_blocking_dependents`, `write_appointment_audit`,
**`revert_appointment_outcome`**, **`set_appointment_notes`**.

Application surfaces: `AppointmentOutcomeRepair.tsx`, `AppointmentNotesEditor.tsx`,
`loadAppointmentRepairStateAction` → `AppointmentRepairState`
(`{ repairable: true } | { repairable: false; reason }`), and
`appointment-repair-contract.ts`, whose constants **mirror** 0173 and are pinned
against the SQL by `tests/app/calendar/appointment-repair-source.test.ts`. The
database is the authority; the constants only let the UI hint before a
round-trip.

Live gating on `revert_appointment_outcome`:

| gate | value |
|---|---|
| revertible statuses | `completed`, `no_show`, `cancelled` (`REVERTIBLE_STATUSES`) |
| actor | **studio owner only** |
| window | **72 hours** (`REPAIR_WINDOW_MS`), measured from the audit event that established the outcome (`BASELINE_ACTION`) |
| blocking dependents | `appointment_has_blocking_dependents` — same helper the UI and the command both call |
| reason | ≥ 10 chars after `btrim` (`MIN_REPAIR_REASON_LENGTH`) |
| concurrency | optimistic — refuses if the row moved |
| audit | written by the command |

**L23 is closed by authority boundary**: `anon`/`authenticated` hold no DELETE on
`public.services` or `public.practitioners`. Referential actions were
deliberately **not** altered — the browser's authority to trigger a parent
delete was removed instead.

> ⚠️ **A precision the original contract got wrong.** `revert_appointment_outcome`
> **reverts a terminal outcome back**; it does not set one. So B4 was never the
> path for an appointment that is *still* `confirmed` — that has always been
> `mark_appointment_complete` / `mark_appointment_no_show` (§2.2). B4 is the path
> for **correcting an outcome that was recorded wrongly**. The original document
> said "Resolve outcome must wait for B4", which conflated the two. Resolving an
> unresolved outcome never needed B4; only correcting one did, and that is now
> live. See §6.3.

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

### 6.0 The product law — one work queue

> **Unresolved Visit Closeout work that belongs on the dashboard MUST enter the
> canonical normalized To-do domain (`lib/dashboard/todo-model.ts`). There is no
> second practitioner work queue.**

Closeout therefore does **not** create: another To-do list, another Follow-up
assistant, another Action-needed card, or a closeout queue. Part 2B exists
precisely because four parallel surfaces asked for the same work more than once;
adding a fifth would re-create the defect Part 2B removed.

Concretely: closeout contributes **`TodoKind`s and `DashboardTodoItem`s** through
`buildDashboardTodo`, and **deduplicates on domain identity — never on rendered
text** (§2.5a).

Closeout feeds the existing gap loaders and the canonical model, extending the
item vocabulary. It does not create a competing widget.

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

### 6.3 Resolve outcome — both paths are now LIVE ✅

The original contract deferred this to B4. That deferral is resolved, and it was
also partly misdiagnosed (§2.9). There are **two different situations**, with two
different live commands:

| situation | meaning | governed path | actor |
|---|---|---|---|
| **unresolved** | still `confirmed` after `ends_at` — nobody ever said what happened | `mark_appointment_complete` / `mark_appointment_no_show` (§2.2) | practitioner |
| **wrong** | a terminal outcome was recorded incorrectly | **`revert_appointment_outcome`** via `AppointmentOutcomeRepair` (§2.9) | **owner only, ≤72h, no blocking dependents** |

Closeout **detects** the first and points at the existing calendar controls. For
the second it points at the **existing** repair surface and shows nothing more
than `loadAppointmentRepairStateAction` already reports.

**Binding constraints — do not re-derive any of these:**

1. **Do not invent another outcome-repair RPC**, and do not design a parallel
   appointment mutation path. `revert_appointment_outcome` and
   `set_appointment_notes` are the only governed writers, and both are
   `service_role`-EXECUTE only.
2. **Do not re-implement the gates.** Owner-only, the 72-hour window measured
   from `BASELINE_ACTION`, blocking dependents, the ≥10-char reason, optimistic
   concurrency and the audit row are all enforced by 0173. Closeout may *display*
   `AppointmentRepairState`; it must not compute its own verdict.
3. **Do not offer repair where the state says `repairable: false`.** Render the
   `reason` the action already returns.
4. Closeout **never** writes an appointment note; `set_appointment_notes` /
   `AppointmentNotesEditor` own that.

Because the constants in `appointment-repair-contract.ts` mirror 0173 and are
pinned by `appointment-repair-source.test.ts`, closeout should import them rather
than restate any number — a second copy of "72 hours" is exactly the drift that
test exists to prevent.

### 6.3b Visit Closeout is not Treatment Memory

Part 2A (#537) is live, and `treatment_memory` is a `TodoKind` at priority 30.
The two answer different questions and must not merge:

| | question |
|---|---|
| **Visit Closeout** | *Is this visit operationally finished?* |
| **Treatment Memory** | *What should the practitioner remember next time?* |

Closeout may **produce or update underlying facts** that Treatment Memory later
consumes — charting a visit creates the very record Treatment Memory reads — but
it must **not** create another memory model, another memory card, or a second
reading of clinical history. The existing #517 / Part 2A authority
(`lib/sessions/appointment-prep-memory.ts`, `last-treatment-loader.ts`,
`today-treatment-summary.ts`) stands unchanged.

Part 2B already encodes one overlap rule — `treatment_memory` vs `follow_up`,
where the strictly-more-informed row wins. Closeout inherits that rule; it does
not add competing ones.

### 6.4 The Part 2B integration contract

What follows is the **integration contract only** — not an implementation. Each
answer is labelled by how it was reached.

**FORCED** = Part 2B law already determines it.
**DECISION** = the repository does *not* force one answer; it must be chosen
deliberately at implementation time and is recorded here as open.

| question | answer | basis |
|---|---|---|
| Item shape | `DashboardTodoItem` via `buildDashboardTodo` | **FORCED** — §6.0 |
| Dedupe key | `${kind}:${subject.id}`, domain identity, never rendered text | **FORCED** |
| One consolidated item, or several? | **Several — one per unresolved dimension.** `charting`, `aftercare` and `probe_lot` are already distinct kinds for the same client; a consolidated "visit not closed" row would contradict the existing grammar and hide which gap is open | **FORCED** |
| Deep link | an existing, safe, studio-scoped route; outcome → the calendar appointment detail page (which already hosts the governed controls), charting → the existing charting route | **FORCED** — every existing item links to an existing route |
| Disappearance | immediately, because items are re-derived from live domain state on every render; nothing is cached, snapshotted or acknowledged away | **FORCED** |
| `occurredAt` | the visit's authoritative timestamp (`appointments.ends_at`) so ties break newest-first like every other row | **FORCED** by `compareTodoItems` |
| `tone` | `"normal"` — closeout gaps are record gaps, not the Needs-attention urgent tier | **FORCED** |
| Priority **tier** | **20s (RECORD GAPS)** — "a completed piece of work whose record is unfinished" describes closeout exactly | **FORCED** |
| Priority **numbers** | 20–24 are taken by the assistant's own reviewed 1→5 ordering, which §2.5a says is *"preserved rather than re-litigated"*. New closeout kinds need numbers that do not disturb it | ⚠️ **DECISION** |
| `subject.id` granularity | Every item today is keyed per **client**. A per-visit closeout item would introduce a **new subject granularity** Part 2B does not have | ⚠️ **DECISION — the important one** |

#### The subject-granularity decision, stated honestly

Today `charting:<clientId>` collapses to **one row per client** even when two of
that client's visits are uncharted. Visit Closeout is, by name, per **visit**.

Three options, none of which the repository settles:

1. **Keep client granularity.** Zero new concepts; one row per client per
   dimension, newest visit wins (matching the assistant's existing newest-first
   dedupe). Cost: a second unresolved visit is invisible until the first is
   cleared.
2. **Introduce visit granularity** (`subject.kind: "visit"`, id = appointment
   id). Truthful per-visit, and `moreCount` already exists to cap noise. Cost:
   a genuinely new subject kind, and a client with several open visits produces
   several rows.
3. **Hybrid** — client-granular for dimensions that are really about the client
   (rebooking), visit-granular for dimensions that are really about the visit
   (outcome, collection).

**This document does not choose.** Option 3 is the most defensible on the facts
above and is the recommendation, but it adds a subject kind, so it is a product
decision, not an implementation detail. Recording it as open is the point:
pretending Part 2B settles it would be inventing law.

#### What must not happen

- No new list, card, assistant or queue (§6.0).
- No dedupe on rendered text.
- No AI, no scoring, no model call in ordering — `TODO_PRIORITY` plus
  `compareTodoItems` is the whole algorithm.
- No item for an `unknown` or `not_applicable` dimension (§4.1).
- No re-emission of `aftercare`, `probe_lot`, `intake_incomplete` or
  `treatment_memory` (§6.2).

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

### 8.0 Two different things that both say "payment" ⚠️

This distinction is the single most important correction in the refresh, and it
must stay testable.

| | **A. PAYMENT SETUP** | **B. VISIT COLLECTION** |
|---|---|---|
| question | *Can this studio take money at all?* | *Did **this visit** actually get paid?* |
| scope | studio-wide, one row for the whole practice | one visit |
| authority | `TodoStudioSignals.paymentStatus` — `hasAccount`, `onboardingCompleted`, `payoutsEnabled` | a `succeeded` `payment_charge_attempts` row |
| in To-do today? | **YES** — `payment_setup`, priority **40** (soft setup nudge) | **NO — this is the gap** |
| subject | `payment_setup:studio` | would be per client/visit |
| urgency | never outranks real work | a specific visit's money is unresolved |

**Being connected to Stripe says nothing about whether a given visit was paid.**
A fully onboarded studio with payouts enabled — so `payment_setup` never fires —
can still have a completed visit with no successful charge. That visit is
exactly what Visit Closeout must surface and what nothing surfaces today.

**Testable form of the distinction:** a fixture with
`paymentStatus = { hasAccount: true, onboardingCompleted: true, payoutsEnabled: true }`
(so zero `payment_setup` items) **and** a completed visit with no `succeeded`
attempt **must still** produce an unresolved collect dimension. If it does not,
the two concepts have been conflated.

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
   practice-metrics — wording **re-verified unchanged** at `a6b5e9e0`. Closeout
   reports **per-visit resolution states only** and defines no new aggregate.
   Three words that must never be used interchangeably:
   **service value** (menu price) ≠ **money collected** (a `succeeded` attempt)
   ≠ **money owed** (which Hone does not model at all).
5. **Must not treat `payment_setup` as collection.** Clearing the studio setup
   nudge resolves nothing about any individual visit (§8.0).
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
| appointment status | `appointments.status` (CHECK, 0010) | `starts_at` / `ends_at` | `mark_appointment_complete` / `mark_appointment_no_show` (SECURITY DEFINER) | **No** — revoked by 0172, **applied** | **Yes** | ✅ |
| outcome *correction* | `appointments` + `appointment_audit` | the audit event named by `BASELINE_ACTION`, 72h window | **`revert_appointment_outcome`** (0173, `service_role` EXECUTE only) — owner-only, ≤72h, blocking-dependent checked, optimistic concurrency, audited | **No** | **Yes — LIVE** | ✅ |
| appointment notes | `appointments` | — | **`set_appointment_notes`** (0173) via `AppointmentNotesEditor` — **not** a closeout writer | **No** | **Yes — LIVE** | ✅ |
| dashboard To-do item | **derived** by `buildDashboardTodo` | `occurredAt` per domain | **nothing — pure, no writes** | n/a | n/a | ✅ |
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
| 6 | Outcome **correction** (wrong outcome recorded) | **already exists — B4 is LIVE** | ✅ **yes** — surface `AppointmentRepairState`, invent nothing |
| 7 | Per-visit **obligation** ("amount due") → real `outstanding` | **schema/data** | ❌ needs product decision first |
| 8 | Treatment cadence model | **schema/data + product** | ❌ explicit non-goal (§13) |
| 9 | Auto-resolution of stale `confirmed` | **command + product** | ❌ non-goal (§13) |
| 10 | Studio-level collected-revenue metric | **application logic** | ❌ belongs to practice-metrics, not here |
| 11 | New `TodoKind`s + priority numbers for closeout | **application logic** | ✅ yes — but see the §6.4 DECISION |
| 12 | Per-visit `subject` granularity in the To-do model | **application logic** (new subject kind) | ⚠️ open §6.4 DECISION — decide before Phase 3 |

**Items 1–6 now ship with zero schema change, zero migration, zero new write
path.** They are joins and pure functions over data the dashboard already loads,
plus a link to a governed control that already exists.

The original document's only blocked item (outcome correction) is **unblocked**:
B4 is live. Nothing in this contract is now gated on unmerged work.

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

**Phase 3 — canonical DashboardTodo integration.** Contribute closeout kinds
through `buildDashboardTodo`, reusing `charting` and `follow_up` unchanged.
**Requires the §6.4 subject-granularity decision first.** Enforce §6.0/§6.2 with
tests that assert no second queue and at most one item per (dimension, subject).

**Phase 4 — historical honesty / edge-case pass.** Unlinked sessions,
cancelled and no-show visits, failed postcare, cash and external payment where
representable, missing data, rebooking ambiguity, legacy rows. Prove `unknown`
renders truthfully and generates no to-do, using pre-0068 / pre-0073 fixtures.

**Phase 5 — minimum interaction with the LIVE governed B4 controls**, only if
still necessary after Phase 2. Display `AppointmentRepairState`; link to the
existing repair surface; write nothing.

**There is no schema phase.** The original document numbered one out of caution;
current data answers every question Phases 1–4 ask, so **Phases 1–4 are
migration-free**. If a later requirement genuinely needs data Hone does not
store — a per-visit obligation (§8.2), or treatment cadence (§9.2) — the correct
move is to **state the dependency**, not to invent storage now.

**Ordering note:** every phase writes nothing through a new path, so none of
this is sequenced against any migration.

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
11. **No claimed migration number.** 0174 is not reserved for Visit Closeout.
12. **No second work queue** — the canonical To-do model is the only one (§6.0).
13. **No second memory model** — Treatment Memory keeps its own authority (§6.3b).
14. **No parallel appointment mutation path** — B4's governed commands are the
    only writers (§6.3).
15. **This document starts no implementation and no B5.**

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
8b. The appendix snapshot is never presented as a current count, and no split of
    the `confirmed` population is asserted without source evidence.
9. No fixture produces `no_show`, attended, paid, closed, or rebooked from absent data.
10. No stored row is mutated by any read path (asserted, not assumed).

**To-do model**
11. One visit yields **at most one** item per dimension, and never an item for
    `unknown` or `not_applicable`.
12. Each item's disappearance rule is tested: satisfy the condition, item is gone.
13. Closeout emits no `aftercare`, `probe_lot`, `intake`, or caution/watch item.
14. Reuses the existing `charting` and `follow_up` rules rather than forking them —
    asserted by a test that a shared rule has exactly one implementation.

**Payment setup vs visit collection** (§8.0)
15. A studio with `hasAccount && onboardingCompleted && payoutsEnabled` produces
    **zero** `payment_setup` items **and** still reports an unresolved collect
    dimension for a completed visit with no `succeeded` attempt.
16. Clearing `payment_setup` changes **no** visit's collect state.

**Boundaries**
17. The projection performs zero writes and calls no RPC.
18. No new appointment status value; no `visit_closed` column.
19. Rebooking with no recorded intent is `not_applicable`, not `unresolved`.
20. No aggregate that could be read as revenue; service value, money collected
    and money owed are never used interchangeably.

**Canonical To-do integration** (§6.0, §6.4)
21. Closeout items are `DashboardTodoItem`s built through `buildDashboardTodo`.
    No second list, card, assistant or queue is introduced.
22. Dedupe is on `${kind}:${subject.id}` domain identity. A test asserts no
    dedupe path compares rendered text.
23. Ordering uses `TODO_PRIORITY` + `compareTodoItems` only — no scoring, no AI.
24. Closeout emits no `aftercare`, `probe_lot`, `intake_incomplete`,
    `treatment_memory` or caution/watch item.
25. The §6.4 subject-granularity decision is recorded before Phase 3 ships.

**B4 boundary** (§6.3)
26. Closeout defines no outcome-repair RPC and no appointment mutation path.
27. Repair gating is **displayed from** `loadAppointmentRepairStateAction`, never
    recomputed; the 72-hour window is imported from
    `appointment-repair-contract.ts`, never restated as a literal.
28. Where `repairable: false`, the returned `reason` is what renders.

**Treatment Memory boundary** (§6.3b)
29. Closeout creates no memory model or memory card and does not re-read clinical
    history for recall purposes.

---

## Appendix — HISTORICAL PRODUCTION SNAPSHOT (not current)

⚠️ **This is a historical record, not the current state of production.** It was
captured once, at a specific moment, and is retained because it motivated the
contract. **No production probe was run for this refresh** — none was authorized,
and none is needed to reconcile a document.

**Snapshot A — 2026-08-09, B3 pre-push ceremony**, at `ac3af84`, hosted
migration max 0171 (read-only, scalars only):

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

**Snapshot B — 2026-08-09T12:05:57Z / 12:09:30Z**, recorded in
`docs/production/migration-state.json` around the 0173 apply (quoted from the
repository, **not** re-probed): appointments **153** — 71 `confirmed`, 31
`cancelled`, 47 `completed`, 4 `no_show`; `appointment_audit` 241; policy
acknowledgements 13; calendar reservations 128. Identical before and after the
apply, which is how that ceremony proved zero business-data movement.

**At both snapshots, roughly 46% of appointments sat at `confirmed`.**

What that number does **not** tell us, and what this document deliberately does
not guess: how many were genuinely upcoming, how many were attended but never
resolved, how many were true no-shows, and how many were stale records. Those
splits are **not derivable from these scalars**, and no source evidence in the
repository establishes them. Determining the split is Phase 1 work against live
data — not a claim to be made in a specification.
