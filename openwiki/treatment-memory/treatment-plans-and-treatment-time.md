---
type: data model
title: Treatment plans and treatment time
description: How a client's treatment plan is modelled and written — plan rows with multi-area and month-timeline fields, the three seeded clinical stages, attaching sessions through the set_session_treatment_plan command, closing a plan with an application-only cross-client guard — plus the per-client treatment-time goal, the electrolysis-only time totals and their multi-area attribution rule, and the non-atomic edges.
tags: [treatment-memory, treatment-plans, stages, treatment-time, sessions, rls]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-251a72d0b52c2c5e4a1ece78
    resource: repo://app/(app)/clients/%5Bid%5D/treatment-plans-actions.ts
  - id: openwiki-source-08602a988dda30d0ad04052d
    resource: repo://app/(app)/clients/%5Bid%5D/treatment-time-actions.ts
  - id: openwiki-source-dc9a1da612097e2d64e46019
    resource: repo://lib/sessions/treatment-intelligence.ts
  - id: openwiki-source-4c1cfa11c3b6872834bb499a
    resource: repo://lib/treatment-plans/stage-defaults.ts
  - id: openwiki-source-2cf2fd4a7390fd6a728ce089
    resource: repo://lib/treatment-time/area-bucket.ts
  - id: openwiki-source-5a8bdf26f4914f0764e71888
    resource: repo://lib/treatment-time/queries.ts
  - id: openwiki-source-9de6ce2ba9bca2d65cccb600
    resource: repo://supabase/migrations/0024_treatment_plans.sql
  - id: openwiki-source-7c3e9a942f4f2c6f5b535357
    resource: repo://supabase/migrations/0026_treatment_goals.sql
  - id: openwiki-source-a2aa5b567785ab1246a30081
    resource: repo://supabase/migrations/0034_treatment_plan_stages.sql
  - id: openwiki-source-7bd3aae2f49d3f3f1611cd15
    resource: repo://supabase/migrations/0051_treatment_plan_multi_area_and_timeline.sql
  - id: openwiki-source-69126d72bc36d60399cbd4c9
    resource: repo://supabase/migrations/0167_session_write_commands.sql
  - id: openwiki-source-aef347f415985d3f29b05db4
    resource: repo://tests/lib/treatment-time/area-attribution.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Treatment plans and treatment time

A **treatment plan** describes how a client's course of treatment is expected to run. **Treatment time**
reports how much electrolysis time a client has actually received. Both live on the client profile
(the `treatment` and `sessions` tabs, see [Client records and profile](../clients/client-records-and-profile.md)).
Neither changes a booking, a price or a charge.

## 1. The plan model

| Object | Migration | Shape |
|---|---|---|
| `treatment_plans` | `0024`, `0038`, `0051` | `name` (≤ 100), `status` `active`/`closed`, creator and closer attribution, `primary_area`; since `0051` also optional `treatment_areas[]` (1–12 entries) and `estimated_timeline_months_min/max` (1–60 each, min ≤ max). `suggested_visit_count` is kept as a legacy field, now defaulting to 12 |
| `treatment_plan_stages` | `0034` | ordered stages with `how_often_unit` (`weekly`, `every_2_weeks`, `monthly`), `visit_length_minutes` (5–240) and a stage length in weeks or months (≤ 240); `studio_id` is trigger-derived from the parent plan |
| `sessions.treatment_plan_id` | `0024` | nullable link; deleting a plan sets it to NULL, never cascading into charted sessions |
| `treatment_goals` | `0026` | **one row per client**: an estimated total in minutes (≤ 100,000) and a status of `active`, `reached`, `revised` or `archived` |

([`0024`](../../supabase/migrations/0024_treatment_plans.sql#L8-L74),
[`0034`](../../supabase/migrations/0034_treatment_plan_stages.sql#L28-L142),
[`0051`](../../supabase/migrations/0051_treatment_plan_multi_area_and_timeline.sql#L1-L126),
[`0026`](../../supabase/migrations/0026_treatment_goals.sql#L15-L44))

`0051` reframed plans around **months and total treatment time** rather than visit counts, because session
lengths vary too much for "X of Y visits" to be meaningful. The change was additive: legacy rows keep NULL
for the new columns, and the app falls back to `primary_area`, the mirror of the first entry in
`treatment_areas`.

**RLS.** Plans and goals are studio-membership scoped:

- Plans have per-command policies and **no DELETE**. A plan is closed, never deleted.
- Stage deletion is an explicit, kept capability since `0087`.

**Budget is no longer plan data.** It moved to the client in `0183`, and the plan editor no longer writes
`budget_notes` (see the client page).

## 2. Writing plans

All plan actions run in `app/(app)/clients/[id]/treatment-plans-actions.ts` under the user-scoped client.

**Create** (`createTreatmentPlanAction`, L134-L284):

1. Validate against the migration caps and re-prove the client against the session's studio.
2. Insert the plan.
3. Seed the three **fixed clinical stages**, Clearing, Control and Maintenance, with editable defaults
   ([`stage-defaults.ts`](../../lib/treatment-plans/stage-defaults.ts)).

These are **two writes**. If the stage insert fails, the action **closes** the stageless plan instead of
deleting it. The earlier `.delete()` had been a silent no-op since `0024`, because plans never had an
authenticated DELETE policy.

**Close** (`closeTreatmentPlanAction`, L286-L348). `verifyPlanForCurrentStudio` first proves that the plan
is in the studio, belongs to the submitted client and is still active. The update then binds id, studio,
client and `status = 'active'`, and `.select()` makes a zero-row outcome visible. The code comment records
why this matters:

- before the fix, a practitioner on one client's page could close **another client's** plan in the same
  studio;
- `treatment_plans` RLS is studio-scoped only, the table has no triggers, and `authenticated` holds direct
  UPDATE.

So **the application predicate is the whole control**.

**Attach and detach a session** go through `set_session_treatment_plan` (`0167`). It is `SECURITY DEFINER`
with `search_path = ''`, and only `authenticated` may execute it. It asserts the session is writable for
the caller and client, and the plan must be **active**, in the same studio and belong to the **same
client**. The update is then scoped by session, studio and client
([`0167` L495-L535](../../supabase/migrations/0167_session_write_commands.sql#L495-L535),
[L631-L648](../../supabase/migrations/0167_session_write_commands.sql#L631-L648)).

**Create from an appointment.** The appointment's plan call to action opens the create form focused, on
iPhone, and does not auto-create a plan (`e2e/create-plan-from-appointment.spec.ts`).

## 3. Treatment time

**Goal.** `upsertTreatmentGoalAction` (`app/(app)/clients/[id]/treatment-time-actions.ts`) accepts 1–1,000
hours. It stores minutes, upserting on the unique `client_id`.

**Totals** ([`lib/treatment-time/queries.ts`](../../lib/treatment-time/queries.ts#L1-L80)):

- **Electrolysis only.** Laser sessions do not use the block model with `minutes_performed`.
- **One read.** A single round trip loads the client's non-deleted electrolysis sessions with their
  non-deleted blocks and those blocks' structured areas. Sums are computed in application code.

**Multi-area attribution** ([`area-bucket.ts`](../../lib/treatment-time/area-bucket.ts#L1-L60)). A block's
`minutes_performed` belongs to the whole settings block, and the database stores no split among its
areas, so inventing one would be fabrication:

- one structured area: that area;
- several areas: **one combined bucket** naming all of them, credited **once**;
- none: the legacy fallback.

Time is never divided, never credited to every area, and never given to the first area alone. That last
behaviour was the earlier defect: a block covering two areas dropped the second area from the breakdown
entirely. The client's global total is unchanged by the rule. It is pinned by
`tests/lib/treatment-time/area-attribution.test.ts`.

The Overview's [Treatment Intelligence summary](treatment-intelligence-summary.md) answers a different
question and attributes differently: there, a multi-area block's full minutes appear on **every** area card
it treated. So per-area minutes on the two cards can differ for the same client, while both count each block
once in their overall totals.

**Client-facing time is opt-in.** `0026` added `studios.show_treatment_time_to_clients`, off by default.
The booking and portal rebook paths read it before showing a client their treatment time.

## 4. Contradictions and open questions

1. **No database backstop for cross-client plan writes.** Within a studio, `treatment_plans` accepts any
   member UPDATE. Correct client binding depends on every action using `verifyPlanForCurrentStudio`. The
   close action had missed it before the recorded fix.
2. **Plan creation is not atomic.** Plan and stages are separate writes, compensated by closing the plan.
   A failed close would leave an active stageless plan.
3. **Raw database text in results.** Several plan and goal actions return `error.message` inside the
   result, for example "Failed to set up plan stages: …". DESIGN.md LAW 7 forbids this for user-facing
   refusals.
