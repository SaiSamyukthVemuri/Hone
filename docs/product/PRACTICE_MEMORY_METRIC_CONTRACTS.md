# Practice Memory — metric contracts

> **Status: SPECIFICATION ONLY.** This document defines metrics. It ships no
> analytics, no Dashboard card, no migration, no view, no cron and no query.
> Nothing here has been run against production data. Every claim below is a
> claim about *source code and schema in this repository*, cited by path and
> line, not a claim about what any studio's numbers currently are.

> **Source baseline — read before implementing any definition.**
> The source-truth census in §1, and every path:line citation in this document,
> was performed against commit
> **`b14d1d5895ed88e539727f9348cedf4465da9e5a`**.
>
> Appointment-boundary work landing after that commit — in particular the B3 /
> B4 DML-boundary migrations, which were unmerged at the time of writing — can
> change grants, write paths and the set of functions permitted to mutate
> `appointments`. **Revalidate an individual definition against the then-current
> head before implementing it**, specifically its *Source tables / functions*
> and *Computable today* fields.
>
> This document has deliberately **not** been updated speculatively for
> unmerged work. Schema citations to applied migrations are stable (an applied
> migration is frozen); application-code citations may drift and should be
> re-grepped rather than trusted verbatim.

**Scope of the exercise.** Hone is about to build Rebooking Intelligence,
Practice Health, Book Health, Financials, Cancellation Recovery, Retention and
Capacity Intelligence. Before any of that is built, each number needs a
definition that survives one question:

> **"Exactly how did Hone calculate this?"**

This document is that set of definitions. Where the honest answer is *"Hone
cannot calculate this yet"*, the definition says so and names what is missing
rather than substituting a heuristic that looks plausible on a card.

**The reuse rule.** The Dashboard / Practice Health layer reuses the
authoritative scheduling, appointment, treatment and payment truth that already
exists. It never introduces a second capacity calculator, a second buffer rule,
a second "what is a completed treatment" rule or a second week boundary. Where
today's authority cannot answer an aggregate question cheaply, that is recorded
in [§12 Engineering requirements](#12-engineering-requirements) as work to be
done — not routed around.

---

## Table of contents

- [Executive registry — all 43 metrics](#executive-registry--all-43-metrics)
- [Engineering dependency groups](#engineering-dependency-groups)
- [Product-truth follow-ups](#product-truth-follow-ups)
- [0. How to read this document](#0-how-to-read-this-document)
- [1. Source-truth census](#1-source-truth-census)
- [2. Cross-cutting conventions](#2-cross-cutting-conventions)
- [3. Metric registry](#3-metric-registry)
- [4. Rebooking contracts](#4-rebooking-contracts)
- [5. Capacity contracts](#5-capacity-contracts)
- [6. Financial contracts](#6-financial-contracts)
- [7. Cancellation-recovery contracts](#7-cancellation-recovery-contracts)
- [8. Retention contracts](#8-retention-contracts)
- [9. Reconciliation with the shipped Dashboard V1](#9-reconciliation-with-the-shipped-dashboard-v1)
- [10. Review sweep](#10-review-sweep)
- [11. The five most important ambiguities](#11-the-five-most-important-ambiguities)
- [12. Engineering requirements](#12-engineering-requirements)

---

## Executive registry — all 43 metrics

One row per metric, for planning. The full 20-field contract for each lives in
§4–§8; §3 carries the caveat-oriented view of the same set. Where this table and
a §4–§8 contract disagree, **the contract wins** — this is a summary.

Status shorthand: **NOW** = correct implementation already ships ·
**QUERY** = COMPUTABLE WITH DEFINED QUERY · **BLOCKED** = BLOCKED BY MISSING
DATA · **SUBSYSTEM** = FUTURE SUBSYSTEM REQUIRED.

"Blocks on" lists the §12 requirement IDs that gate a *defensible* version of
the metric. A **QUERY** metric with a blocking ID is computable today but
carries the limitation that ID names — it can ship with the caveat disclosed;
a **BLOCKED** or **SUBSYSTEM** metric cannot ship at all until its ID is closed.

| # | Metric | Category | Status | Authoritative source | Blocks on | First surface expected to consume it |
|---|---|---|---|---|---|---|
| 1 | Eligible for rebooking | Rebooking | QUERY | `appointments` + `sessions` / `session_blocks`, `clients.archived_at` | — | Rebooking Intelligence |
| 2 | Rebooked | Rebooking | QUERY | `appointments` future `confirmed` rows | — | Rebooking Intelligence |
| 3 | Needs rebooking | Rebooking | QUERY | `appointments`, `clients` | R2 | Rebooking Intelligence |
| 4 | Due soon | Rebooking | QUERY | `treatment_plan_stages.how_often_unit` (`0034:56`), else visit history | R1 | Rebooking Intelligence |
| 5 | Overdue | Rebooking | QUERY | as Due soon | R1, R3 | Rebooking Intelligence |
| 6 | Lapsed | Rebooking | QUERY | as Due soon | R1 | Rebooking Intelligence |
| 7 | Recurring client | Rebooking | QUERY | `appointments`, `treatment_plans` | R4 | Retention |
| 8 | Expected return interval | Rebooking | QUERY | `treatment_plan_stages` (`0034:28-47`) | **R1** | Rebooking Intelligence |
| 9 | Expected return window | Rebooking | QUERY | derived from §4.8 | R1 | Rebooking Intelligence |
| 10 | Rebooking rate | Rebooking | QUERY | `appointments` + lineage (`0171:221,234`) | — | Practice Health |
| 11 | Scheduled business hour | Capacity | QUERY | `studio_availability_default` / `_overrides` | C2 | Capacity Intelligence |
| 12 | Bookable hour | Capacity | QUERY | above − `studio_blockouts`, break occurrences, `studio_timed_blocks` | C2 | Capacity Intelligence |
| 13 | Truly available hour | Capacity | **SUBSYSTEM** | `getAvailableSlots` (`lib/booking/slots.ts:216`) | **C1** | Book Health |
| 14 | Booked hour | Capacity | QUERY | `appointments` + `blocked_ends_at` (`0029:92`) | — | Capacity Intelligence |
| 15 | Treatment hour | Capacity | QUERY | `appointments.duration_minutes` | — | Practice Health |
| 16 | Completed treatment hour | Capacity | QUERY | `appointments.status='completed'` | — | Practice Health |
| 17 | Open capacity | Capacity | **SUBSYSTEM** | would be §5.3 | **C1** | Book Health |
| 18 | Calendar utilization | Capacity | QUERY | §5.4 ÷ §5.2 | C2 | Practice Health |
| 19 | Treatment utilization | Capacity | QUERY | §5.5 ÷ §5.2 | C2 | Practice Health |
| 20 | Realized utilization | Capacity | QUERY | §5.6 ÷ §5.2 | C2 | Practice Health |
| 21 | Forward booking depth | Capacity | QUERY | §5.4 ÷ §5.2 across four windows | C2 | Book Health |
| 22 | Completed service value | Financial | QUERY | `appointments` ⋈ `services.price_cents` (`0010:149`) | F4 | Financials |
| 23 | Collectible completed value | Financial | **BLOCKED** | none — no card/authorization history | **F1** | Financials |
| 24 | Collected revenue | Financial | QUERY | `payment_charge_attempts.charged_at` (`0073:166`) | — | Financials |
| 25 | Refunded amount | Financial | QUERY | `refund_amount_cents`, `refunded_at` (`0078:48-56`) | F2 | Financials |
| 26 | Net collected revenue | Financial | QUERY | §6.3 − §6.4, each in its own period | F2 | Financials |
| 27 | Outstanding payment | Financial | **BLOCKED** | none — no invoice / balance concept | **F3** | Financials |
| 28 | Collection capture | Financial | **BLOCKED** | denominator is §6.2 | **F1** | Financials |
| 29 | Payment resolution rate | Financial | QUERY | `payment_charge_attempts.status` (`0073:121-130`) | — | Financials |
| 30 | Cancelled appointment | Cancellation | QUERY | `appointments.cancelled_at`, `cancellation_kind` (`0125:51-52`) | X3 | Practice Health |
| 31 | Released capacity | Cancellation | QUERY | cancelled rows ∩ Bookable hour | X1 | Cancellation Recovery |
| 32 | Cancelled slot | Cancellation | QUERY | §7.2 + lead time | X1 | Cancellation Recovery |
| 33 | Refill candidate | Cancellation | **SUBSYSTEM** | none exists | **X2** | Cancellation Recovery |
| 34 | Refilled slot | Cancellation | **SUBSYSTEM** | none exists | **X2** | Cancellation Recovery |
| 35 | Recovered capacity | Cancellation | **SUBSYSTEM** | denominator only | **X1, X2** | Cancellation Recovery |
| 36 | Recovered revenue | Cancellation | **SUBSYSTEM** | none exists | **X2, F4** | Cancellation Recovery |
| 37 | Unrecovered capacity | Cancellation | **SUBSYSTEM** | complement of §7.6 | **X2** | Cancellation Recovery |
| 38 | Active returning client | Retention | QUERY | `appointments`, `clients.archived_at` (`0050:22`) | R5 | Retention |
| 39 | Second-visit conversion | Retention | QUERY | `appointments` per client, cohort-closed | R4 | Retention |
| 40 | Returning-client rate | Retention | QUERY | `appointments` | R5 | Retention |
| 41 | Overdue client | Retention | QUERY | §4.5 | R1, R3 | Retention |
| 42 | Lapsed client | Retention | QUERY | §4.6 | R1 | Retention |
| 43 | Retention window / cohort | Retention | QUERY | `appointments`, first qualifying visit | R4 | Retention |

**Totals — 0 NOW · 33 QUERY · 3 BLOCKED · 7 SUBSYSTEM.**

By category: Rebooking 10 · Capacity 11 · Financial 8 · Cancellation 8 ·
Retention 6.

By first surface: Rebooking Intelligence 8 · Financials 8 · Retention 7 ·
Practice Health 7 · Cancellation Recovery 7 · Capacity Intelligence 3 ·
Book Health 3.

Practice Health is deliberately **not** a category of its own: it consumes the
rate-shaped metrics from three categories (#10, #15, #16, #18–#20, #30). Any
Practice Health build therefore spans the Rebooking, Capacity and Cancellation
contracts and must adopt all three sets of conventions from §2.

**Read this alongside the [Source baseline](#practice-memory--metric-contracts)
notice.** The *Authoritative source* column is the field most exposed to
appointment-boundary changes landing after the baseline commit.

---

## Engineering dependency groups

The 14 requirements in §12 are not 14 independent projects. They cluster into
five product dependencies, and each cluster unlocks a coherent slice of the
registry. This is the sequencing view.

| Group | Requirements | What it establishes | Metrics it unblocks or de-caveats |
|---|---|---|---|
| **D1 — Appointment outcome truth** | **X3** | Whether a past appointment happened, and whether a practitioner move is product-equivalent to a client reschedule | #30, and the trustworthiness of #16, #20 |
| **D2 — Historical value / pricing truth** | **F1, F2, F3, F4** | That a money figure is a historical fact rather than a restatement of today's menu, and that every real-world money state is representable | #22, #23, #25, #26, #27, #28, #36 |
| **D3 — Rebooking / cadence state** | **R1, R2, R3, R4, R5** | Which cadence a client is on, when they are legitimately finished or paused, and who is one client | #3–#9, #38–#43 |
| **D4 — Aggregate scheduling / capacity truth** | **C1, C2** | An aggregate, duration-aware availability answer built on the existing engine, and a stable capacity denominator | #11–#13, #17–#21 |
| **D5 — Cancellation-recovery attribution** | **X1, X2** | A recorded release event and a causal link from a freed slot to the booking that filled it | #31–#37 |

**D1 carries a gap that no requirement ID closes.** The core problem — that
`completed` means *charted* rather than *attended*, and that `no_show` is
manual-only — is resolved in this document by **product posture, not new data**:
§2.8 makes past `confirmed` rows a visible **Unresolved** bucket rather than
guessing. If Hone later wants an attendance fact independent of charting, that
is a new requirement and should be added to §12 as **D1's second item**.

**Suggested order, on dependency depth rather than appetite:**

1. **D3** — five requirements, all additive, and it unlocks 16 of the 43 metrics
   (the whole Rebooking + Retention surface). R1 alone gates six.
2. **D2** — F4 (price snapshot) is small and stops financial history moving
   under the studio; F1/F3 are larger product decisions.
3. **D4** — C1 is the largest single piece of engineering in this document, and
   the one most at risk of being solved by building a second capacity
   calculator. C2 may be answerable by a product statement rather than code.
4. **D1** — mostly a product decision about reschedule equivalence.
5. **D5** — a genuinely new subsystem. Nothing in §7 beyond #31/#32 is
   reportable until it exists, and shipping a partial version is worse than
   shipping nothing (§7.6, §7.8).

---

## Product-truth follow-ups

Two defects in **currently shipping** product truth were found while writing
these contracts. They are recorded here as **product-correctness follow-ups**.

**Neither is a reason to build analytics now.** They are pre-existing bugs in
numbers Hone already renders; they should be fixed on their own merits, on their
own schedule, independently of any Practice Memory work. No code was changed by
this document.

### PT-1 — "Late cancellations" cannot represent the cancellation model

`lib/dashboard/practice-metrics.ts:106` classifies a late cancellation by
testing `cancellation_reason === "late_cancellation"`.

That comparison cannot be satisfied by the shipped cancellation model.
`appointments.cancellation_reason` receives a **human label** — `"Schedule
changed"`, `"Booked by mistake"`, … from `lib/booking/cancellation-reasons.ts:32-40`
— while the stable machine value is written to `appointment_audit.details.reason`.
The practitioner-side cancel RPC writes an arbitrary operator string
(`0033:197,295`). No shipped writer produces the token `"late_cancellation"`.

Two further points make this worth recording rather than merely noting:

- **Lateness is not modelled at all.** Even with the right column, "late" is a
  lead-time judgement (`starts_at − cancelled_at`) against a policy window, and
  no such window is stored. The stat's *name* describes a concept the data model
  does not have.
- **It is invisible to CI.** The only other occurrence of the token in the
  repository is `tests/app/dashboard/practice-dashboard.test.ts:80`, which
  constructs the string as test input. The unit test pins the *function* and
  passes; the *pipeline* has no producer. A green suite is not evidence here.

A correct version reads `appointment_audit.details.reason` and applies an
explicit lead-time rule. Contract: §7.1. Reconciliation: §9.

### PT-2 — Payment reporting uses attempt-creation time

`lib/dashboard/practice-metrics.ts:260-266` scopes the Payments card by
`created_at` — when a practitioner *prepared* a charge.

`created_at` is not a financial event. Hone has authoritative financial-event
timestamps and they are not being used for this card:

| Reported figure | Uses today | Should use |
|---|---|---|
| Payments charged | `created_at` | **`charged_at`** (`0073:166`) |
| Refunds | `created_at` of the original charge | **`refunded_at`** (`0078:50`) |

Consequences on shipped output: a charge prepared 31 May and collected 2 June is
reported in **May**; a refund issued in June against a May charge is reported in
**May** and never appears in June at all.

Two things the current implementation gets **right** and which any fix must
preserve: the `stripe_livemode` filter at `:264` (without it 0105's mode-scoped
uniqueness lets one real payment be counted twice), and the card's careful
labelling of service value as *not* collected revenue
(`app/(app)/dashboard/practice-snapshot.tsx:109-112`).

Note that `created_at` **is** the correct authority for one metric — Payment
resolution rate (§6.8) — because that measures a cohort of attempts rather than
money. The rule is in §6.0. Contracts: §6.3, §6.4. Reconciliation: §9.

---

## 0. How to read this document

### 0.1 The twenty fields

Every term in §4–§8 is defined against the same twenty fields. Nothing is left
to the reader's inference; where a field genuinely does not apply, it says
**n/a** and why.

| # | Field | What it settles |
|---|---|---|
| 1 | Product meaning | The sentence a practitioner would accept as the definition |
| 2 | Eligibility set | Which rows are even candidates before any filter |
| 3 | Numerator | For rates only |
| 4 | Denominator | For rates only |
| 5 | Time authority | The single column whose value decides which period a fact lands in |
| 6 | Studio timezone treatment | How the UTC instant becomes a studio civil date |
| 7 | Included states | The statuses/flags that count |
| 8 | Excluded states | The statuses/flags that must not count, named explicitly |
| 9 | Cancellation behaviour | What a cancelled appointment does to this number |
| 10 | Reschedule behaviour | What each of Hone's **two structurally different** reschedule paths does |
| 11 | No-show behaviour | What a `no_show` row does, and what an unmarked no-show does |
| 12 | Refund behaviour | Where relevant |
| 13 | Historical corrections | What happens when a past row is edited after the fact |
| 14 | Multi-practitioner scope | Per-practitioner vs studio aggregation, and whether they sum |
| 15 | Multi-studio scope | Tenancy boundary |
| 16 | Source tables / functions | Exact, with path:line |
| 17 | Computable today | One of the four registry statuses |
| 18 | Known limitation | The thing that would embarrass us if a customer found it first |
| 19 | Example | A concrete worked case |
| 20 | Anti-example | The plausible-looking calculation that is **wrong**, and why |

### 0.2 Status vocabulary

| Status | Meaning |
|---|---|
| **COMPUTABLE NOW** | A correct implementation already ships. Reading the number requires no new work. |
| **COMPUTABLE WITH DEFINED QUERY** | Every fact exists and is reliably written. A query must be written; no schema change, no new subsystem. |
| **BLOCKED BY MISSING DATA** | A specific fact does not exist in the data model. Named in §12. A migration or a new write path unblocks it. |
| **FUTURE SUBSYSTEM REQUIRED** | No amount of querying existing rows produces a defensible answer. A behavioural subsystem must exist first. |

**Zero of the 43 terms are COMPUTABLE NOW.** That is a deliberate finding, not
an oversight — see [§9](#9-reconciliation-with-the-shipped-dashboard-v1), where
the numbers the Dashboard renders today are reconciled against these
definitions and three are shown to be wrong.

### 0.3 What "authoritative" means here

A source is authoritative for a fact when it is the *only* writer of that fact,
or when every writer routes through it. Where two authorities disagree — and
[§2.6](#26-the-two-buffer-authorities) documents one place where they do — the
metric contract names which one it uses and why, rather than averaging them.

---

## 1. Source-truth census

This is the inventory the metric contracts are built on. It redesigns nothing.
Its job is to establish what exists, what it means, and — repeatedly the more
important half — **what does not exist**.

### 1.1 Appointments

`public.appointments`, created at `supabase/migrations/0010_booking_v1.sql:174`.

| Column | Type | Semantics |
|---|---|---|
| `studio_id` | uuid NOT NULL | Tenancy. `on delete cascade`. |
| `practitioner_id` | uuid NULL | `on delete set null` (`0010:177`). **Mutable** — the move command rewrites it (`0143:181`). |
| `client_id` | uuid NOT NULL | `on delete cascade`. |
| `service_id` | uuid NULL | `on delete set null` (`0010:179`). See the hazard in §1.2. |
| `starts_at` | timestamptz NOT NULL | Start instant. |
| `ends_at` | timestamptz NOT NULL | **Service end. No buffer.** Recomputed as `starts_at + duration_minutes` on move (`0143:171`). |
| `duration_minutes` | integer NOT NULL | Snapshotted at booking. CHECK 5..480 (`0010:200-202`). |
| `status` | text NOT NULL | CHECK `in ('confirmed','cancelled','completed','no_show')`, default `'confirmed'` (`0010:183`). Never widened since. |
| `notes` | text NULL | Free text. |
| `cancellation_reason` | text NULL | **Free text, no CHECK.** Receives a human *label*, not a machine token — see §1.7. |
| `cancelled_at` | timestamptz NULL | Real cancellation timestamp. |
| `cancelled_by` | text NULL | CHECK `in ('client','practitioner','owner')` (`0010:187`). |
| `created_at` / `updated_at` | timestamptz NOT NULL | Row lifecycle. |
| `buffer_minutes_snapshot` | integer **NOT NULL** | Added `0029_double_booking_constraint.sql:44`, backfilled, then set NOT NULL (`0029:172`). Frozen from `studios.buffer_minutes` by trigger at insert (`0029:91`). CHECK `>= 0`. |
| `blocked_ends_at` | timestamptz **NOT NULL** | `ends_at + buffer_minutes_snapshot` (`0029:92`), NOT NULL at `0029:173`, CHECK `>= ends_at` (`0029:193-194`), plus an **exact-equality invariant** rejecting any row where the pair disagrees (`0029:211`). |
| `rescheduled_from_appointment_id` | uuid NULL | Successor → predecessor. Written only by `reschedule_appointment_v2` (`0171:221`). |
| `rescheduled_to_appointment_id` | uuid NULL | Predecessor → successor (`0171:234`). |
| `cancellation_kind` | text NULL | CHECK `in ('rescheduled','withdrawn')` (`0125:51-52`). Nullable; legacy paths leave it null. |

Range constraint `ends_at > starts_at` (`0010:194-196`).

**Four statuses, and what each actually proves.**

| Status | Written by | What it proves | What it does *not* prove |
|---|---|---|---|
| `confirmed` | Default on insert | A booking exists | Nothing about attendance. A past `confirmed` row is **ambiguous**. |
| `completed` | `mark_appointment_complete()`, called from the *charting* entry point `app/(app)/clients/[id]/sessions/new/actions.ts:49` | A practitioner started a clinical record for it | Not an independent attendance record — it is a **side effect of charting** |
| `cancelled` | The cancel RPCs (§1.7) | The booking was withdrawn or superseded | Which of the two, unless `cancellation_kind` is set |
| `no_show` | `mark_appointment_no_show()` (migration 0033), **manual only** | A practitioner explicitly marked it | Absence of `no_show` proves nothing — see below |

**The single most consequential fact in this census.** There is no automated
transition of a past appointment out of `confirmed`.
`app/api/cron/no-show-check/route.ts` is deliberately **non-mutating**; its
header records why the previous heuristic (`starts_at + 30min`) was withdrawn,
and `studios.auto_mark_no_shows` is force-set to `false` at
`app/(app)/settings/studio/actions.ts:129`.

Therefore a past appointment still in `confirmed` is one of:

1. attended and charted late (so not yet `completed`);
2. attended and never charted;
3. a no-show nobody marked;
4. a cancellation taken by phone and never entered.

**Nothing in the data distinguishes these four.** Every attendance-shaped
metric in this document inherits that ambiguity, and each one states how it
handles it.

### 1.2 Services, price and duration

`public.services`, `0010_booking_v1.sql:143-153`.

| Column | Semantics |
|---|---|
| `default_duration_minutes` | integer NOT NULL default 60, CHECK 5..480 (`0010:157-159`) |
| `price_cents` | integer **NULL**, CHECK `>= 0` when present (`0010:162-165`) |
| `active` | boolean NOT NULL default true |

Two hazards, both load-bearing for Financials:

- **There is no price snapshot on the appointment.** `appointments` snapshots
  `duration_minutes` but not price. Any value figure must join live to
  `services.price_cents`. Editing a service price therefore **rewrites reported
  history**.
- **`appointments.service_id` is `on delete set null`** (`0010:179`). Deleting a
  service silently detaches every historical appointment from its price, taking
  their contribution to zero, with no audit trail on the appointment row.

`price_cents` being nullable means a service can be bookable with no price at
all; such appointments contribute nothing to value and must be *counted and
disclosed*, never silently treated as $0.

### 1.3 Treatment / session truth

| Table | Created | Notes |
|---|---|---|
| `public.sessions` | `0001_init.sql:78` | `started_at` NOT NULL default now(), `ended_at` **nullable**, `practitioner_id` NOT NULL `on delete restrict`, `next_session_note` (see §1.8), `deleted_at` (soft delete) |
| `public.session_blocks` | `0001_init.sql:94` | One row per treated area. `minutes_performed` added `0009_session_modality_and_params.sql:18`. Soft-deletable. |
| `sessions.appointment_id` | `0068_sessions_appointment_link.sql:53` | **Nullable.** Added late; sessions predating it, and freeform sessions, carry null. |

So: a session may exist with no appointment, and an appointment may exist with
no session. "Treatment happened" and "an appointment was booked" are separate
facts joined by an optional pointer.

`ended_at` being nullable means **session wall-clock duration is not reliably
available**. The durable evidence of delivered work is `session_blocks`
existence and `minutes_performed`, not `ended_at - started_at`.

The one shipped metric that already encodes a treatment-completion rule is
`chartedWithin24h` (`lib/dashboard/practice-metrics.ts:159-200`): it treats
"charted" as *at least one non-deleted `session_block` on a non-deleted session
linked to the appointment*. This document adopts that same rule wherever
"treatment was performed" is needed, so the two cannot drift.

### 1.4 Scheduling and capacity authority

The scheduling truth is layered. Every layer is a real table; none of it is
inferred.

| Layer | Table / function | Shape |
|---|---|---|
| Weekly window | `studio_availability_default` | `(studio_id, day_of_week, is_open, open_time, close_time, practitioner_id NULL)` |
| Date override | `studio_availability_overrides` | `(studio_id, effective_date, …, practitioner_id NULL)` — wins over weekly |
| Closure | `studio_blockouts` | `(starts_on, ends_on)` — **whole local days only** (`0010:130-137`) |
| Recurring break | `studio_recurring_break_rules` | `days_of_week integer[]`, `start_local_time`, `end_local_time`, `active`, label ∈ `lunch/break/admin/other` (`0031_recurring_breaks.sql:82-93`); materialised into `studio_recurring_break_occurrences` |
| One-off block | `studio_timed_blocks` | Timed or all-day (migration 0061) |
| Collision authority | `studio_calendar_reservations` | Trigger-maintained shadow with a per-resource **GiST exclusion** (0134). Post-0152 it stores the **actual** treatment interval with **no** buffer. |
| Window validator | `public.validate_appointment_availability` | `0146_authoritative_duration_and_availability_validator.sql:43-161` |
| Slot generator | `getAvailableSlots` | `lib/booking/slots.ts:216-553` |

Four facts about this layer that any capacity metric must respect:

1. **The validator is per-appointment, not aggregate.** It answers "may *this*
   interval be booked", and when `studios.practitioner_capacity_enabled` is
   false it returns `'ok'` immediately (`0146:81-83`) — under today's flag state
   there is no per-practitioner availability dimension at all.
   `practitioner_capacity_enabled` is `not null default false` (`0134:55`).

2. **The slot generator is per-day and per-duration.** `getAvailableSlots` takes
   one `dateStr` and one `serviceDurationMinutes`. There is no range form and no
   service-agnostic form.

3. **Slots are anchors, not a grid.** Candidate starts come from the opening
   edge, each reservation boundary (forward and backward), an optional closing
   edge, and a coarse hourly fallback (`slots.ts:387-455`). The *count* of
   offered slots is a property of the packing algorithm. It is not a capacity
   measurement and must never be summed as one.

4. **Buffer is allowed to spill past closing time.** The fit test is on the
   **service end** (`slots.ts:466-467`), and the database agrees
   (`0146:149` tests `v_end_time > v_close`). A day's last appointment may have
   its buffer extend beyond `close_time`.

The *inputs* to capacity are range-loadable even though the composition is not:
`getOverridesForRange`, `getTimedBlocksForRange`,
`getRecurringBreakOccurrencesForRange`, `getAppointmentsForRange`,
`getBlockouts` all exist in `lib/booking/queries.ts`. This asymmetry is exactly
what makes §5's ladder possible — and exactly why the top rung of that ladder is
`FUTURE SUBSYSTEM REQUIRED`.

### 1.5 Studio settings

`studios.timezone` — text, backfilled to `'America/Toronto'` (`0010:20,29`).
`studios.buffer_minutes` — integer default 15, CHECK 0..240 (`0010:22,47-48`).
`studios.default_appointment_duration_minutes`. `studios.practitioner_capacity_enabled`
— boolean not null default false (`0134:55`).

**There is no minimum-lead-time column and no maximum-booking-horizon column.**
Forward-looking windows in §5 are therefore reporting windows chosen by this
document, not enforcement windows the product already has.

### 1.6 Payments

`public.payment_charge_attempts`, `0073_payment_charge_attempts.sql:54`.

| Column | Semantics |
|---|---|
| `charge_reason` | CHECK `in ('session_payment','late_cancellation_fee','no_show_fee')` (`0073:69-74`) |
| `session_id` | FK, `on delete set null`; required for `session_payment` |
| `appointment_id` | Required for the two fee reasons, **optional** for `session_payment` (`0073:76-94`) |
| `amount_cents` | integer NOT NULL, CHECK `> 0 and <= 200000` (`0073:111-112`) |
| `currency` | CHECK `in ('cad')` (`0073:113-114`) — single-currency by constraint |
| `status` | CHECK `in ('ready','blocked','cancelled','pending_stripe','succeeded','failed')` (`0073:121-130`) |
| `stripe_livemode` | boolean not null default false (`0073:152`) |
| `created_at` | **Attempt creation.** Not a money event. |
| `charged_at` | **Successful collection.** Written by the app clock at `lib/billing/session-payment-charge.ts:344`. |
| `failed_at`, `cancelled_at` | Terminal non-collection timestamps |
| `refund_status` | CHECK `in ('pending_stripe','succeeded','failed')` or null (`0078:79-82`) |
| `refund_amount_cents` | CHECK `> 0 and <= amount_cents` (`0078:88-96`) — partial-refund-ready; v1 helper writes the full amount only |
| `refunded_at` | Refund timestamp (`0078:50`) |

**Hone has a genuine collection timestamp and a genuine refund timestamp.** This
is better than the typical case and it is what makes most of §6 computable.
`charged_at` is Hone's clock at the moment Stripe returned success, not Stripe's
own event timestamp — close enough to be authoritative for period attribution,
and stated here so nobody later assumes it is Stripe's.

Two scoping facts:

- Migration 0101 dropped the `stripe_livemode = false` CHECK, and 0105 permits
  one active test attempt **and** one active live attempt per slot. Money
  queries **must** filter `stripe_livemode`, or a single real-world payment can
  be counted twice. `lib/dashboard/practice-metrics.ts:254-266` already does.
- Payment requires a card on file with a *current* authorization signature, and
  the session must be linked to a `completed` appointment
  (`lib/billing/session-payment-eligibility.ts:33-38`). **Cash, e-transfer and
  any off-platform payment are not representable anywhere in the schema.**

### 1.7 Cancellation and the two reschedule models

`cancellation_reason` receives the **human label** from
`lib/booking/cancellation-reasons.ts` (e.g. `"Schedule changed"`); the stable
machine value is written to `appointment_audit.details.reason`. The
practitioner-side cancel RPC writes an arbitrary operator string
(`0033:197,295`). So `cancellation_reason` is a free-text snapshot and **not a
categorical field**. Reason analysis must read `appointment_audit.details.reason`.

Hone reschedules in **two structurally different ways**:

| Path | Mechanism | Evidence produced |
|---|---|---|
| **Public / client-initiated** — `reschedule_appointment_v2` (0171) | Cancels the original, inserts a successor | `status='cancelled'` + `cancelled_at` + `cancellation_kind='rescheduled'` + **both** lineage pointers + two audit rows |
| **Practitioner move** — `move_or_reassign_appointment` (0143) | **Mutates `starts_at` / `ends_at` / `practitioner_id` in place** (`0143:178-183`) | One `appointment_audit` row, action `moved` / `reassigned` / `moved_and_reassigned`, `details` carrying `previous_starts_at`, `previous_ends_at`, `previous_practitioner_id` (`0143:185-198`) |

Consequences that every contract in §7 must honour:

- A practitioner move produces **no cancellation at all** and **no second row**.
  Counting "reschedules" as cancellations with `cancellation_kind='rescheduled'`
  misses every practitioner-side move.
- A public reschedule produces **two rows**. Counting both as appointments
  double-counts demand.
- `0171:19-45` records that the **legacy** reschedule RPC set neither lineage
  column nor `cancellation_kind`. Historical rescheduled cancellations are
  therefore indistinguishable from genuine withdrawals.
- Because a move rewrites `starts_at` in place, **the original booked time is
  recoverable only from the audit `details` jsonb**, and only for moves made
  through the 0143 command.
- Because a move rewrites `practitioner_id`, per-practitioner attribution of a
  *past* appointment reflects the current assignment, not who actually treated
  the client. `sessions.practitioner_id` (NOT NULL, `on delete restrict`) is the
  better attribution source for delivered treatment.

`public.appointment_audit` (`0010:217-225`) is `(appointment_id, actor_type,
actor_id, action, details jsonb, created_at)` — **it carries no `studio_id`**,
so any audit-based aggregate must join through `appointments`.

### 1.8 Rebooking and retention evidence

This is where the census is most important, because the tempting answer is wrong.

| Candidate evidence | What it actually is | Usable as a return interval? |
|---|---|---|
| `sessions.next_session_note` | **Free text.** Written via the `set_next_session_note` RPC from the next-visit note form (`app/(app)/clients/[id]/sessions/[sessionId]/actions.ts:633-639`). Rendered as "From last visit". | **No.** It is prose. Parsing it would be inference, which V1 excludes by design. |
| `client_pinned_notes`, `client_personal_notes` | Free text | No |
| `treatment_plans` | `suggested_visit_count`, `status`, `closed_at` (`0024:9-20`) — a **count**, no cadence | No |
| **`treatment_plan_stages`** | `how_often_unit` CHECK `in ('weekly','every_2_weeks','monthly')` (`0034:56`), plus `stage_length_value` + `stage_length_unit ∈ ('weeks','months')` (`0034:62`) and `visit_length_minutes` | **Yes — this is the one structured cadence Hone has.** |
| A future appointment | `appointments` row with `starts_at > now` | Yes, as *evidence the client is already rebooked* |
| The client's own history | Gaps between successive `starts_at` values | Yes, as an empirical fallback |

`treatment_plan_stages` is genuinely written by shipped UI — create, edit and
delete actions all exist (`app/(app)/clients/[id]/treatment-plans-actions.ts:674,
752,785`). It is the one piece of deterministic, non-inferred cadence evidence
Hone has, and [§4.8](#48-expected-return-interval) builds the rebooking ladder
on it.

**But the stage table has no anchor date.** There is no `starts_on` and no
`started_at`; a plan has `created_at` and `closed_at` only. Mapping "which stage
is this client in today" therefore requires a derivation rule, which is
specified as an engineering requirement in **§12-R1** and consumed by §4.8.

Other retention facts:

- `clients` (`0001_init.sql`) has `created_at`, and `archived_at` / `archived_by`
  from `0050_clients_archive.sql:22,29`. Archival is a soft delete; the active
  list filters `archived_at IS NULL`.
- **`clients.email` is not unique.** Two rows can be the same human. Retention
  math is per client *row*, and duplicates inflate "new clients" and deflate
  "returning".
- There is no `primary_practitioner_id` on `clients`. Practitioner-level
  retention must be derived from appointments or sessions.
- `imported_treatment_memories` (`0089:88-114`) carries `occurred_on date`
  (nullable) — **pre-Hone visit history**. A client's first row in
  `appointments` is frequently *not* their first visit ever.

### 1.9 What does not exist

Named plainly, because their absence is what makes §7 mostly uncomputable:

- **No waitlist of clients wanting a slot.** `supabase/migrations/0004_waitlist.sql`
  is the **marketing landing-page signup** — `(email, practice_name, source
  'landing')`, for prospective *studios*. It has nothing to do with appointments.
  A search for `waitlist|wait_list|slot_offer|slot_hold|refill` across
  `supabase/`, `app/`, `lib/` and `components/` returns that table, plus
  unrelated matches on the word "block". There is no slot-offer table, no hold,
  no claim, no notify-me.
- **No released-capacity record.** A cancellation deletes its
  `studio_calendar_reservations` shadow row (`0171:100-102`); nothing records
  that a specific window became free.
- **No attendance fact independent of charting.**
- **No price snapshot on appointments.**
- **No off-platform payment record.**
- **No lead-time or booking-horizon setting.**
- **No structured next-visit interval outside `treatment_plan_stages`.**

---

## 2. Cross-cutting conventions

Every contract in §4–§8 inherits these. Where a contract deviates, it says so.

### 2.1 Studio timezone is the only civil authority

All timestamps are `timestamptz` (UTC instants). A "day", "week" or "month" is a
**studio-local civil interval**, resolved with `studios.timezone`.

The authoritative converters are in `lib/booking/tz.ts`:

- `utcInstantFromLocal(localDate, localTime, tz)` (`tz.ts:42-68`) — civil → instant.
- `localDateString(d, tz)` (`tz.ts:71`) and `todayInTz(tz)` (`tz.ts:256`) — instant → civil date.

`utcInstantFromLocal` handles DST with a documented two-pass correction
(`tz.ts:47-67`): ambiguous fall-back times resolve to the **first**,
pre-transition occurrence; nonexistent spring-forward times map to the instant
one hour before the wall-clock string. Metrics adopt these conventions rather
than re-deriving them.

**A metric must never use the server's local timezone, and never `UTC` as a
stand-in for the studio.** Every period boundary is
`utcInstantFromLocal(civilDate, "00:00", studio.timezone)`.

**DST days are 23 or 25 hours long.** Hour-denominated capacity metrics measure
**elapsed time**, so on the spring-forward day a 09:00–17:00 window is 7 hours,
not 8. This is correct and must not be "fixed" — a practitioner genuinely cannot
treat during an hour that does not exist.

### 2.2 Half-open intervals, everywhere

Every range is `[start, end)`. A period is
`[utcInstantFromLocal(startCivil,"00:00",tz), utcInstantFromLocal(endCivilExclusive,"00:00",tz))`.
An appointment at exactly the period's end instant belongs to the **next**
period. This matches the shipped `resolvePeriodRange`
(`lib/dashboard/practice-metrics.ts:27-57`) and the reservation overlap rule
(`slots.ts:470-472`, "touching is allowed").

### 2.3 Boundary-spanning appointments

An appointment can start before a period and end inside it.

| Metric family | Rule |
|---|---|
| **Counts** (appointments, cancellations, no-shows) | Attributed **whole** to the period containing the time-authority instant. Never split. |
| **Hours** (capacity, utilization) | **Clipped** to the period: contribution is `max(0, min(ends_at, periodEnd) − max(starts_at, periodStart))`. |
| **Money** | Attributed **whole** to the period containing the money timestamp (`charged_at` / `refunded_at`), never the appointment date. |

Counts and hours therefore deliberately disagree at a boundary, and that is
correct: one appointment is one appointment, but its *hours* belong to the days
they physically occupy. Any surface showing both must not imply
`hours = count × duration`.

### 2.4 Week and month boundaries

**Weeks start Monday** for all metrics in this document, matching
`resolvePeriodRange` (`lib/dashboard/practice-metrics.ts:38-49`).

⚠️ **This conflicts with `startOfWeek()` in `lib/booking/tz.ts:249-255`, which
returns the Sunday on or before the date.** Two week definitions coexist in the
codebase today. Metrics pin Monday, and §11 records this as an ambiguity the
product must settle, because a "this week" metric that disagrees with the
calendar the practitioner is looking at is worse than no metric.

Months are civil calendar months in studio time.

### 2.5 Tenancy and aggregation

Every metric is scoped to exactly one `studio_id`. **No metric aggregates across
studios**; there is no cross-studio surface and no cross-studio consumer.

Practitioner-level breakdowns:

- **Booked / scheduled facts** attribute to `appointments.practitioner_id`,
  which is nullable and mutable (§1.7).
- **Delivered-treatment facts** attribute to `sessions.practitioner_id`, which
  is NOT NULL and is not rewritten by the move command.
- Appointments with `practitioner_id IS NULL` are reported in an explicit
  **Unassigned** bucket, never silently dropped and never distributed.
- **Per-practitioner rows sum to the studio total only for counts and money.**
  They do **not** sum for capacity hours while
  `practitioner_capacity_enabled = false`, because in that state there is only
  one studio-wide window (`0146:81-83`) — dividing it among practitioners would
  invent capacity that the scheduler does not model.

### 2.6 The two buffer authorities

Buffer time is protected but **not bookable and not treatment**. Two sources
exist and they can disagree:

- `appointments.buffer_minutes_snapshot` / `blocked_ends_at` — frozen at insert
  from `studios.buffer_minutes` (`0029:44,119-120`).
- The **current** `studios.buffer_minutes`, which `getAvailableSlots` re-applies
  to appointment reservations at read time (`slots.ts:375-378`), because
  post-0152 the shadow row stores the actual interval with no buffer.

**Metric contracts use `buffer_minutes_snapshot` / `blocked_ends_at`** — the
value in force when the appointment was booked. Historical hours must not move
when the studio changes its buffer setting.

This is safe to rely on without a null branch: 0029 backfilled both columns, set
them **NOT NULL** (`0029:172-173`), and added an **exact-equality invariant**
requiring `blocked_ends_at = ends_at + buffer_minutes_snapshot` on every row
(`0029:211`), with the trigger as sole writer. Booked hour (§5.4) can therefore
use `[starts_at, blocked_ends_at)` directly rather than recomputing the sum.

### 2.7 Historical corrections

Hone permits real retroactive edits. Every contract states its behaviour, but
the house rule is:

**Metrics are recomputed from current row state on every read. They are
point-in-time restatements, not immutable ledgers.** No metric is snapshotted,
so a number shown last month may legitimately differ today.

The four edits that move history:

| Edit | Effect |
|---|---|
| Service price change | Rewrites every past value figure for that service (§1.2) |
| Service deletion | Nulls `service_id` on historical appointments; their value silently drops to zero |
| Practitioner reassignment of a past appointment | Moves that appointment between practitioner buckets |
| Client archival | Removes the client from active-population denominators (each contract states whether history is retained) |

A financial surface **must** display an "as calculated on `<timestamp>`" stamp.

### 2.8 The attendance-ambiguity rule

Given §1.1, every metric that needs "did this happen" picks exactly one of three
postures and **names it**:

- **Charting-anchored** — treats `completed` (or the presence of session blocks)
  as the positive fact. Undercounts by every attended-but-uncharted visit.
- **Booking-anchored** — treats a non-cancelled row as the positive fact.
  Overcounts by every unmarked no-show.
- **Explicit-outcome-only** — counts only `completed` and `no_show`, and reports
  past `confirmed` rows as a visible **Unresolved** bucket.

**Practice Health surfaces use explicit-outcome-only**, because the Unresolved
count is itself the most actionable number Hone can show a studio: it is the
size of the studio's own record-keeping gap.

---

## 3. Metric registry

43 terms. **0 COMPUTABLE NOW · 33 COMPUTABLE WITH DEFINED QUERY · 3 BLOCKED BY
MISSING DATA · 7 FUTURE SUBSYSTEM REQUIRED.**

| Metric | Status | Authoritative source | Main caveat |
|---|---|---|---|
| **REBOOKING** | | | |
| Eligible for rebooking | COMPUTABLE WITH DEFINED QUERY | `appointments`, `sessions`, `clients.archived_at` | Attendance ambiguity (§2.8) decides who counts as "has had a visit" |
| Rebooked | COMPUTABLE WITH DEFINED QUERY | `appointments` future rows | A public reschedule's successor counts once; the cancelled predecessor never does |
| Needs rebooking | COMPUTABLE WITH DEFINED QUERY | `appointments`, `clients` | Says nothing about urgency — that is Due soon / Overdue |
| Due soon | COMPUTABLE WITH DEFINED QUERY | `treatment_plan_stages.how_often_unit` or client history | Only clients with a plan stage or ≥3 visits get a defensible interval |
| Overdue | COMPUTABLE WITH DEFINED QUERY | Same as Due soon | Undefined for clients with no interval evidence — must render as "No expected interval", not "Overdue" |
| Lapsed | COMPUTABLE WITH DEFINED QUERY | Same as Due soon | **No universal 90-day rule.** Multiple of the client's own interval |
| Recurring client | COMPUTABLE WITH DEFINED QUERY | `appointments` | Pre-Hone history in `imported_treatment_memories` is excluded by default |
| Expected return interval | COMPUTABLE WITH DEFINED QUERY | `treatment_plan_stages` (`0034:56`), else client history | **Stages carry no anchor date** — stage selection needs the §12-R1 rule |
| Expected return window | COMPUTABLE WITH DEFINED QUERY | Derived from the interval | Tolerance band is a product choice, not a data fact |
| Rebooking rate | COMPUTABLE WITH DEFINED QUERY | `appointments` | Denominator must be *visits*, not clients, or frequent clients dominate |
| **CAPACITY** | | | |
| Scheduled business hour | COMPUTABLE WITH DEFINED QUERY | `studio_availability_default` / `_overrides` | One open/close pair per date only (`slots.ts:438-444`) |
| Bookable hour | COMPUTABLE WITH DEFINED QUERY | Above minus `studio_blockouts`, `studio_timed_blocks`, recurring breaks | Blockouts are whole-day only |
| Truly available hour | **FUTURE SUBSYSTEM REQUIRED** | `getAvailableSlots` (`slots.ts:216`) | Per-day, per-duration only; slot counts are a packing artifact, not capacity |
| Booked hour | COMPUTABLE WITH DEFINED QUERY | `appointments` + `buffer_minutes_snapshot` | Buffer is protected, not bookable, and may spill past close |
| Treatment hour | COMPUTABLE WITH DEFINED QUERY | `appointments.duration_minutes` | Scheduled duration, not delivered duration |
| Completed treatment hour | COMPUTABLE WITH DEFINED QUERY | `appointments` `status='completed'` | Charting-anchored — undercounts uncharted visits |
| Open capacity | **FUTURE SUBSYSTEM REQUIRED** | Would need Truly available hour | Coarse `Bookable − Booked` is defined but must never be labelled "open capacity" |
| Calendar utilization | COMPUTABLE WITH DEFINED QUERY | Booked hour ÷ Bookable hour | Includes buffer in the numerator by design |
| Treatment utilization | COMPUTABLE WITH DEFINED QUERY | Treatment hour ÷ Bookable hour | Excludes buffer; always ≤ calendar utilization |
| Realized utilization | COMPUTABLE WITH DEFINED QUERY | Completed treatment hour ÷ Bookable hour | Backward-looking only; meaningless for future periods |
| Forward booking depth | COMPUTABLE WITH DEFINED QUERY | `appointments` future rows vs Bookable hour | No booking-horizon setting exists, so far windows are thin by construction |
| **FINANCIAL** | | | |
| Completed service value | COMPUTABLE WITH DEFINED QUERY | `appointments` ⋈ `services.price_cents` | **Live join — a price edit rewrites history**; deleting a service zeroes it |
| Collectible completed value | **BLOCKED BY MISSING DATA** | — | No card-on-file/authorization history; cannot say what *was* collectible then |
| Collected revenue | COMPUTABLE WITH DEFINED QUERY | `payment_charge_attempts.charged_at` | Must filter `stripe_livemode`; excludes all off-platform payment |
| Refunded amount | COMPUTABLE WITH DEFINED QUERY | `refund_amount_cents`, `refunded_at` | Lands in the **refund's** period, not the charge's |
| Net collected revenue | COMPUTABLE WITH DEFINED QUERY | Above two | Can go negative in a period; must be allowed to render negative |
| Outstanding payment | **BLOCKED BY MISSING DATA** | — | No invoice/balance concept; "unpaid" and "paid in cash" are identical in the schema |
| Collection capture | **BLOCKED BY MISSING DATA** | — | Denominator is Collectible completed value |
| Payment resolution rate | COMPUTABLE WITH DEFINED QUERY | `payment_charge_attempts.status` | About attempt hygiene, not revenue |
| **CANCELLATION RECOVERY** | | | |
| Cancelled appointment | COMPUTABLE WITH DEFINED QUERY | `status='cancelled'`, `cancelled_at` | Must exclude `cancellation_kind='rescheduled'`, and legacy rows lack it |
| Released capacity | COMPUTABLE WITH DEFINED QUERY | Cancelled rows' intervals | Derived at read time; nothing is recorded at release |
| Cancelled slot | COMPUTABLE WITH DEFINED QUERY | Released capacity with lead time | Not a bookable-slot guarantee |
| Refill candidate | **FUTURE SUBSYSTEM REQUIRED** | — | No waitlist, no offer, no notify-me exists |
| Refilled slot | **FUTURE SUBSYSTEM REQUIRED** | — | No causal link between a release and a later booking |
| Recovered capacity | **FUTURE SUBSYSTEM REQUIRED** | — | **NOT COMPUTABLE YET** — proximity is not causation |
| Recovered revenue | **FUTURE SUBSYSTEM REQUIRED** | — | **NOT COMPUTABLE YET** |
| Unrecovered capacity | **FUTURE SUBSYSTEM REQUIRED** | — | Complement of an uncomputable quantity |
| **RETENTION** | | | |
| Active returning client | COMPUTABLE WITH DEFINED QUERY | `appointments`, `clients.archived_at` | Duplicate client rows inflate the population |
| Second-visit conversion | COMPUTABLE WITH DEFINED QUERY | `appointments` per client | Cohort must be closed — exclude clients whose window has not elapsed |
| Returning-client rate | COMPUTABLE WITH DEFINED QUERY | `appointments` | Denominator is clients seen in the window, not all clients |
| Overdue client | COMPUTABLE WITH DEFINED QUERY | Rebooking § Overdue | Client-level restatement of the appointment-level term |
| Lapsed client | COMPUTABLE WITH DEFINED QUERY | Rebooking § Lapsed | Archived clients are excluded, not counted as lapsed |
| Retention window / cohort | COMPUTABLE WITH DEFINED QUERY | `appointments`, `clients.created_at` | `imported_treatment_memories.occurred_on` means "first Hone visit" ≠ "first visit" |

---

## 4. Rebooking contracts

### 4.0 The rebooking model

Hone does **not** adopt a universal "90 days = lapsed" rule. No such contract
exists in the product, and inventing one would make every client of a
weekly-cadence studio look healthy and every client of a quarterly-cadence
studio look lost.

Instead, V1 uses a **three-tier evidence ladder**, deterministic and
inspectable, with no inference:

| Tier | Evidence | Interval |
|---|---|---|
| **1 — Plan** | An active `treatment_plans` row (`status='active'`, `closed_at IS NULL`) with at least one `treatment_plan_stages` row | `how_often_unit` → `weekly` = 7d, `every_2_weeks` = 14d, `monthly` = 30d (`0034:56`) |
| **2 — History** | ≥ 3 qualifying past visits | Median gap between consecutive visit dates |
| **3 — None** | Neither | **No interval.** The client is reported as *No expected interval* and is **never** Due soon, Overdue or Lapsed |

A client with an explicit future appointment is **Rebooked** and exits the
funnel regardless of tier.

**The five states are mutually exclusive** and are evaluated against
`todayInTz(studio.timezone)`:

```
                        has a future non-cancelled appointment?
                        ├── yes ──────────────────────────────► REBOOKED
                        └── no  ──► NEEDS REBOOKING, and exactly one of:
                                      today <  windowStart          → Not yet due
                                      windowStart ≤ today ≤ windowEnd → DUE SOON
                                      windowEnd < today ≤ lapseAt    → OVERDUE
                                      today > lapseAt                → LAPSED
                                    (or: no interval                 → No expected interval)
```

This is the separation the brief requires: **Needs rebooking is the superset.**
A client can need a future booking and be *Not yet due* — that is the normal,
healthy state right after a visit.

Three shared derived quantities, defined once:

- **`lastVisit`** — the studio-local civil date of the client's most recent
  qualifying visit (see §4.1 for "qualifying").
- **`windowStart` / `windowEnd`** — [§4.9](#49-expected-return-window).
- **`lapseAt`** — `lastVisit + (LAPSE_MULTIPLE × interval)` days, with
  `LAPSE_MULTIPLE = 3`. **This is a product constant, not a data fact**, and it
  is declared here so it appears in exactly one place.

---

### 4.1 Eligible for rebooking

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | A client who has actually been treated at least once and could reasonably return |
| 2 | Eligibility set | `clients` rows in the studio with `archived_at IS NULL`, having ≥ 1 **qualifying visit** |
| 3 | Numerator | n/a — a set, not a rate |
| 4 | Denominator | n/a |
| 5 | Time authority | `appointments.starts_at` of the qualifying visit |
| 6 | Timezone | `starts_at` → studio-local civil date via `localDateString` |
| 7 | Included states | **Qualifying visit** = an appointment with `starts_at < now` and `status = 'completed'`; **or** `status IN ('confirmed','completed')` with ≥ 1 non-deleted `session_block` on a non-deleted linked `session` |
| 8 | Excluded states | `cancelled`; `no_show`; future appointments; archived clients; clients whose only history is `imported_treatment_memories` |
| 9 | Cancellation | A cancelled appointment is never a qualifying visit; a client whose only booking was cancelled is **not** eligible |
| 10 | Reschedule | Public reschedule: only the successor can qualify. Practitioner move: one row, qualifies at its current `starts_at` |
| 11 | No-show | `no_show` never qualifies. An **unmarked** no-show still sitting at `confirmed` qualifies **only if it has session blocks** — which it will not — so the charting requirement is what protects this set |
| 12 | Refund | n/a |
| 13 | Historical corrections | Deleting a session's blocks can retroactively de-qualify a visit. Un-archiving a client re-admits them |
| 14 | Multi-practitioner | Studio-level set. Per-practitioner variants attribute by `sessions.practitioner_id` (§2.5) |
| 15 | Multi-studio | Single studio; a client row belongs to one studio |
| 16 | Sources | `appointments` (`0010:174`), `sessions` (`0001:78`, `appointment_id` `0068:53`), `session_blocks` (`0001:94`), `clients.archived_at` (`0050:22`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Deliberately charting-anchored (§2.8), so an attended-but-uncharted client is invisible to the whole rebooking funnel. This is the safer error: it under-nags rather than chasing clients who were never treated |
| 19 | Example | Client seen 2026-06-02, appointment `completed`, three session blocks. Not archived. **Eligible.** |
| 20 | Anti-example | *"Every client row is eligible."* Wrong: it sweeps in prospects who booked and cancelled, duplicate rows, and intake-only records, inflating every rebooking denominator and making the rate look artificially bad |

---

### 4.2 Rebooked

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | This client already has their next visit on the calendar |
| 2 | Eligibility set | §4.1 eligible clients |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `appointments.starts_at` of the future appointment |
| 6 | Timezone | "Future" means `starts_at > now` as an instant; day labels render studio-local |
| 7 | Included states | ≥ 1 appointment with `starts_at > now` and `status = 'confirmed'` |
| 8 | Excluded states | `cancelled`, `completed`, `no_show`; past appointments |
| 9 | Cancellation | Cancelling the future appointment removes Rebooked **immediately**; the client re-enters Needs rebooking on the next read |
| 10 | Reschedule | Public reschedule: predecessor is `cancelled`, successor is `confirmed` — **exactly one** future row survives, so no double count. Practitioner move: same row, new time — still one |
| 11 | No-show | n/a (future) |
| 12 | Refund | n/a |
| 13 | Historical corrections | State is always current; nothing is snapshotted |
| 14 | Multi-practitioner | Attribute the future appointment by its `practitioner_id`; **Unassigned** bucket for null |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, lineage columns (`0171:221,234`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Says nothing about *appropriateness*. A client on a weekly plan booked 6 months out is Rebooked and looks healthy |
| 19 | Example | Client seen 2026-06-02; has a `confirmed` appointment on 2026-06-16. **Rebooked.** |
| 20 | Anti-example | *"Count every future row per client."* A public reschedule briefly produces a cancelled predecessor **and** a confirmed successor; counting rows rather than clients, without the status filter, double-counts the client |

---

### 4.3 Needs rebooking

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Treated before, nothing on the books. **Not a judgement about lateness.** |
| 2 | Eligibility set | §4.1 eligible clients |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Absence of any `starts_at > now` confirmed row |
| 6 | Timezone | Evaluated against `now`; displayed dates studio-local |
| 7 | Included states | Eligible **and not** Rebooked (§4.2) |
| 8 | Excluded states | Archived clients; clients with any future `confirmed` appointment |
| 9 | Cancellation | A cancellation is what most commonly *moves* a client into this set |
| 10 | Reschedule | Public reschedule leaves a confirmed successor → **not** in this set. Practitioner move → **not** in this set |
| 11 | No-show | A no-show client with no future booking **is** in this set. Whether to contact them is a product/clinical decision, not a metric one |
| 12 | Refund | n/a |
| 13 | Historical corrections | Recomputed per read |
| 14 | Multi-practitioner | Attribute by the practitioner of the **last** visit (`sessions.practitioner_id`) |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `clients` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Contains clients who finished their treatment plan and correctly need nothing. `treatment_plans.status='completed'` / `closed_at` should suppress them, and §12-R2 records that this suppression needs a product rule |
| 19 | Example | Seen 2026-06-02, no future booking, plan interval 14 days. Today 2026-06-05 → **Needs rebooking, Not yet due.** |
| 20 | Anti-example | *"Needs rebooking = Overdue."* Conflating them turns a routine post-visit state into an alarm and destroys trust in the Overdue number |

---

### 4.4 Due soon

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | The client's expected return window is open now — this is the right week to reach out |
| 2 | Eligibility set | Needs rebooking (§4.3) **with** an expected return interval (Tier 1 or 2) |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `lastVisit` (civil date) + the interval |
| 6 | Timezone | All arithmetic on studio-local civil dates, `todayInTz(tz)` as today |
| 7 | Included states | `windowStart ≤ today ≤ windowEnd` (§4.9) |
| 8 | Excluded states | Rebooked; Tier-3 (no interval) clients; archived clients; `today > windowEnd` (Overdue/Lapsed) |
| 9 | Cancellation | Cancelling a future booking can drop a client straight into Due soon or Overdue depending on how much time has passed |
| 10 | Reschedule | Only the surviving confirmed row matters. Neither path affects `lastVisit` |
| 11 | No-show | A no-show does **not** reset `lastVisit` — the client was not treated. They stay measured from their last real visit, which is correct |
| 12 | Refund | n/a |
| 13 | Historical corrections | Editing a plan stage's `how_often_unit` changes the interval and can move clients between states immediately |
| 14 | Multi-practitioner | By last-visit practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `treatment_plan_stages` (`0034:28-47`), `treatment_plans` (`0024:9-20`), `appointments` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Tier-1 stage selection needs the anchor rule in §12-R1, because `treatment_plan_stages` stores **no start date** |
| 19 | Example | Weekly stage, `lastVisit` 2026-06-02 → interval 7d, window 2026-06-07..2026-06-11. Today 2026-06-09 → **Due soon.** |
| 20 | Anti-example | *"Due soon = last visit more than 3 weeks ago."* A fixed threshold labels a monthly client "due" before their cadence and a weekly client "due" two cadences late |

---

### 4.5 Overdue

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | The expected return window has closed and the client still has nothing booked |
| 2 | Eligibility set | Needs rebooking with an interval |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `lastVisit` + interval + tolerance |
| 6 | Timezone | Studio-local civil dates |
| 7 | Included states | `windowEnd < today ≤ lapseAt` |
| 8 | Excluded states | Tier-3 clients — they render **"No expected interval"**, never "Overdue"; Lapsed; Rebooked; archived |
| 9 | Cancellation | Same as §4.4 |
| 10 | Reschedule | Same as §4.4 |
| 11 | No-show | Does not reset `lastVisit`; a client who no-showed their only follow-up becomes Overdue relative to their last **treated** visit |
| 12 | Refund | n/a |
| 13 | Historical corrections | Interval edits move clients between Due soon / Overdue / Lapsed instantly |
| 14 | Multi-practitioner | By last-visit practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | As §4.4 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Cannot see a client who told the practitioner "I'll call in the autumn". There is no structured *pause* or *snooze* — §12-R3 |
| 19 | Example | Weekly stage, `lastVisit` 2026-06-02, window closes 2026-06-11, `lapseAt` = 2026-06-23. Today 2026-06-16 → **Overdue.** |
| 20 | Anti-example | *"Overdue = no visit in 90 days."* For a weekly-cadence client that is twelve missed visits reported as one late one; for a quarterly client it is a false alarm on schedule |

---

### 4.6 Lapsed

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | So far past their own cadence that they should be treated as a re-engagement, not a reminder |
| 2 | Eligibility set | Needs rebooking with an interval |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `lastVisit` + `LAPSE_MULTIPLE × interval` |
| 6 | Timezone | Studio-local civil dates |
| 7 | Included states | `today > lapseAt` |
| 8 | Excluded states | Tier-3 clients; archived clients (**archived ≠ lapsed** — archiving is a deliberate act and removes the client from this population entirely) |
| 9 | Cancellation | Same as §4.4 |
| 10 | Reschedule | Same as §4.4 |
| 11 | No-show | Same as §4.5 |
| 12 | Refund | n/a |
| 13 | Historical corrections | As §4.5 |
| 14 | Multi-practitioner | By last-visit practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | As §4.4 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | `LAPSE_MULTIPLE = 3` is a product constant with no evidential basis in the data. It is declared once (§4.0) so it can be changed in one place and its effect explained |
| 19 | Example | Monthly stage (30d), `lastVisit` 2026-02-10 → `lapseAt` 2026-05-11. Today 2026-06-01 → **Lapsed.** |
| 20 | Anti-example | *"Lapsed = archived."* Archived is a practitioner's explicit filing decision; lapsed is a fact about elapsed time. Merging them hides real attrition behind housekeeping |

---

### 4.7 Recurring client

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Someone with an established pattern of returning — not a one-off |
| 2 | Eligibility set | §4.1 eligible clients |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `appointments.starts_at` of qualifying visits |
| 6 | Timezone | Civil dates, studio-local |
| 7 | Included states | ≥ 3 qualifying visits (§4.1) **or** an active `treatment_plans` row with ≥ 1 stage |
| 8 | Excluded states | Clients with 1–2 visits and no plan; archived clients |
| 9 | Cancellation | Cancelled appointments never count toward the 3 |
| 10 | Reschedule | Public reschedule yields one qualifying visit, not two. Practitioner move yields one |
| 11 | No-show | Not a visit |
| 12 | Refund | n/a |
| 13 | Historical corrections | Deleting session blocks can drop a client below the threshold |
| 14 | Multi-practitioner | Studio-level; a client seen by two practitioners is one recurring client, counted once |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `treatment_plans`, `treatment_plan_stages` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | `imported_treatment_memories.occurred_on` (`0089:114`) holds pre-Hone visits. A long-standing client migrated into Hone looks brand new. Excluded by default and disclosed; §12-R4 |
| 19 | Example | Visits 2026-03-04, 2026-04-01, 2026-05-06, all `completed`. **Recurring** (three visits) |
| 20 | Anti-example | *"Recurring = has ≥ 2 appointments."* Two appointments is one return, which is a coin flip, not a pattern — and it counts a client whose second appointment is a not-yet-attended future booking |

---

### 4.8 Expected return interval

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | How long, in days, Hone expects until this client's next visit |
| 2 | Eligibility set | §4.1 eligible clients |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Tier 1: `treatment_plan_stages.how_often_unit`. Tier 2: gaps between successive qualifying `starts_at` civil dates |
| 6 | Timezone | Gaps measured in **civil days** in studio time, so a DST transition never adds or removes a day |
| 7 | Included states | **Tier 1** (preferred): active plan (`status='active'`, `closed_at IS NULL`) with ≥ 1 stage → `weekly`=7, `every_2_weeks`=14, `monthly`=30. **Tier 2**: ≥ 3 qualifying visits → **median** of consecutive gaps |
| 8 | Excluded states | Closed/cancelled plans; gaps that span an archival period; **fewer than 3 visits → no interval** (2 visits give exactly 1 gap, which is noise) |
| 9 | Cancellation | Cancelled appointments are not visits and create no gaps |
| 10 | Reschedule | Both paths yield one visit at its final time. A move therefore *legitimately* changes a historical gap |
| 11 | No-show | Not a visit; a no-show between two visits produces one long gap rather than two short ones. Correct — the client genuinely did not attend |
| 12 | Refund | n/a |
| 13 | Historical corrections | Editing `how_often_unit` changes the interval for every downstream state at once |
| 14 | Multi-practitioner | Client-level; a client has one interval regardless of who treats them |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `treatment_plan_stages.how_often_unit` CHECK (`0034:56`); `treatment_plans` (`0024:9-20`); `appointments` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **`treatment_plan_stages` has no anchor date.** With multiple stages (`sort_order`, `stage_length_value`, `stage_length_unit`) there is no stored fact saying which stage the client is in. §12-R1 specifies the derivation and flags it as a real gap, not a rounding error. **Median, not mean**, is used deliberately: one 8-month gap must not drag a weekly client's interval to a month |
| 19 | Example | Stage 1 `weekly` for 3 months, stage 2 `monthly` for 12. Plan created 2026-01-06, first visit after 2026-01-08. On 2026-02-10 the client is inside stage 1 → **interval 7 days.** |
| 20 | Anti-example | *"Parse `sessions.next_session_note` for '4 weeks'."* That column is free text (`0034` has the structured field; `next_session_note` does not). Parsing prose is inference, which V1 forbids — and a note reading "book 4 weeks after the swelling settles" would yield a confidently wrong date |

---

### 4.9 Expected return window

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | The date range in which returning is "on time" |
| 2 | Eligibility set | Clients with an interval (§4.8) |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | `lastVisit` civil date + interval ± tolerance |
| 6 | Timezone | Studio-local civil dates throughout; **inclusive on both ends** — this is the one deliberate exception to §2.2, because a window shown to a human should include its stated last day |
| 7 | Included states | `windowStart = lastVisit + interval − tol`, `windowEnd = lastVisit + interval + tol`, where `tol = clamp(round(0.25 × interval), 2, 14)` days |
| 8 | Excluded states | Tier-3 clients have no window |
| 9 | Cancellation | Does not shift the window — the window is anchored to the last **treated** visit |
| 10 | Reschedule | Does not shift the window unless the move changes `lastVisit` itself |
| 11 | No-show | Does not shift the window |
| 12 | Refund | n/a |
| 13 | Historical corrections | Moves with `lastVisit` and with interval edits |
| 14 | Multi-practitioner | Client-level |
| 15 | Multi-studio | Single studio |
| 16 | Sources | Derived; no new table |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | The 25% / 2–14 day tolerance is a **product choice with no evidential basis**. Declared here so it lives in one place and can be tuned deliberately |
| 19 | Example | Interval 14d, `lastVisit` 2026-06-02 → `tol = 4` (round 3.5), window **2026-06-12 .. 2026-06-20** |
| 20 | Anti-example | *"Window = exactly `lastVisit + interval`."* A single date makes "Due soon" true for one day a fortnight, so the surface is empty almost always and the studio stops looking at it |

---

### 4.10 Rebooking rate

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of the visits that happened in this period, what share left with the next one booked |
| 2 | Eligibility set | Qualifying visits (§4.1) whose `starts_at` falls in the period |
| 3 | **Numerator** | Those visits for which a **later** appointment for the same client exists with `starts_at > visit.starts_at` and `status IN ('confirmed','completed')`, **excluding** any appointment linked to the visit by `rescheduled_to_appointment_id` |
| 4 | **Denominator** | All qualifying visits in the period |
| 5 | Time authority | `appointments.starts_at` of the **visit** (the denominator row) |
| 6 | Timezone | Period bounds via `utcInstantFromLocal(civil,"00:00",tz)`, half-open |
| 7 | Included states | Denominator: `completed`, or `confirmed` with session blocks. Numerator: a strictly later `confirmed`/`completed` appointment |
| 8 | Excluded states | `cancelled` and `no_show` in the denominator; the reschedule successor in the numerator; archived clients |
| 9 | Cancellation | A cancelled visit is not in the denominator. If the client's *next* booking is later cancelled, the numerator drops on the next read — the rate is **not** frozen at visit time |
| 10 | Reschedule | **Critical.** A public reschedule of the follow-up creates a successor row that would otherwise look like a second future booking. Excluding rows reachable via `rescheduled_to_appointment_id` prevents it counting twice. Legacy rows lack lineage (`0171:19-45`), so the guard degrades to *at most* one over-count per legacy reschedule — disclosed, not hidden |
| 11 | No-show | Excluded from the denominator. A visit the client never attended cannot be evidence about whether the studio rebooks well |
| 12 | Refund | n/a |
| 13 | Historical corrections | Recomputed each read; a past period's rate can move when a future booking is cancelled |
| 14 | Multi-practitioner | Attribute the **visit** by `sessions.practitioner_id`. Per-practitioner numerators and denominators sum to the studio figures because each visit belongs to exactly one practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, lineage (`0171:221,234`), `sessions`, `session_blocks` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Recency-biased at the trailing edge: a visit yesterday has had one day to be rebooked. Any surface must either exclude the trailing *interval* worth of days or label the last window "still settling" |
| 19 | Example | June: 40 qualifying visits; 31 have a later confirmed/completed appointment → **77.5%** |
| 20 | Anti-example | *"Clients with a future appointment ÷ all clients."* Two failures at once: the denominator includes clients who were never treated, and one client with ten visits contributes once, so a studio's busiest clients are invisible in its rebooking number |

---

## 5. Capacity contracts

### 5.0 The capacity ladder — and why the top rung is not built

Practice Health must never compute `business opening hours − appointments` and
call the result capacity. The layers below are ordered so each is derived from
the authoritative scheduling truth in §1.4, and the point at which today's
engine stops being able to answer is stated rather than papered over.

```
  Scheduled business hour     ← availability defaults / overrides
        − blockouts, recurring breaks, timed blocks
  = Bookable hour             ← COMPUTABLE WITH DEFINED QUERY
        − existing reservations, buffers, packing, per-service duration
  = Truly available hour      ← FUTURE SUBSYSTEM REQUIRED
```

**Why the last step is not just another subtraction.** "Truly available" means
*a client could actually book it*, and that question is answered only by
`getAvailableSlots` (`lib/booking/slots.ts:216`), which requires **one date and
one service duration** per call. Availability is not duration-independent: a
40-minute gap is available for a 30-minute service and unavailable for a
60-minute one. There is no single scalar "available hours" unless the product
first decides *available for what*.

Compounding it, slot candidates are **anchors, not a grid** (`slots.ts:387-455`):
opening edge, each reservation boundary forward and backward, an optional
closing edge, and a coarse hourly fallback. Counting offered slots measures the
packing algorithm, not the practice. Two studios with identical free time can
show different slot counts.

This is recorded as **§12-C1**, an engineering requirement, exactly as the brief
directs — not routed around with a shortcut.

**Interval convention for all §5 hour metrics.** Hours are **elapsed seconds ÷
3600**, computed on UTC instants and clipped to the period per §2.3. DST days
are therefore 23 or 25 hours long, which is correct.

---

### 5.1 Scheduled business hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | The hours the studio *says* it is open |
| 2 | Eligibility set | Each studio-local civil date in the period |
| 3 | Numerator | n/a |
| 4 | Denominator | Used as the denominator of nothing — Bookable hour is the honest denominator |
| 5 | Time authority | The civil date itself |
| 6 | Timezone | `open_time`/`close_time` are local `time` values; each becomes an instant via `utcInstantFromLocal(date, time, tz)` |
| 7 | Included states | For each date: an `studio_availability_overrides` row for that `effective_date` if present, else the `studio_availability_default` row for that `day_of_week`; counted only when `is_open` and both times are non-null |
| 8 | Excluded states | `is_open = false` days; days with no matching row (contribute **0**, per `slots.ts:325`) |
| 9 | Cancellation | No effect — this layer knows nothing about appointments |
| 10 | Reschedule | No effect |
| 11 | No-show | No effect |
| 12 | Refund | n/a |
| 13 | Historical corrections | **Availability rows are not versioned.** Editing next week's hours also changes what Hone reports about *last* week. This is the largest historical-fidelity gap in §5 — §12-C2 |
| 14 | Multi-practitioner | When `practitioner_capacity_enabled = true`, a practitioner-specific row wins over the studio-wide `practitioner_id IS NULL` row (`0146:120-140`, `slots.ts:262-309`). When **false** — today's state — there is exactly one studio-wide window and **per-practitioner scheduled hours do not exist**; they must not be synthesised by division (§2.5) |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `studio_availability_default`, `studio_availability_overrides` (`0010:130-137`), `studios.timezone` (`0010:20`), `getAvailabilityDefaults` / `getOverridesForRange` (`lib/booking/queries.ts:73,87`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Hone models **one open/close pair per date** (`slots.ts:438-444`). A split day (morning + evening) is expressed as one long window with a timed block in the middle, so scheduled hours overstate a split day; Bookable hour corrects it |
| 19 | Example | Mon–Fri 09:00–17:00, one Wednesday overridden to 09:00–13:00. A 5-day week = 4×8 + 4 = **36 h** |
| 20 | Anti-example | *"24 h × days."* Also *"weekly default × weeks"*, which ignores overrides and silently reports a holiday week as full |

---

### 5.2 Bookable hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Hours inside opening hours that are not already committed to something other than clients |
| 2 | Eligibility set | Scheduled business hours (§5.1) |
| 3 | Numerator | n/a |
| 4 | **Denominator** | **The denominator for every utilization metric in §5** |
| 5 | Time authority | The civil date, as §5.1 |
| 6 | Timezone | Break `start_local_time`/`end_local_time` and block instants resolved in studio time |
| 7 | Included states | Scheduled hours **minus the union of**: whole days covered by `studio_blockouts` (`starts_on ≤ date ≤ ends_on` → the entire day is removed, `slots.ts:241-249`); `studio_recurring_break_occurrences` ∩ window; `studio_timed_blocks` ∩ window |
| 8 | Excluded states | Inactive break rules (`active = false`); blocks outside the window; **appointments** — those belong to Booked hour, not here |
| 9 | Cancellation | No effect |
| 10 | Reschedule | No effect |
| 11 | No-show | No effect |
| 12 | Refund | n/a |
| 13 | Historical corrections | Inherits §5.1's non-versioning. Additionally, **recurring break rules are not versioned**: adding a lunch break today reduces the reported bookable hours of every past week matching those weekdays |
| 14 | Multi-practitioner | Blockouts are studio-wide and never bypassed, even by the owner override (`0146:110-117`). Timed blocks and breaks are studio-scoped today; with capacity on they fan to each practitioner's `resource_key` (`slots.ts:336-345`) |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §5.1 sources plus `studio_blockouts` (`0010:130-137`), `studio_recurring_break_rules` (`0031:82-93`), `studio_timed_blocks` (0061), `getTimedBlocksForRange` / `getRecurringBreakOccurrencesForRange` (`lib/booking/queries.ts:118,185`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Subtracted intervals **must be unioned before subtraction.** A lunch break overlapped by a timed block is one loss of time, not two; naive summation can drive bookable hours negative |
| 19 | Example | 36 h scheduled; 5 × 1 h lunch; one 2 h timed block that does not overlap lunch → **29 h** |
| 20 | Anti-example | *"Scheduled hours minus the sum of every block."* Double-subtracts overlaps. Equally wrong: subtracting the buffer of existing appointments here — buffer belongs to Booked hour |

---

### 5.3 Truly available hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Hours a client could genuinely book right now |
| 2 | Eligibility set | Bookable hours (§5.2) not already reserved |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Would be the civil date **and** a service duration |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require: `studio_calendar_reservations` intervals, per-appointment buffer re-application (`slots.ts:375-378`), the availability window, the packing anchors, and — when capacity is on — practitioner membership, service eligibility and the per-resource GiST exclusion |
| 8 | Excluded states | Everything reserved, blocked or outside the window |
| 9 | Cancellation | Would increase it, by deleting the reservation shadow row (`0171:100-102`) |
| 10 | Reschedule | Public: frees the original interval, consumes the new one. Move: same, atomically |
| 11 | No-show | No effect — the interval was consumed regardless |
| 12 | Refund | n/a |
| 13 | Historical corrections | Would be meaningless retrospectively: "could have been booked" cannot be reconstructed once reservations have changed. **This metric is forward-looking only** |
| 14 | Multi-practitioner | With capacity off there is one studio-wide timeline; with capacity on, per-`resource_key` timelines run in parallel (`slots.ts:336-345`) |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `getAvailableSlots` (`lib/booking/slots.ts:216-553`), `validate_appointment_availability` (`0146:43-161`), `studio_calendar_reservations` GiST exclusion (0134) |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED** |
| 18 | Known limitation | Three independent blockers: (a) availability is **duration-relative**, so no single scalar exists without naming a service; (b) the only entry point is per-day and per-duration; (c) slot **counts** are a packing artifact (`slots.ts:117-124,387-455`). See §12-C1 |
| 19 | Example | *(Once built)* "3.5 h available for a 60-minute service next week" — a sentence that names its service, as it must |
| 20 | Anti-example | *"`Bookable − Booked`."* It counts unbookable residue as capacity: three scattered 20-minute gaps are 1 h of "open capacity" and 0 bookable appointments. Also wrong: summing `getAvailableSlots(...).length × duration`, which counts overlapping anchors as if they were disjoint time |

---

### 5.4 Booked hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Time the calendar is committed to clients, including the protective buffer after each |
| 2 | Eligibility set | Appointments overlapping the period |
| 3 | Numerator | Numerator of Calendar utilization (§5.8) |
| 4 | Denominator | n/a |
| 5 | Time authority | `starts_at` … `blocked_ends_at` (= `ends_at + buffer_minutes_snapshot`, `0029:120`) |
| 6 | Timezone | Instants are absolute; only the **period bounds** are studio-local |
| 7 | Included states | `status IN ('confirmed','completed','no_show')` |
| 8 | Excluded states | `cancelled` — the time is not committed. **`no_show` is included**: the slot was held and could not be sold |
| 9 | Cancellation | Removes the contribution entirely, in both future and past periods. A past period's booked hours therefore **fall** when an old appointment is retroactively cancelled |
| 10 | Reschedule | Public: predecessor is `cancelled` → 0; successor contributes at its new time. **Exactly one contribution.** Move: one row, contributing at its current time — the original time is gone from the row and survives only in `appointment_audit.details.previous_starts_at` (`0143:191`) |
| 11 | No-show | Included, deliberately. A no-show consumed the calendar |
| 12 | Refund | n/a |
| 13 | Historical corrections | A move rewrites when the hours occurred — and the trigger **recomputes `blocked_ends_at` from the preserved snapshot** (`0029:55-79,92`), so a move relocates the hours without silently re-buffering them at today's rate. No null branch is needed (§2.6) |
| 14 | Multi-practitioner | By `appointments.practitioner_id`; **Unassigned** bucket for null. Reassignment retroactively moves past hours between practitioners |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments` (`0010:174`), `buffer_minutes_snapshot` / `blocked_ends_at` (`0029:44,119-120`), `getAppointmentsForRange` (`lib/booking/queries.ts:227`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Booked hours can exceed Bookable hours: buffer may spill past `close_time` (`slots.ts:151-162`, `0146:149`), and an owner outside-availability override books outside the window entirely (`0146:120`). Utilization above 100% is therefore **valid and meaningful** — it means work happened outside declared hours — and must not be clamped |
| 19 | Example | 10:00–11:00 with a 15-minute snapshot buffer → **1.25 h** |
| 20 | Anti-example | *"`Σ duration_minutes`."* That is Treatment hour and understates calendar commitment by the whole buffer. Also wrong: using the **current** `studios.buffer_minutes`, which makes last year's hours change when the studio adjusts a setting today (§2.6) |

---

### 5.5 Treatment hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Scheduled hands-on time, excluding buffer |
| 2 | Eligibility set | As §5.4 |
| 3 | Numerator | Numerator of Treatment utilization (§5.9) |
| 4 | Denominator | n/a |
| 5 | Time authority | `starts_at` … `ends_at` (the **service** end, no buffer — `0143:171`) |
| 6 | Timezone | As §5.4 |
| 7 | Included states | `status IN ('confirmed','completed','no_show')` |
| 8 | Excluded states | `cancelled`; buffer time |
| 9–11 | Cancellation / Reschedule / No-show | Identical to §5.4 |
| 12 | Refund | n/a |
| 13 | Historical corrections | As §5.4, minus the buffer-snapshot concern |
| 14 | Multi-practitioner | As §5.4 |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments.duration_minutes` (`0010:182`), `ends_at` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Scheduled, not delivered.** Delivered time would be `session_blocks.minutes_performed` (`0009:18`), which is not required and not reliably populated; `sessions.ended_at` is nullable (`0001:85`), so wall-clock session duration is unavailable. Never label this "time treating" |
| 19 | Example | Same appointment as §5.4 → **1.0 h** |
| 20 | Anti-example | *"`ends_at − starts_at` where `ends_at` includes the buffer."* It does not — `ends_at` is the service end. Assuming otherwise inflates every treatment figure by exactly the buffer |

---

### 5.6 Completed treatment hour

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Treatment hours Hone can positively evidence as delivered |
| 2 | Eligibility set | As §5.5 |
| 3 | Numerator | Numerator of Realized utilization (§5.10) |
| 4 | Denominator | n/a |
| 5 | Time authority | `starts_at` … `ends_at` |
| 6 | Timezone | As §5.4 |
| 7 | Included states | `status = 'completed'` **only** |
| 8 | Excluded states | `confirmed` (including past ones), `no_show`, `cancelled` |
| 9 | Cancellation | Contributes 0 |
| 10 | Reschedule | One contribution, at its final time |
| 11 | No-show | Contributes 0 — correctly, no treatment was delivered |
| 12 | Refund | n/a |
| 13 | Historical corrections | Charting an old appointment late flips it to `completed` and **retroactively increases a past period**. Explicitly expected |
| 14 | Multi-practitioner | Prefer `sessions.practitioner_id` (NOT NULL, `0001:82`) over the mutable `appointments.practitioner_id` |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments.status`; `mark_appointment_complete()` via `app/(app)/clients/[id]/sessions/new/actions.ts:49` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **`completed` means "charted", not "attended"** (§1.1). Every attended-but-uncharted visit is missing. Any surface showing this must also show the **Unresolved** count — past appointments still `confirmed` — or the studio will read a charting backlog as lost business |
| 19 | Example | 40 past appointments in June: 31 `completed`, 2 `no_show`, 7 still `confirmed`. Completed treatment hours cover **31**; the 7 are reported as Unresolved |
| 20 | Anti-example | *"Past appointments that were not cancelled were completed."* Booking-anchored, and it silently counts every unmarked no-show as delivered treatment — and, because `auto_mark_no_shows` is forced off (`app/(app)/settings/studio/actions.ts:129`) and the cron is non-mutating (`app/api/cron/no-show-check/route.ts`), unmarked no-shows are the *normal* case, not an edge case |

---

### 5.7 Open capacity

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Time that could still be sold |
| 2 | Eligibility set | Future bookable hours |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Civil date + service duration |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would equal Truly available hour (§5.3) for a named service |
| 8 | Excluded states | Past time; reserved intervals; buffer |
| 9 | Cancellation | Would increase it |
| 10 | Reschedule | Net zero across the pair, but redistributed in time |
| 11 | No-show | No effect |
| 12 | Refund | n/a |
| 13 | Historical corrections | Forward-looking only; never reported for a past period |
| 14 | Multi-practitioner | Per-practitioner only when the capacity flag is on |
| 15 | Multi-studio | Single studio |
| 16 | Sources | Would be §5.3's |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED** — it is §5.3 under a friendlier name and inherits every blocker |
| 18 | Known limitation | A coarse **`Bookable hour − Booked hour`** *is* computable and is a legitimate number — but it must be labelled **"Unbooked bookable time"**, never "open capacity", because it counts unbookable residue. §12-C1 |
| 19 | Example | *(Once built)* "Next 7 days: 3.5 h open for 60-minute services, 6.0 h for 30-minute" — two different answers to the same question, which is the point |
| 20 | Anti-example | Presenting `Bookable − Booked` as open capacity. A day with six 20-minute gaps between back-to-back appointments reports 2 h "open" and can sell none of it |

---

### 5.8 Calendar utilization

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Share of workable time the calendar is committed |
| 2 | Eligibility set | The period × the studio (or practitioner) |
| 3 | **Numerator** | Booked hour (§5.4) |
| 4 | **Denominator** | Bookable hour (§5.2) |
| 5 | Time authority | Both clipped to the period per §2.3 |
| 6 | Timezone | Period bounds studio-local |
| 7 | Included states | Numerator `confirmed`/`completed`/`no_show`; denominator per §5.2 |
| 8 | Excluded states | `cancelled` from the numerator; nothing removed from the denominator on account of appointments |
| 9 | Cancellation | Lowers the numerator only. The denominator never shrinks because a day was cancelled away — a cancelled day is *unsold*, not *unavailable* |
| 10 | Reschedule | Within the period: no net change. Across the boundary: hours move periods. Both are correct and neither double-counts, because exactly one row is active |
| 11 | No-show | Counts in the numerator — the time was consumed |
| 12 | Refund | n/a |
| 13 | Historical corrections | Both sides move with edits; §5.1's non-versioning means the denominator of a past period is *today's* availability configuration. §12-C2 |
| 14 | Multi-practitioner | **Studio utilization is not the mean of practitioner utilizations.** It is `Σ numerator ÷ Σ denominator`. Averaging percentages weights a half-day practitioner equally with a full-time one |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §5.2 + §5.4 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **May legitimately exceed 100%** (§5.4). Denominator 0 (fully closed period) must render as **"—"**, never 0% and never ∞ |
| 19 | Example | 29 h bookable, 21.75 h booked → **75.0%** |
| 20 | Anti-example | *"Booked ÷ scheduled business hours."* Uses §5.1 as the denominator, so lunch breaks and blockouts count as time the studio failed to sell. It makes a well-run studio with a proper break schedule look under-utilised |

---

### 5.9 Treatment utilization

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Share of workable time spent on scheduled hands-on treatment |
| 2 | Eligibility set | As §5.8 |
| 3 | **Numerator** | Treatment hour (§5.5) |
| 4 | **Denominator** | Bookable hour (§5.2) |
| 5–12 | — | As §5.8, except the numerator excludes buffer |
| 13 | Historical corrections | As §5.8 |
| 14 | Multi-practitioner | As §5.8 — sum the parts, never average the percentages |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §5.2 + §5.5 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Always ≤ Calendar utilization. The gap between them **is** the buffer cost, which makes the pair genuinely useful — but only when shown together and labelled |
| 19 | Example | 29 h bookable, 17.4 h treatment → **60.0%**; alongside 75.0% calendar utilization, the 15 points are buffer |
| 20 | Anti-example | Showing this alone as "utilization". A studio with a 30-minute buffer policy looks idle when it is fully committed |

---

### 5.10 Realized utilization

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Share of workable time Hone can evidence as actually delivered |
| 2 | Eligibility set | **Past periods only** |
| 3 | **Numerator** | Completed treatment hour (§5.6) |
| 4 | **Denominator** | Bookable hour (§5.2) |
| 5 | Time authority | `starts_at` |
| 6 | Timezone | Studio-local period bounds |
| 7 | Included states | `status='completed'` only |
| 8 | Excluded states | Everything else, **including past `confirmed`** |
| 9 | Cancellation | Lowers the numerator |
| 10 | Reschedule | One contribution at its final time |
| 11 | No-show | Excluded — that is the metric's purpose |
| 12 | Refund | n/a |
| 13 | Historical corrections | Late charting raises a past period's figure. Never snapshot this number |
| 14 | Multi-practitioner | By `sessions.practitioner_id` |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §5.2 + §5.6 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Undefined for any period containing future time**, and for a partially-elapsed period it drifts upward all week. Must be reported only for fully-elapsed periods, and always beside the Unresolved count, or a charting backlog reads as lost revenue |
| 19 | Example | Last month: 120 h bookable, 78 h completed treatment → **65.0%**, with 9 h Unresolved disclosed alongside |
| 20 | Anti-example | Showing it for "this month" on the 3rd. Two days elapsed, so the denominator is a whole month and the number is near zero — an alarming, meaningless figure |

---

### 5.11 Forward booking depth

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | How full the book is at increasing distance into the future — one number per horizon, never one blended percentage |
| 2 | Eligibility set | Four forward windows, in studio-local civil days, where **D1 = tomorrow**: `Next 7` = D1–D7 · `Next 14` = D1–D14 · `Days 15–30` = D15–D30 · `Days 31–60` = D31–D60 |
| 3 | **Numerator** | Booked hour (§5.4) within the window |
| 4 | **Denominator** | Bookable hour (§5.2) within the window |
| 5 | Time authority | `starts_at`, with hours clipped to the window per §2.3 |
| 6 | Timezone | Window bounds are `utcInstantFromLocal(civilDate,"00:00",tz)`, half-open |
| 7 | Included states | As §5.8 |
| 8 | Excluded states | As §5.8; plus **the current partial day is excluded from all four windows.** It is reported separately as **"Rest of today"**, computed from `now` rather than from midnight: numerator and denominator both clipped to `[now, todayClose)`. Including a part-elapsed day inside `Next 7` would depress the most-watched window every afternoon for reasons that have nothing to do with the book |
| 9 | Cancellation | Lowers the numerator of whichever window contains the freed time |
| 10 | Reschedule | Can move hours between windows; net zero overall, which is the correct signal |
| 11 | No-show | Not applicable to future time |
| 12 | Refund | n/a |
| 13 | Historical corrections | Forward-looking; recomputed per read |
| 14 | Multi-practitioner | Per practitioner when the capacity flag is on; otherwise studio-only (§2.5) |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §5.2 + §5.4 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **`Next 7` and `Next 14` deliberately overlap** and must be labelled as cumulative, not as disjoint buckets that sum. Also: with no booking-horizon setting (§1.5), the far windows are structurally thin — a low `Days 31–60` is normal, not a warning |
| 19 | Example | Next 7: 26/29 h = **89.7%**. Next 14: 44/58 = **75.9%**. Days 15–30: 31/93 = **33.3%**. Days 31–60: 12/186 = **6.5%** |
| 20 | Anti-example | *"One utilization percentage for the next 60 days."* It averages a nearly-full next week with an almost-empty second month into a mid-range number that describes neither, and hides the only signal that matters: whether the *near* book is filling |

---

## 6. Financial contracts

### 6.0 Payment time authority

Four distinct instants exist and they must never be conflated:

| Instant | Column | Means |
|---|---|---|
| **Appointment date** | `appointments.starts_at` | When the *work* was scheduled |
| **Attempt creation** | `payment_charge_attempts.created_at` | When a practitioner *prepared* a charge. **Not a money event.** |
| **Successful collection** | `payment_charge_attempts.charged_at` | When money actually moved (`0073:166`; written at `lib/billing/session-payment-charge.ts:344`) |
| **Refund** | `payment_charge_attempts.refunded_at` | When money moved back (`0078:50`) |

**The binding rule:**

| Metric | Time authority | Never |
|---|---|---|
| Completed service value | `appointments.starts_at` | Not a money metric at all |
| Collected revenue | `charged_at` | **Never `created_at`** |
| Refunded amount | `refunded_at` | Never the original `charged_at` |
| Net collected revenue | Each component in its own period | Never netted into the charge's period |
| Payment resolution rate | `created_at` — legitimately, because it measures *attempt hygiene*, not money | — |

Money is **never** attributed to a period because an attempt row was created in
it. The shipped Dashboard does exactly that today
(`lib/dashboard/practice-metrics.ts:265-266`); see §9.

**Two mandatory filters on every money query.** `stripe_livemode` must be
constrained (0101 dropped the livemode CHECK; 0105 permits one active test *and*
one active live attempt per slot, so an unfiltered query can count one real
payment twice). And `currency` is CHECK-constrained to `'cad'` (`0073:113-114`),
so no conversion logic is needed — but a future second currency would silently
break every sum, and totals must therefore be grouped by currency from day one.

---

### 6.1 Completed service value

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Menu value of the treatment delivered in this period. **A measure of work, not of money.** |
| 2 | Eligibility set | Appointments with `starts_at` in the period |
| 3 | Numerator | n/a |
| 4 | Denominator | Denominator of Collection capture (§6.7) — which is why that metric is blocked |
| 5 | Time authority | `appointments.starts_at` |
| 6 | Timezone | Half-open studio-local period bounds |
| 7 | Included states | `status = 'completed'`, joined to `services.price_cents` |
| 8 | Excluded states | `confirmed`, `cancelled`, `no_show`; appointments whose `service_id` is null; services with null `price_cents` |
| 9 | Cancellation | Contributes 0 |
| 10 | Reschedule | Exactly one row is `completed`, so exactly one contribution |
| 11 | No-show | Contributes 0 here. A no-show **fee**, if charged, appears in Collected revenue via `charge_reason='no_show_fee'` — the two live in different metrics and must not be summed as "value" |
| 12 | Refund | Irrelevant — this is menu value, not money |
| 13 | Historical corrections | **The weakest point in §6.** There is no price snapshot on `appointments` (§1.2), so the value is a **live join** to today's menu. Editing a price rewrites reported history; deleting a service nulls `service_id` (`0010:179`) and silently zeroes it |
| 14 | Multi-practitioner | By `sessions.practitioner_id` where linked, else `appointments.practitioner_id`, else **Unassigned** |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments` (`0010:174`), `services.price_cents` (`0010:149`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** — with the historical-fidelity caveat above |
| 18 | Known limitation | Priceless appointments (null `service_id` **or** null `price_cents`) must be **counted and disclosed** — *"4 completed appointments have no price"* — never silently treated as $0 |
| 19 | Example | June: 31 completed; 29 priced at $80 → **$2,320.00**, with 2 unpriced disclosed |
| 20 | Anti-example | *"Completed service value is revenue."* It is neither collected nor collectible. Calling it revenue on a card is the single most damaging thing this document exists to prevent. The shipped UI is already careful here (`app/(app)/dashboard/practice-snapshot.tsx:109-112`) and that care must be preserved |

---

### 6.2 Collectible completed value

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of the work delivered, how much Hone could actually have charged for |
| 2 | Eligibility set | Completed appointments in the period |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Would be `appointments.starts_at` |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require, **as of the appointment date**: a priced service, an active card on file, and a *current* card-authorization signature (`lib/billing/session-payment-eligibility.ts:33-49`) |
| 8 | Excluded states | Unpriced work; clients with no card; clients whose authorization was stale at the time |
| 9 | Cancellation | Contributes 0 |
| 10 | Reschedule | One contribution |
| 11 | No-show | 0 for treatment value |
| 12 | Refund | n/a |
| 13 | Historical corrections | Would be corrupted by them regardless — see below |
| 14 | Multi-practitioner | Would follow §6.1 |
| 15 | Multi-studio | Single studio |
| 16 | Sources | Would need `client_payment_methods` **history** and consent-signature history |
| 17 | Computable today | **BLOCKED BY MISSING DATA** |
| 18 | Known limitation | Eligibility is evaluated **live**, at charge time. `client_payment_methods` records the current card, not a history of which clients had a valid, currently-authorized card on a given past date. A card added last week makes last month look retroactively collectible. §12-F1 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Completed service value for clients who have a card today."* Applies today's card state to the past and inflates every historical collectible figure — precisely the error that makes collection rates look worse over time for no real reason |

---

### 6.3 Collected revenue

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Money that actually arrived in this period |
| 2 | Eligibility set | `payment_charge_attempts` rows for the studio |
| 3 | Numerator | Numerator of Collection capture (§6.7) |
| 4 | Denominator | n/a |
| 5 | **Time authority** | **`charged_at`** (`0073:166`) |
| 6 | Timezone | `charged_at` bucketed by studio-local civil date, half-open |
| 7 | Included states | `status = 'succeeded'`, `charged_at IS NOT NULL`, `stripe_livemode` matching the reporting mode. Sum `amount_cents`. All three `charge_reason` values are money and are **reported separately**: `session_payment`, `late_cancellation_fee`, `no_show_fee` |
| 8 | Excluded states | `ready`, `blocked`, `pending_stripe`, `failed`, `cancelled`; the opposite `stripe_livemode` |
| 9 | Cancellation | A cancelled *attempt* (`status='cancelled'`) never collected and contributes 0. Cancelling the *appointment* does not retract money already collected |
| 10 | Reschedule | Payment attaches to a `session_id` and optionally an `appointment_id` (`0073:76-94`). A reschedule before charging leaves the money attached to whichever row is finally completed. **No double count within a mode**: a partial unique index permits at most one *active* (`ready`/`pending_stripe`/`succeeded`) `session_payment` per session (`0073:328-332`), which 0105 then made **mode-scoped**. A session may accumulate many `failed`/`cancelled` rows, but at most one `succeeded` per mode — which is precisely why the `stripe_livemode` filter in field 7 is not optional: without it, one real payment can be counted twice |
| 11 | No-show | A `no_show_fee` is real collected money and is included — but shown on its own line. Rolling fees into treatment revenue overstates clinical output |
| 12 | Refund | **Not netted here.** Gross collected. Netting happens in §6.5 |
| 13 | Historical corrections | `charged_at` is never rewritten, so a past period's collected revenue is **stable** — the one genuinely stable figure in this document |
| 14 | Multi-practitioner | `payment_charge_attempts` records the practitioner who confirmed the attempt (`0073:97-99`), which is **not necessarily who treated the client**. Prefer attributing via `session_id → sessions.practitioner_id` for clinical attribution, and say which was used |
| 15 | Multi-studio | `studio_id` on the row |
| 16 | Sources | `payment_charge_attempts` (`0073:54`), `lib/billing/session-payment-charge.ts:344` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Card-on-file only.** Cash, e-transfer and every off-platform payment are unrepresentable (§1.9). For a studio taking any payment outside Hone, this figure is a *floor*, not a total, and must be labelled "Collected through Hone" |
| 19 | Example | Appointment 2026-05-28, prepared 2026-05-28, charged 2026-06-02 → the $80 lands in **June**, not May |
| 20 | Anti-example | *"Sum `amount_cents` where `created_at` is in the period."* Counts prepared-but-never-charged attempts as revenue and books money to the wrong month. Also wrong: omitting the `stripe_livemode` filter, which can double a figure (§6.0) |

---

### 6.4 Refunded amount

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Money returned to clients in this period |
| 2 | Eligibility set | `payment_charge_attempts` with a refund |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | **Time authority** | **`refunded_at`** (`0078:50`) |
| 6 | Timezone | Studio-local, half-open |
| 7 | Included states | `refund_status = 'succeeded'`; sum `refund_amount_cents` (**not** `amount_cents` — the column is partial-refund-ready, CHECK `> 0 and <= amount_cents`, `0078:88-96`) |
| 8 | Excluded states | `refund_status` null, `'pending_stripe'` or `'failed'`; the opposite `stripe_livemode` |
| 9 | Cancellation | Independent of appointment status |
| 10 | Reschedule | Independent |
| 11 | No-show | A refunded no-show fee is a refund like any other |
| 12 | Refund | This *is* the refund metric |
| 13 | Historical corrections | `refunded_at` is not rewritten; stable |
| 14 | Multi-practitioner | `refund_initiated_by_practitioner_id` (`0078:56`) records who issued it — an operational fact, not a clinical attribution. For clinical attribution use the original charge's session |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `payment_charge_attempts` refund columns (`0078:48-56`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Refunds live on the **original attempt row**, so a refund can only ever be as large as its charge and there is at most one refund per attempt. A second partial refund would have nowhere to go — §12-F2 |
| 19 | Example | Charged 2026-05-10, refunded 2026-06-04 → **June refunds**, while May's collected revenue is untouched |
| 20 | Anti-example | *"Subtract refunds from the period the charge was in."* Retroactively rewrites a closed month, so a figure the studio already read changes underneath them. Also wrong: summing `amount_cents` for refunded rows, which reports a partial refund as a full one |

---

### 6.5 Net collected revenue

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Money kept: collected in the period, less refunded in the period |
| 2 | Eligibility set | §6.3 ∪ §6.4 |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | **Each component in its own period** — `charged_at` for collections, `refunded_at` for refunds |
| 6 | Timezone | Studio-local, half-open |
| 7 | Included states | `Net = Collected (§6.3) − Refunded (§6.4)` |
| 8 | Excluded states | As the components |
| 9–11 | Cancellation / Reschedule / No-show | As the components |
| 12 | Refund | Subtracted in the **refund's** period |
| 13 | Historical corrections | Stable, because both components are |
| 14 | Multi-practitioner | Both components must use the **same** attribution rule or the net is incoherent. Specify it once |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §6.3 + §6.4 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Can be negative** — a quiet month with a large refund of an earlier charge. The UI must render negative values, not clamp at zero, and must show gross and refunds beside the net so a negative is explicable |
| 19 | Example | June: collected $4,180, refunded $80 (of a May charge) → **$4,100** |
| 20 | Anti-example | *"Net revenue = sum of non-refunded charges."* Silently drops the full value of a partially-refunded charge instead of subtracting the refunded portion |

---

### 6.6 Outstanding payment

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Completed work that has not been paid for |
| 2 | Eligibility set | Completed appointments with a priced service and no successful charge |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | Time authority | Would be `appointments.starts_at` |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require a concept of *money owed* |
| 8 | Excluded states | — |
| 9 | Cancellation | Would contribute 0 |
| 10 | Reschedule | One contribution |
| 11 | No-show | A no-show fee that was set but never charged would be outstanding — also unrepresentable |
| 12 | Refund | A refunded charge does not make the work outstanding again |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Would follow §6.1 |
| 15 | Multi-studio | Single studio |
| 16 | Sources | None exist |
| 17 | Computable today | **BLOCKED BY MISSING DATA** |
| 18 | Known limitation | Hone has **no invoice, balance, deposit or account-credit concept**. There is only a ledger of *attempts*. In the schema, "the client paid $80 in cash" and "the client owes $80" are the **same absence of a row**. A metric that cannot distinguish being paid from being owed cannot be shipped. §12-F3 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Completed appointments with no `succeeded` attempt."* For a studio that takes any cash or e-transfer this reports a large, growing, entirely fictional debt — and the studio's rational response is to stop trusting Hone's financials altogether |

---

### 6.7 Collection capture

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of what could have been collected, how much was |
| 2 | Eligibility set | Completed work in the period |
| 3 | **Numerator** | Collected revenue (§6.3) with `charge_reason='session_payment'` |
| 4 | **Denominator** | Collectible completed value (§6.2) |
| 5 | Time authority | Denominator by `starts_at`; numerator by `charged_at` — **a deliberate mismatch**, and one reason this metric is hard even once unblocked |
| 6 | Timezone | Studio-local |
| 7 | Included states | Per components |
| 8 | Excluded states | Fees, which are not payment for treatment |
| 9–12 | — | Per components |
| 13 | Historical corrections | Per components |
| 14 | Multi-practitioner | Both sides must share one attribution rule |
| 15 | Multi-studio | Single studio |
| 16 | Sources | §6.2 (blocked) + §6.3 |
| 17 | Computable today | **BLOCKED BY MISSING DATA** — inherits §6.2 |
| 18 | Known limitation | Beyond §6.2, the numerator and denominator use different clocks: work completed on the last day of a month is frequently charged in the next. Even once unblocked, this needs a **settlement lag** convention (e.g. count charges up to 7 days after period end) — §12-F1 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Collected ÷ completed service value."* Uses §6.1 as the denominator, so every cash payment and every client without a card counts as a collection failure. It measures the studio's payment *model*, not its collection *performance* |

---

### 6.8 Payment resolution rate

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of the charges prepared in this period, how many reached a terminal state instead of sitting unresolved |
| 2 | Eligibility set | `payment_charge_attempts` created in the period |
| 3 | **Numerator** | Attempts now in a terminal state: `succeeded`, `failed` or `cancelled` |
| 4 | **Denominator** | All attempts created in the period |
| 5 | **Time authority** | **`created_at`** — legitimately, because this is a **cohort of attempts**, not a money figure |
| 6 | Timezone | Studio-local, half-open |
| 7 | Included states | Denominator: every attempt with matching `stripe_livemode`. Numerator: `status IN ('succeeded','failed','cancelled')` |
| 8 | Excluded states | Numerator excludes `ready`, `pending_stripe`, `blocked` — the unresolved states |
| 9 | Cancellation | `cancelled` **is** a resolution (soft-retirement, `0073:360`) and counts in the numerator. It is not a *collection*, and this metric is not about collection |
| 10 | Reschedule | No effect |
| 11 | No-show | Fee attempts are included; the metric is about attempt hygiene across all reasons |
| 12 | Refund | No effect — a refunded charge still succeeded |
| 13 | Historical corrections | The numerator of a past cohort **rises over time** as stragglers resolve. Cohort metrics move; that is expected and must be labelled |
| 14 | Multi-practitioner | By the confirming practitioner (`0073:97-99`) — an operational attribution, appropriate here |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `payment_charge_attempts.status` (`0073:121-130`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | This is an **operational hygiene** metric, not a revenue metric. A studio that prepares nothing scores 100%. Meaningless without the absolute counts beside it |
| 19 | Example | June: 42 prepared; 38 succeeded, 2 failed, 1 cancelled, 1 still `ready` → **41/42 = 97.6%** |
| 20 | Anti-example | *"Successful ÷ prepared, called 'collection rate'."* It excludes deliberately-cancelled attempts from the numerator while keeping them in the denominator, penalising correct housekeeping — and its name implies a revenue meaning it does not have |

---

## 7. Cancellation-recovery contracts

### 7.0 Why five of these eight are not computable

The brief is strict, and it is right to be: revenue is not "recovered" merely
because a cancellation happened and a later appointment exists. The causal chain
Hone would need is:

```
cancelled slot → released-capacity record → offer / candidate → accepted or claimed → replacement appointment
```

**Hone has the first link and nothing after it.** §1.9 records the search: no
waitlist of clients wanting a slot (`0004_waitlist.sql` is the marketing
landing-page signup for prospective *studios*), no offer table, no hold, no
claim, no notify-me. A cancellation deletes its reservation shadow row
(`0171:100-102`) and leaves no record that a specific window became free.

So the honest boundary is drawn here: everything up to and including *cancelled
slot* is computable; everything that requires **causal evidence** is marked
`NOT COMPUTABLE YET` rather than approximated. Any heuristic — "a booking made
within 48 hours of a cancellation, in the freed window, counts as recovery" —
would attribute ordinary demand to a recovery feature that does not exist, and
would make that feature look successful before it is built.

---

### 7.1 Cancelled appointment

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | A booking the studio lost — withdrawn, not moved |
| 2 | Eligibility set | Appointments with `status='cancelled'` |
| 3 | Numerator | n/a |
| 4 | Denominator | n/a |
| 5 | **Time authority** | **`cancelled_at`** (`0010:186`) — the period in which the *cancellation* happened. A separate "cancellations of appointments scheduled in this period" view uses `starts_at` and must be named differently |
| 6 | Timezone | Studio-local, half-open |
| 7 | Included states | `status='cancelled'` **and** `cancellation_kind IS DISTINCT FROM 'rescheduled'` **and** `rescheduled_to_appointment_id IS NULL` |
| 8 | Excluded states | Reschedule predecessors — they are not lost bookings, they moved. Also excluded: **every practitioner move**, which produces no cancelled row at all (§1.7) |
| 9 | Cancellation | This is the cancellation metric |
| 10 | Reschedule | **The defining subtlety.** Public reschedule creates a cancelled predecessor that must **not** count — hence the two-condition guard. Practitioner move creates nothing to count |
| 11 | No-show | A no-show is **not** a cancellation. Separate status, separate metric. Merging them hides which problem the studio actually has |
| 12 | Refund | A late-cancellation fee may have been charged; it appears in §6.3, never here |
| 13 | Historical corrections | `cancelled_at` is not rewritten; stable |
| 14 | Multi-practitioner | By `appointments.practitioner_id` at cancellation; **Unassigned** for null |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments` (`0010:183-187`), `cancellation_kind` (`0125:51-52`), lineage (`0171:221,234`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Legacy rescheduled cancellations are indistinguishable from real ones.** The pre-0171 RPC set neither `cancellation_kind` nor lineage (`0171:19-45`), so historical reschedules are counted as cancellations. The affected row count is knowable (`cancelled` rows with null `cancellation_kind` before the 0171 apply date) and **must be disclosed** rather than silently absorbed |
| 19 | Example | June: 14 cancelled rows; 3 carry `cancellation_kind='rescheduled'` → **11 cancellations** |
| 20 | Anti-example | *"`status='cancelled'` counted by `starts_at`."* Two errors: it counts reschedule predecessors as losses, and it books a cancellation to the month the appointment *would* have happened, so cancelling a December booking in June shows up as a December problem |

---

### 7.2 Released capacity

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Calendar time that became free because a future booking was cancelled |
| 2 | Eligibility set | Cancelled appointments (§7.1) that were **still in the future when cancelled** — `cancelled_at < starts_at` |
| 3 | Numerator | n/a |
| 4 | Denominator | Denominator of Recovered capacity (§7.6) — which is why that is blocked |
| 5 | Time authority | **`starts_at`** — the period the freed *time* belongs to (distinct from §7.1, which uses `cancelled_at`) |
| 6 | Timezone | Studio-local; hours clipped per §2.3 |
| 7 | Included states | Hours = `[starts_at, ends_at + buffer_minutes_snapshot)`, clipped to the period **and** intersected with Bookable hour (§5.2) — time released outside opening hours was never sellable |
| 8 | Excluded states | Cancellations of already-past appointments (nothing was released); reschedule predecessors (§7.1) |
| 9 | Cancellation | This is the cancellation metric's capacity twin |
| 10 | Reschedule | Excluded. A public reschedule *does* free the original window, but it simultaneously consumes another — net capacity effect is ≈ zero and calling it "released" would inflate the number with routine movement |
| 11 | No-show | **Releases nothing.** The slot was held to the end; nobody could have booked it |
| 12 | Refund | n/a |
| 13 | Historical corrections | Derived at read time from current row state; if an old cancellation is edited, the figure moves |
| 14 | Multi-practitioner | By `practitioner_id`. With the capacity flag off, released time is studio-wide |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `buffer_minutes_snapshot` (`0029:44`), §5.2 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Derived, never recorded.** No row is written when capacity is released — the reservation shadow is simply deleted (`0171:100-102`). The reconstruction is only as good as the appointment row that survives, and it cannot see a window that was freed and re-consumed before anyone looked. §12-X1 |
| 19 | Example | 2 h appointment + 15 min buffer, cancelled a week ahead, entirely inside opening hours → **2.25 h released** in the period containing `starts_at` |
| 20 | Anti-example | *"Every cancelled appointment's duration."* Counts same-day cancellations of already-elapsed appointments, counts reschedule predecessors, and counts time outside opening hours that was never sellable |

---

### 7.3 Cancelled slot

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | One specific freed window, with enough notice that it could plausibly have been refilled |
| 2 | Eligibility set | Released capacity (§7.2), one entry per cancelled appointment |
| 3 | Numerator | n/a |
| 4 | Denominator | Denominator of Refilled slot (§7.5) — blocked |
| 5 | Time authority | `starts_at` of the freed window |
| 6 | Timezone | Studio-local |
| 7 | Included states | `(starts_at, ends_at, practitioner_id, lead_time)` where `lead_time = starts_at − cancelled_at`. Bucketed: **< 24 h · 24–72 h · > 72 h** |
| 8 | Excluded states | As §7.2 |
| 9 | Cancellation | Source of the slot |
| 10 | Reschedule | Excluded (§7.2) |
| 11 | No-show | Produces no slot |
| 12 | Refund | n/a |
| 13 | Historical corrections | As §7.2 |
| 14 | Multi-practitioner | The slot belongs to the cancelled appointment's practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | As §7.2 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | A cancelled slot is **not** a bookable slot. Whether the freed window can actually host a booking depends on service duration and neighbouring reservations — the §5.3 problem. Report cancelled slots as *events*, never as available inventory |
| 19 | Example | Friday 14:00–15:00 with Nadia, cancelled Wednesday 09:00 → lead time 53 h → **24–72 h bucket** |
| 20 | Anti-example | *"Cancelled slots are open slots."* A 60-minute cancellation between two appointments with a 15-minute buffer either side leaves 30 bookable minutes, not 60 |

---

### 7.4 Refill candidate

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | A client who could plausibly take a freed slot |
| 2 | Eligibility set | Would be: clients wanting an earlier appointment, or on a waitlist for that window |
| 3–4 | Numerator / Denominator | n/a |
| 5 | Time authority | Would be the moment the candidate was identified or offered |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require an expressed preference — waitlist entry, "notify me if earlier", or an accepted offer |
| 8 | Excluded states | — |
| 9–12 | Cancellation / Reschedule / No-show / Refund | n/a |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Would need per-practitioner eligibility |
| 15 | Multi-studio | Single studio |
| 16 | Sources | **None exist** |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED** |
| 18 | Known limitation | No waitlist, no offer, no notify-me, no hold, no claim (§1.9). `public.waitlist` (`0004_waitlist.sql:4-10`) is the **marketing** signup for prospective studios — `(email, practice_name, source 'landing')` — and must never be mistaken for a client waitlist by a future implementer reading the table list. §12-X2 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Overdue clients are refill candidates."* Being overdue (§4.5) is a fact about elapsed time. It carries no expressed willingness to take a specific window on 48 hours' notice, and treating it as consent to be offered one is both a bad metric and a bad client experience |

---

### 7.5 Refilled slot

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | A freed window that was demonstrably sold again |
| 2 | Eligibility set | Cancelled slots (§7.3) |
| 3 | **Numerator** | Would be: slots with an accepted offer resulting in a booking |
| 4 | **Denominator** | Cancelled slots |
| 5 | Time authority | Would be the acceptance instant |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require an explicit link from a release to the replacement booking |
| 8 | Excluded states | Bookings that merely happen to fall in the freed window |
| 9–12 | — | n/a |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Would follow §7.3 |
| 15 | Multi-studio | Single studio |
| 16 | Sources | **None exist** |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED** |
| 18 | Known limitation | The lineage columns Hone *does* have (`rescheduled_from/to_appointment_id`, `0171:221,234`) link a reschedule pair. **They do not link a cancellation to an unrelated client's later booking**, which is what refill means. §12-X2 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"A booking created after the cancellation whose time overlaps the freed window."* On a busy Friday, ordinary demand fills that window anyway. This heuristic would credit a recovery feature that does not exist with the studio's normal booking rate |

---

### 7.6 Recovered capacity

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Hours freed by cancellation that were sold again |
| 2 | Eligibility set | Released capacity (§7.2) |
| 3 | **Numerator** | Would be hours from refilled slots (§7.5) |
| 4 | **Denominator** | Released capacity |
| 5 | Time authority | Would be `starts_at` of the freed window |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require §7.5 |
| 8 | Excluded states | — |
| 9–12 | — | n/a |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Per practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | Denominator computable; **numerator has no source** |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED — `NOT COMPUTABLE YET`** |
| 18 | Known limitation | Half the fraction exists, which is the dangerous case: it is tempting to pair a real denominator with an invented numerator. **Do not ship the denominator alone under a "recovery" label** — §7.2 is publishable on its own only as "Released capacity" |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Released hours minus hours still empty at the end of the period."* Attributes every subsequent booking in that window to the cancellation, and a busy studio scores near 100% "recovery" while having no recovery capability whatsoever |

---

### 7.7 Recovered revenue

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Money that would have been lost to a cancellation but was earned back |
| 2 | Eligibility set | Refilled slots (§7.5) |
| 3–4 | Numerator / Denominator | Would be the service value of refilled slots over released value |
| 5 | Time authority | Would be `charged_at` of the replacement booking's payment |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require §7.5 **and** a price snapshot (§1.2) |
| 8 | Excluded states | Late-cancellation fees — those are §6.3 money and are **not** recovery |
| 9–12 | — | n/a |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Per practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | **None exist** |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED — `NOT COMPUTABLE YET`** |
| 18 | Known limitation | Blocked twice over: no causal link (§7.5) **and** no historical price (§1.2). Even with a refill subsystem, the value figure would move whenever the menu changed. §12-X2 + §12-F4 |
| 19 | Example | Not computable |
| 20 | Anti-example | *"Late-cancellation fees are recovered revenue."* A fee is compensation for a loss, not recovery of it — the slot stayed empty. Presenting fees as recovery makes a studio's cancellation problem look self-correcting |

---

### 7.8 Unrecovered capacity

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Freed hours that stayed empty |
| 2 | Eligibility set | Released capacity (§7.2) |
| 3 | Numerator | Would be `Released − Recovered` |
| 4 | Denominator | Released capacity |
| 5 | Time authority | `starts_at` of the freed window |
| 6 | Timezone | Studio-local |
| 7 | Included states | Would require §7.6 |
| 8 | Excluded states | — |
| 9–12 | — | n/a |
| 13 | Historical corrections | — |
| 14 | Multi-practitioner | Per practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | Complement of an uncomputable quantity |
| 17 | Computable today | **FUTURE SUBSYSTEM REQUIRED** |
| 18 | Known limitation | **The complement of an unknown is also unknown.** It is superficially tempting to compute "freed windows with no appointment overlapping them at period end" — but that measures whether the window was *eventually* booked by anyone, not whether the studio *recovered* it, and it silently defines every unmeasured recovery as a failure |
| 19 | Example | Not computable |
| 20 | Anti-example | Reporting all released capacity as unrecovered "until recovery tracking exists". It looks conservative and is in fact the most misleading option available: it asserts a 0% recovery rate as a measurement, when the truth is that nothing was measured |

---

## 8. Retention contracts

Retention reuses the rebooking machinery (§4) rather than defining a parallel
one. Where a retention term restates a rebooking term at client level, it says
so and inherits every field it does not override.

### 8.1 Active returning client

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | A client currently in the studio's care — treated more than once, recently enough to still be a client |
| 2 | Eligibility set | §4.1 eligible clients |
| 3 | Numerator | Numerator of Returning-client rate (§8.3) |
| 4 | Denominator | n/a |
| 5 | Time authority | `appointments.starts_at` of qualifying visits |
| 6 | Timezone | Civil dates, studio-local |
| 7 | Included states | ≥ 2 qualifying visits (§4.1) **and** `lastVisit` within the retention window (§8.6) **and** `archived_at IS NULL` |
| 8 | Excluded states | Single-visit clients; archived clients; clients whose last visit precedes the window |
| 9 | Cancellation | Cancelled appointments are not visits |
| 10 | Reschedule | One visit per pair / per moved row |
| 11 | No-show | Not a visit, and does not refresh `lastVisit` |
| 12 | Refund | n/a |
| 13 | Historical corrections | Archiving a client removes them **immediately, including from past periods**, because the population is recomputed from current state. Any period-over-period comparison must be recomputed for both periods on the same read |
| 14 | Multi-practitioner | Studio-level. A client seen by two practitioners is **one** client and must not be counted in both practitioner buckets when a studio total is shown |
| 15 | Multi-studio | Single studio; a `clients` row belongs to one studio |
| 16 | Sources | `appointments`, `clients.archived_at` (`0050:22`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **`clients.email` is not unique** (§1.8). One human with two client rows is two "clients": one may look active and the other lapsed. There is no merge tooling. §12-R5 |
| 19 | Example | 12-month window, ≥ 2 visits, last visit within 12 months, not archived → active returning |
| 20 | Anti-example | *"Clients with ≥ 2 appointments."* Counts cancelled and future appointments as visits, so a client who booked twice and attended nothing is "returning" |

---

### 8.2 Second-visit conversion

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of the clients who came once, how many came back |
| 2 | Eligibility set | Clients whose **first** qualifying visit falls in the cohort period |
| 3 | **Numerator** | Those with a second qualifying visit **within the conversion window** of the first |
| 4 | **Denominator** | All clients in the cohort whose conversion window has **fully elapsed** |
| 5 | Time authority | `starts_at` of the first qualifying visit (cohort assignment) and of the second (conversion) |
| 6 | Timezone | Civil dates, studio-local |
| 7 | Included states | Conversion window = **90 days** by default, or `2 × expected return interval` (§4.8) where an interval exists — the interval-aware form is preferred and must be labelled |
| 8 | Excluded states | **Open cohorts** — clients whose window has not elapsed are excluded from *both* numerator and denominator, never counted as failures |
| 9 | Cancellation | Cancelled appointments are not visits |
| 10 | Reschedule | One visit per pair; a moved first visit can change cohort membership |
| 11 | No-show | Not a visit. A client whose second booking was a no-show has **not** converted — correctly |
| 12 | Refund | n/a |
| 13 | Historical corrections | Late charting can retroactively create a qualifying visit and move a client into the numerator of a closed cohort |
| 14 | Multi-practitioner | By the **first** visit's `sessions.practitioner_id` — conversion is a property of the first experience |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `sessions`, `session_blocks` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | "First visit in Hone" ≠ "first visit ever". `imported_treatment_memories.occurred_on` (`0089:114`) holds pre-Hone history, so a migrated long-standing client can be counted as a brand-new one. Clients with any imported memory **must be excluded from cohorts** and the exclusion disclosed. §12-R4 |
| 19 | Example | March cohort: 18 first-visit clients, all windows elapsed; 11 returned within 90 days → **61.1%** |
| 20 | Anti-example | *"Clients with ≥ 2 visits ÷ all clients with ≥ 1 visit."* No cohort and no window: last week's first-timers are counted as conversion failures, so the rate is permanently depressed and always falls when the studio is winning new clients |

---

### 8.3 Returning-client rate

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Of the clients seen in this period, what share were established rather than new |
| 2 | Eligibility set | Clients with ≥ 1 qualifying visit in the period |
| 3 | **Numerator** | Those with ≥ 1 qualifying visit **strictly before** the period start |
| 4 | **Denominator** | All distinct clients with a qualifying visit in the period |
| 5 | Time authority | `appointments.starts_at` |
| 6 | Timezone | Half-open studio-local bounds |
| 7 | Included states | Qualifying visits (§4.1) |
| 8 | Excluded states | Cancelled, no-show, future; archived clients are **excluded from both sides** |
| 9 | Cancellation | Not a visit |
| 10 | Reschedule | A move across the period boundary changes which period a client is counted in — once, never twice |
| 11 | No-show | Not a visit |
| 12 | Refund | n/a |
| 13 | Historical corrections | Recomputed per read |
| 14 | Multi-practitioner | **Per-practitioner rates do not sum to the studio rate.** A client seen by two practitioners appears in both denominators but once in the studio's. Any breakdown must say so |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `clients` |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Moves inversely to new-client acquisition: a great month for marketing lowers this rate. It is only interpretable beside the absolute new-client count |
| 19 | Example | June: 62 distinct clients seen; 47 had a prior visit → **75.8%** |
| 20 | Anti-example | *"Clients seen this month who were also seen last month."* That is month-over-month repeat rate, which for a studio with a 6-week cadence is structurally low and says nothing about retention |

---

### 8.4 Overdue client

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Client-level restatement of §4.5 |
| 2 | Eligibility set | §4.5 |
| 3–12 | — | **Inherits §4.5 unchanged** |
| 13 | Historical corrections | As §4.5 |
| 14 | Multi-practitioner | By last-visit practitioner; a client appears in exactly one bucket |
| 15 | Multi-studio | Single studio |
| 16 | Sources | As §4.5 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | Clients with no expected interval (Tier 3, §4.0) are **never** overdue. On a Retention surface their absence can read as a healthy signal when it is really an absence of evidence — the *No expected interval* count must be shown alongside |
| 19 | Example | As §4.5 |
| 20 | Anti-example | Defining "overdue client" on the Retention surface with a different threshold from "overdue" on the Rebooking surface. Two numbers with one name is worse than either alone |

---

### 8.5 Lapsed client

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | Client-level restatement of §4.6 |
| 2 | Eligibility set | §4.6 |
| 3–12 | — | **Inherits §4.6 unchanged** |
| 13 | Historical corrections | As §4.6 |
| 14 | Multi-practitioner | By last-visit practitioner |
| 15 | Multi-studio | Single studio |
| 16 | Sources | As §4.6 |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **Archived ≠ lapsed** (§4.6). Archiving is how a practitioner records "this client is finished with us", and it is the closest thing Hone has to a deliberate churn signal. Reporting the two together conflates a filing decision with an outcome |
| 19 | Example | As §4.6 |
| 20 | Anti-example | *"Lapsed = no visit in 12 months."* A fixed threshold again. For a weekly-cadence electrolysis client, twelve months is roughly fifty missed visits reported as one late one |

---

### 8.6 Retention window / cohort

| # | Field | Contract |
|---|---|---|
| 1 | Product meaning | The observation period over which retention is judged, and the group judged within it |
| 2 | Eligibility set | Clients grouped by the civil month of their **first qualifying visit** |
| 3 | Numerator | n/a — a framing, not a rate |
| 4 | Denominator | Supplies the denominator for §8.2 and §8.3 |
| 5 | Time authority | `starts_at` of the first qualifying visit |
| 6 | Timezone | Cohort months are studio-local calendar months, half-open |
| 7 | Included states | **Retention window** = trailing **12 months** by default. **Cohort** = first-visit month. A cohort is **closed** only when its observation window has fully elapsed |
| 8 | Excluded states | Open cohorts from any rate; archived clients; clients whose only history is imported |
| 9 | Cancellation | Cannot form a cohort — a cancelled appointment is not a first visit |
| 10 | Reschedule | A moved first visit can shift a client's cohort. With a public reschedule the successor's `starts_at` is authoritative; with a move, the row's current `starts_at` is. **Either way exactly one row is the first visit** |
| 11 | No-show | Never a first visit |
| 12 | Refund | n/a |
| 13 | Historical corrections | Late charting can add a client to a **closed** cohort, changing a previously-published figure. Cohort tables must carry an "as calculated on" stamp (§2.7) |
| 14 | Multi-practitioner | Cohorts are studio-level. Per-practitioner cohorts are usually too small to be meaningful and should carry a minimum-size threshold before display |
| 15 | Multi-studio | Single studio |
| 16 | Sources | `appointments`, `clients.created_at`, `imported_treatment_memories.occurred_on` (`0089:114`) |
| 17 | Computable today | **COMPUTABLE WITH DEFINED QUERY** |
| 18 | Known limitation | **`clients.created_at` is not a first-visit date** — it is when the record was made, which for an imported or intake-first client can be months earlier, or later, than any treatment. Cohorts must be built from **first qualifying visit**, never from `created_at`. §12-R4 |
| 19 | Example | March 2026 cohort: 18 clients with their first qualifying visit in March, window elapsed 2026-06-30 → cohort closed and reportable |
| 20 | Anti-example | *"Cohort by `clients.created_at`."* Assigns every client migrated on import day to a single enormous cohort with an artificial 100% same-day "acquisition", and puts intake-only records who were never treated into the denominator |

---

## 9. Reconciliation with the shipped Dashboard V1

Hone already renders business numbers. `lib/dashboard/practice-metrics.ts` +
`app/(app)/dashboard/practice-snapshot.tsx` are the de-facto incumbent, and any
new metric layer must either agree with them or explain the disagreement. Three
of the shipped numbers do not survive these contracts.

| Shipped number | Where | Verdict against this document |
|---|---|---|
| **Appointments {period}** headline | `practice-metrics.ts:87`, rendered `practice-snapshot.tsx:87` | **Disagrees.** `total = rows.length` over all rows with `starts_at` in the period, so cancellations and no-shows are inside the headline "appointments" figure. The sub-stats then break them out, so the headline exceeds the sum of what a reader treats as real appointments |
| **Completed / Upcoming / Cancelled / No-shows** | `practice-metrics.ts:97-111` | **Agrees**, with one gap: past appointments still `confirmed` fall into none of the four (`upcoming` requires `starts_at > now`). They are silently invisible. §2.8's **Unresolved** bucket is exactly this missing category |
| **Late cancellations** | `practice-metrics.ts:106` | ❌ **Structurally always zero.** It tests `cancellation_reason === "late_cancellation"`, but that column receives a *human label* — `"Schedule changed"`, `"Booked by mistake"`, … from `lib/booking/cancellation-reasons.ts:32-40` — while the stable machine value goes to `appointment_audit.details.reason`. No shipped writer ever produces the string `"late_cancellation"`; the only other occurrence in the repository is a unit test that constructs the input itself (`tests/app/dashboard/practice-dashboard.test.ts:80`), which is why the defect is invisible to CI. A late-cancellation contract must read the audit `details.reason` and apply a lead-time rule |
| **Booked / Completed service value** | `practice-metrics.ts:99-107`, joined at `:249` and `:340` | **Agrees in definition, and the UI is commendably careful** — `practice-snapshot.tsx:109-112` explicitly says these are booked service prices, not collected payments. The limitation stands: it is a **live join** to `services.price_cents`, so it restates today's menu over past work (§6.1 field 13) |
| **Payments prepared / charged / refunds** | `practice-metrics.ts:260-266, 351-360` | ❌ **Wrong time authority.** The query filters `created_at` between the period bounds. A charge prepared on 31 May and collected on 2 June counts in **May**; a refund issued in June against a May charge counts in **May** and never appears in June at all. Per §6.0, collections belong to `charged_at` and refunds to `refunded_at`. The `stripe_livemode` filter at `:264` is correct and must be preserved |
| **Charted within 24h** | `practice-metrics.ts:159-200` | ✅ **Agrees, and is the strongest existing definition.** Rolling 7-day denominator on `ends_at`, numerator on the earliest non-deleted `session_block` of a non-deleted linked session, inclusive 24 h boundary — all stated in the code. This document adopts its "charted" rule wholesale (§1.3) |
| **Week boundary** | `practice-metrics.ts:38-49` | ⚠️ **Monday**, while `lib/booking/tz.ts:249-255` returns **Sunday**. Two week definitions ship today (§2.4) |

Nothing above requires the shipped code to change. It is recorded so that when
Practice Health is built, the discrepancies are resolved deliberately rather
than discovered by a studio.

---

## 10. Review sweep

Every definition in §4–§8 was re-read against the eleven hazards the brief
names. The findings, and where each is handled:

### 10.1 Double counting

| Hazard | Handling |
|---|---|
| A public reschedule leaves **two** appointment rows | Every count filters `status`, so the cancelled predecessor drops out (§4.2, §5.4, §7.1). §7.1 adds a second guard on `rescheduled_to_appointment_id` |
| Rebooking rate could count the reschedule successor as "rebooked" | Explicitly excluded via lineage (§4.10 field 3) |
| A client seen by two practitioners | Counted once at studio level; §8.1 and §8.3 state that per-practitioner rows do **not** sum |
| Overlapping unavailability | §5.2 requires the **union** before subtraction; naive summation can drive bookable hours negative |
| Slot counts summed as capacity | Forbidden in §5.3 field 20 — anchors overlap by construction |
| One payment appearing twice across Stripe modes | §6.0 mandates the `stripe_livemode` filter (0105 permits one active test **and** one active live attempt per slot) |
| `Next 7` ⊂ `Next 14` | §5.11 field 18 requires cumulative labelling; they must never be presented as summable buckets |

### 10.2 Reschedules

Hone's **two structurally different** reschedule models (§1.7) are addressed in
field 10 of all 43 terms. The residual risk is legacy: pre-0171 reschedules set
neither `cancellation_kind` nor lineage (`0171:19-45`), so historical
rescheduled cancellations are counted as real cancellations. §7.1 field 18
requires the affected count be disclosed rather than absorbed.

The practitioner move (`0143:178-183`) produces **no cancellation row at all**,
which means any "reschedule rate" built only on `cancellation_kind='rescheduled'`
sees client-initiated reschedules and is blind to practitioner-initiated ones.
Recorded as §12-X3.

### 10.3 Refunds

Refunds land in the **refund's** period on `refunded_at` (§6.4), never netted
back into the charge's period — so a closed month's collected revenue is stable.
§6.4 requires summing `refund_amount_cents`, not `amount_cents`, because the
column is partial-refund-ready (`0078:88-96`). §6.5 must render negative.

### 10.4 Future appointments

Future rows are excluded from every backward-looking metric and are the entire
basis of §4.2 and §5.11. §5.10 is explicitly **undefined** for periods
containing future time. §7.2 requires `cancelled_at < starts_at` so that
cancelling an already-elapsed appointment releases nothing.

### 10.5 Multi-practitioner aggregation

Three rules, all in §2.5: booked facts attribute by the **mutable**
`appointments.practitioner_id`; delivered facts by the immutable
`sessions.practitioner_id`; nulls go to a visible **Unassigned** bucket.
Studio utilization is `Σ numerator ÷ Σ denominator`, never the mean of
percentages (§5.8 field 14). While `practitioner_capacity_enabled = false`
(`0134:55`) there is one studio-wide availability window, so per-practitioner
capacity hours **must not be synthesised by division**.

### 10.6 Timezone boundaries

All period bounds are `utcInstantFromLocal(civilDate, "00:00", studio.timezone)`
(§2.1). DST is inherited from the audited two-pass converter
(`lib/booking/tz.ts:47-67`) rather than re-derived. Hour metrics measure elapsed
time, so a spring-forward day is genuinely 23 hours — stated in §2.1 so it is
not later "fixed" into a bug. Interval arithmetic in §4 is in **civil days**, so
a DST transition never adds or removes a day from a return window.

### 10.7 Partial days

Forward windows start at **D1 = tomorrow**; the current partial day is excluded
from all four and reported separately (§5.11 fields 2 and 8). §5.10 must not be
rendered for a partially-elapsed period.

### 10.8 Cancelled slots

Released capacity is **derived at read time**, never recorded (§7.2 field 18) —
a cancellation deletes its reservation shadow row (`0171:100-102`) and leaves
nothing behind. Released ≠ bookable (§7.3 field 18). Everything requiring causal
evidence is `NOT COMPUTABLE YET` (§7.4–§7.8).

### 10.9 Historical corrections

§2.7 states the house rule — metrics are point-in-time restatements — and names
the four edits that move history. Field 13 of every term specifies its own
behaviour. The two metrics that are genuinely **stable** are §6.3 and §6.4,
because `charged_at` and `refunded_at` are never rewritten. Financial surfaces
require an "as calculated on" stamp.

### 10.10 Client archival

`archived_at` (`0050:22`) removes a client from every active population, and
**archived is never reported as lapsed** (§4.6, §8.5) — archiving is a
practitioner's deliberate filing act, not an outcome. Because populations are
recomputed from current state, archiving a client also removes them from past
periods; §8.1 field 13 requires both periods of any comparison be computed on
the same read.

### 10.11 Appointments spanning range boundaries

§2.3 sets the rule: **counts** attribute whole to the period containing their
time authority; **hours** are clipped; **money** attributes whole to the period
of the money timestamp. Counts and hours therefore deliberately disagree at a
boundary, and no surface may imply `hours = count × duration`.

### 10.12 Metrics whose data cannot support a defensible answer

Flagged explicitly, as the brief requires:

| Metric | Why |
|---|---|
| Collectible completed value (§6.2) | No card-on-file or authorization **history** |
| Outstanding payment (§6.6) | No invoice/balance concept; unpaid and paid-in-cash are the same absence of a row |
| Collection capture (§6.7) | Denominator is §6.2 |
| Refill candidate (§7.4) | No waitlist, offer, hold or claim exists |
| Refilled slot (§7.5) | No causal link from a release to a later booking |
| Recovered capacity (§7.6) | Numerator has no source |
| Recovered revenue (§7.7) | Blocked twice: no causal link **and** no historical price |
| Unrecovered capacity (§7.8) | Complement of an uncomputable quantity |
| Truly available hour (§5.3) | Duration-relative; per-day-only entry point; slot counts are a packing artifact |
| Open capacity (§5.7) | Inherits §5.3 |

And three that are computable but **carry a defect a customer would notice**:

| Metric | Defect |
|---|---|
| Completed service value (§6.1) | Live price join — editing the menu rewrites history; deleting a service zeroes it |
| Completed treatment hour (§5.6) / Realized utilization (§5.10) | `completed` means charted, not attended; must be shown beside the Unresolved count |
| Due soon / Overdue / Lapsed (§4.4–§4.6) | Undefined for clients with no interval evidence; must render "No expected interval", never "Overdue" |

---

## 11. The five most important ambiguities

### 1. Hone cannot tell whether a past appointment happened

`completed` is stamped by `mark_appointment_complete()` from the **charting**
entry point (`app/(app)/clients/[id]/sessions/new/actions.ts:49`), `no_show` is
manual-only (migration 0033), the no-show cron is deliberately non-mutating
(`app/api/cron/no-show-check/route.ts`), and `auto_mark_no_shows` is forced
false (`app/(app)/settings/studio/actions.ts:129`). A past appointment still
`confirmed` may be attended-and-uncharted, an unmarked no-show, or a phone
cancellation never entered.

*Why it matters:* every attendance, utilization and value metric inherits it.
*Resolution needed:* either an attendance fact independent of charting, or a
product decision that **Unresolved** is a first-class number Hone shows and asks
the studio to clear. This document assumes the latter (§2.8).

### 2. Financial history is a restatement of today's price list

`appointments` snapshots `duration_minutes` but **not price** (`0010:174-190`).
Every value figure live-joins `services.price_cents`, and
`appointments.service_id` is `on delete set null` (`0010:179`).

*Why it matters:* a routine price rise silently rewrites last year's numbers;
deleting a retired service silently zeroes every appointment that used it.
*Resolution needed:* a price snapshot on the appointment, or an explicit product
decision that value figures are always "at current menu prices" and are labelled
that way on every surface.

### 3. Hone reschedules in two structurally different ways, and one leaves no trace

Public reschedule (`reschedule_appointment_v2`, 0171) cancels and creates a
successor with both lineage pointers and `cancellation_kind='rescheduled'`.
Practitioner move (`move_or_reassign_appointment`, `0143:178-183`) **mutates
`starts_at`, `ends_at` and `practitioner_id` in place**, leaving only an
`appointment_audit` row. And the legacy reschedule RPC set neither lineage nor
`cancellation_kind` (`0171:19-45`).

*Why it matters:* cancellation counts, reschedule rates and any per-practitioner
history of a *past* appointment all depend on which path was used.
*Resolution needed:* decide whether a practitioner move is product-equivalent to
a client reschedule. If yes, it needs comparable lineage.

### 4. The only structured return cadence has no anchor date

`treatment_plan_stages.how_often_unit ∈ {weekly, every_2_weeks, monthly}`
(`0034:56`) is genuine, writable, deterministic cadence evidence — exactly what
the brief asks V1 to use. But a stage has `sort_order`, `stage_length_value` and
`stage_length_unit` and **no start date**; the parent plan has only `created_at`
and `closed_at` (`0024:9-20`).

*Why it matters:* "weekly for 3 months, then monthly for 12" cannot be resolved
to *today's* cadence without a derivation rule, and a wrong stage produces a
confidently wrong Due-soon date.
*Resolution needed:* §12-R1 — either a stored stage anchor, or a ratified
derivation rule.

### 5. There is no duration-independent answer to "how much capacity is open"

`getAvailableSlots` (`lib/booking/slots.ts:216`) requires **one date and one
service duration**; a 40-minute gap is available for a 30-minute service and not
for a 60-minute one. Slot candidates are anchors, not a grid
(`slots.ts:387-455`), so slot *counts* measure the packing algorithm.

*Why it matters:* "open capacity" is the most requested practice-health number
and the least well-defined.
*Resolution needed:* §12-C1 — the product must first decide *available for
what*, then the aggregation must be built against the existing engine rather
than beside it.

**Runners-up**, each real and each cheaper to fix: two week definitions ship
today, Monday in `practice-metrics.ts:38-49` and Sunday in `tz.ts:249-255`;
`clients.email` is not unique, so one human can be two clients with no merge
tooling; `imported_treatment_memories.occurred_on` (`0089:114`) means "first
visit in Hone" is routinely not a first visit; and the shipped "Late
cancellations" stat is structurally always zero (§9).

---

## 12. Engineering requirements

Work that must exist before the corresponding metric is defensible. **None of it
is in scope for this document, and none of it has been started.**

These 14 requirements are grouped into five product dependencies, with a
suggested sequencing, in
[Engineering dependency groups](#engineering-dependency-groups) near the top of
this document. Read that first for planning; read the tables below for the
specification of each item.

### Rebooking / retention

| ID | Requirement | Unblocks |
|---|---|---|
| **R1** | A **treatment-plan stage anchor**. Either a stored `stage_started_on`, or a ratified derivation: anchor at the client's first qualifying visit on or after `treatment_plans.created_at` (falling back to `created_at`), then walk stages cumulatively by `sort_order` using `stage_length_value` + `stage_length_unit`. Must be one shared helper, not re-implemented per surface | §4.4–§4.6, §4.8, §8.4, §8.5 |
| **R2** | A rule for suppressing clients whose plan is finished (`treatment_plans.status`, `closed_at`) from Needs rebooking | §4.3 |
| **R3** | A structured **pause / snooze / not-returning** signal, so "she'll call in the autumn" is representable and stops generating Overdue noise | §4.5, §8.4 |
| **R4** | A decision on **pre-Hone history**: whether `imported_treatment_memories.occurred_on` counts toward first-visit, recurring-client and cohort logic. Until decided, imported clients are excluded and the exclusion disclosed | §4.7, §8.2, §8.6 |
| **R5** | **Duplicate-client detection or merge.** `clients.email` is not unique | §8.1, all retention |

### Capacity

| ID | Requirement | Unblocks |
|---|---|---|
| **C1** | An **aggregate availability capability built on the existing engine** — a range-and-duration-aware entry point that reuses `getAvailableSlots` / `validate_appointment_availability` rather than reimplementing the rules. Must answer "available hours for a service of duration D over range R", and must never be satisfied by a second capacity calculator | §5.3, §5.7 |
| **C2** | **Versioned availability**, or an accepted product statement that capacity denominators always reflect *current* configuration. Today, editing next week's hours changes what Hone reports about last week | §5.1, §5.2, and every utilization denominator |

### Financial

| ID | Requirement | Unblocks |
|---|---|---|
| **F1** | **Card-on-file and authorization history**, so "was this collectible at the time" is answerable — plus a **settlement-lag** convention for charges landing after period end | §6.2, §6.7 |
| **F2** | Support for **multiple / repeated partial refunds**. Refund columns live on the original attempt row, so there is room for exactly one | §6.4 |
| **F3** | An **amount-owed concept** — invoice, balance, or at minimum a recorded off-platform payment — so "unpaid" and "paid in cash" stop being the same absence of a row | §6.6 |
| **F4** | A **price snapshot on `appointments`**, so completed value is a historical fact rather than a restatement of today's menu | §6.1, §7.7 |

### Cancellation recovery

| ID | Requirement | Unblocks |
|---|---|---|
| **X1** | A **released-capacity record** written at cancellation, rather than reconstructed from the surviving appointment row | §7.2, §7.3 |
| **X2** | The **refill subsystem** itself: waitlist / interest, offer, acceptance, and a link from the release to the replacement booking. Without acceptance evidence, recovery stays `NOT COMPUTABLE YET` | §7.4–§7.8 |
| **X3** | A decision on whether a **practitioner move** is product-equivalent to a client reschedule, and comparable lineage if so | §7.1, §10.2 |

---

## Appendix — source index

Every file this document relies on, for a future reader checking a claim.

**Schema.** `0001_init.sql` (sessions, session_blocks, clients) ·
`0004_waitlist.sql` (marketing signup — *not* a client waitlist) ·
`0009_session_modality_and_params.sql` (`minutes_performed`) ·
`0010_booking_v1.sql` (appointments, services, availability, blockouts,
appointment_audit, studio booking columns) · `0024_treatment_plans.sql` ·
`0029_double_booking_constraint.sql` (`buffer_minutes_snapshot`,
`blocked_ends_at`) · `0031_recurring_breaks.sql` ·
`0033_pre_stripe_operational_hardening.sql` (`mark_appointment_no_show`) ·
`0034_treatment_plan_stages.sql` (`how_often_unit`) ·
`0050_clients_archive.sql` · `0068_sessions_appointment_link.sql` ·
`0073_payment_charge_attempts.sql` · `0078_payment_charge_attempts_refund_columns.sql` ·
`0089_imported_treatment_memory.sql` · `0101` / `0105` (livemode posture) ·
`0125_google_calendar_outbound_enqueue_activation_boundary.sql`
(`cancellation_kind`) · `0134_practitioner_capacity_foundation.sql` ·
`0143_move_or_reassign_appointment.sql` ·
`0146_authoritative_duration_and_availability_validator.sql` ·
`0152_actual_overlap_hard_buffer_soft.sql` ·
`0171_public_reschedule_command_v2.sql`.

**Application.** `lib/booking/slots.ts` · `lib/booking/queries.ts` ·
`lib/booking/tz.ts` · `lib/booking/cancellation-reasons.ts` ·
`lib/dashboard/practice-metrics.ts` · `lib/billing/session-payment-eligibility.ts` ·
`lib/billing/session-payment-charge.ts` ·
`app/(app)/dashboard/practice-snapshot.tsx` ·
`app/(app)/clients/[id]/treatment-plans-actions.ts` ·
`app/(app)/clients/[id]/sessions/new/actions.ts` ·
`app/(app)/clients/[id]/sessions/[sessionId]/actions.ts` ·
`app/(app)/settings/studio/actions.ts` · `app/api/cron/no-show-check/route.ts`.

Line references throughout are against the branch this document was written on.
Migrations are frozen once applied, so schema citations are stable; application
citations may drift and should be re-grepped rather than trusted verbatim.
