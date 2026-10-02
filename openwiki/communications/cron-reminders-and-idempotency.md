---
type: operational subsystem
title: Cron jobs, reminders and idempotency
description: The five /api/cron routes, how each is scheduled and authenticated, the ~24h/~2h reminder pass and its single-claim-per-window law, retry and exhaustion semantics, the external-scheduler heartbeat, and which production facts about them are proven versus unattested.
tags: [cron, reminders, idempotency, claims, heartbeat, ops-alerts, scheduling]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-ab4eb7c868fefa4061d9a8bd
    resource: repo://app/admin/page.tsx
  - id: openwiki-source-b1af2ebe5efc310ba10e44db
    resource: repo://app/api/cron/appointment-reminders/route.ts
  - id: openwiki-source-7052f23a3cf36dfbae84eefe
    resource: repo://app/api/cron/materialize-recurring-breaks/route.ts
  - id: openwiki-source-784ec3734187825139d65676
    resource: repo://app/api/cron/no-show-check/route.ts
  - id: openwiki-source-65295a967382e1ca9e077f0a
    resource: repo://docs/08_EMAIL_SMS_AND_CRON.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-996df574e948557af3265d55
    resource: repo://lib/cron/auth.ts
  - id: openwiki-source-9afd6bc7462fab2ab436d9f4
    resource: repo://lib/cron/reminder-heartbeat.ts
  - id: openwiki-source-54d9dab2c030c70dedd2fd26
    resource: repo://lib/cron/reminder-schedule.ts
  - id: openwiki-source-1b5ff97e669fa5b399aa2743
    resource: repo://lib/ops/alerts.ts
  - id: openwiki-source-c526a88b9c15bb2964ba71a7
    resource: repo://lib/sms/send-appointment.ts
  - id: openwiki-source-50a18d054b596a7ed0eeffb0
    resource: repo://next.config.ts
  - id: openwiki-source-c0258c4e3690077c60a2f18d
    resource: repo://supabase/migrations/0080_email_send_claims.sql
  - id: openwiki-source-027c4f687616e8ada27313d7
    resource: repo://supabase/migrations/0098_intake_reminder_columns.sql
  - id: openwiki-source-d0f5071c3b7e74807c6e9746
    resource: repo://supabase/migrations/0186_intake_reminder_24h_2h.sql
  - id: openwiki-source-bc8718c041f32374a84c610a
    resource: repo://supabase/migrations/0199_reminder_sms_candidate_selection.sql
  - id: openwiki-source-f58a47d39d34375783ab8f9b
    resource: repo://tests/app/cron-config.test.ts
  - id: openwiki-source-11160173fc6fe9706dbc1c2a
    resource: repo://tests/app/cron/reminder-heartbeat-wiring.test.ts
  - id: openwiki-source-ab7e3f5a60121e32abc13e2d
    resource: repo://tests/db/reminder-window-composition.db.test.ts
  - id: openwiki-source-dea5ed3bec7535c7dde9ac02
    resource: repo://tests/docs/reminder-cadence-truthfulness.test.ts
  - id: openwiki-source-8c8fd2ec5c4cb5c92190f668
    resource: repo://tests/lib/cron/reminder-heartbeat.test.ts
  - id: openwiki-source-55831e92f29f8b3e9d43f58b
    resource: repo://vercel.json
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Cron jobs, reminders and idempotency

Hone runs its time-driven work through five `GET` route handlers under `app/api/cron/`. They
share one authentication helper, use the service-role client, and protect every outbound
message with a **database claim** taken before the provider call. Two different schedulers
drive them, and that split is the most common source of confusion.

## 1. Routes, schedulers and status

| Route | Scheduler (declared) | Mutates? | Purpose |
|---|---|---|---|
| `/api/cron/appointment-reminders` | **External** every-15-minute job (not in `vercel.json`) | yes — sends email/SMS, writes claim/attempt columns | ~24h and ~2h reminder passes, email then SMS |
| `/api/cron/materialize-recurring-breaks` | Vercel Cron `0 8 * * *` | yes | materialize recurring-break occurrences; also runs the reminder-scheduler health check |
| `/api/cron/calendar-reconcile` | Vercel Cron `0 9 * * *` | gated | Google Calendar reconciliation sweep (see [Google Calendar](../integrations/google-calendar-sync.md)) |
| `/api/cron/calendar-sync` | Vercel Cron `30 9 * * *` | gated | Google Calendar outbound worker drain |
| `/api/cron/no-show-check` | **not scheduled** | **no** — disabled stub | returns `disabled: true`; auto no-show was removed |

Evidence: [`vercel.json` L1-L16](../../vercel.json#L1-L16) registers exactly the three daily
routes; [`lib/cron/reminder-schedule.ts` L12-L29](../../lib/cron/reminder-schedule.ts#L12-L29)
explains that the Vercel plan caps cron at once per day, so the 15-minute reminder cadence is
delivered by an external scheduler; [`tests/app/cron-config.test.ts` L34-L87](../../tests/app/cron-config.test.ts#L34-L87)
pins all of this (reminders and no-show **must not** appear in `vercel.json`, calendar crons must
be daily with reconcile before sync, no duplicate paths).
[`lib/cron/calendar-cron-schedule.ts`](../../lib/cron/calendar-cron-schedule.ts#L1-L23) holds
the two calendar schedule strings purely to pin `vercel.json` against drift — the routes never
read them, and registering a schedule does not enable sync.

### Authentication

Every route's first statement is `isAuthorizedCronRequest(req)`: it rejects when `CRON_SECRET`
is unset, when the `Authorization` header is missing, or when the header is not exactly
`Bearer <secret>`, using a length check plus `timingSafeEqual`
([`lib/cron/auth.ts` L17-L30](../../lib/cron/auth.ts#L17-L30)). Middleware lets
`/api/cron/` through unauthenticated precisely because each handler does this itself (see
[System overview](../architecture/system-overview.md)). A 401 happens before any admin
client, claim or heartbeat is touched.

## 2. The reminder pass (`appointment-reminders`)

[`app/api/cron/appointment-reminders/route.ts`](../../app/api/cron/appointment-reminders/route.ts)
runs four passes in order — email 24h, email 2h, SMS 24h, SMS 2h — then records a heartbeat
([L587-L661](../../app/api/cron/appointment-reminders/route.ts#L587-L661)).

### Windows and cadence

- Windows are closed intervals in minutes-from-now: **24h = [1380, 1500]**, **2h = [105, 135]**
  ([`reminder-schedule.ts` L35-L55](../../lib/cron/reminder-schedule.ts#L35-L55)).
- The reliability invariant: a window `W` minutes wide sampled every `P` minutes can only be
  missed when `W < P`. With `P = 15` the 30-minute 2h window covers every appointment minute
  offset even if one fire is skipped; an hourly cadence would miss 29 of 60 offsets
  ([L1-L10](../../lib/cron/reminder-schedule.ts#L1-L10), [L57-L91](../../lib/cron/reminder-schedule.ts#L57-L91);
  proved in [`cron-config.test.ts` L89-L99](../../tests/app/cron-config.test.ts#L89-L99) and
  [`reminder-cadence-truthfulness.test.ts` L129-L160](../../tests/docs/reminder-cadence-truthfulness.test.ts#L129-L160)).

### Selection

`loadAppointmentsForWindow` reads, via the service-role client, `confirmed` appointments whose
`*_sent_at` is null, whose `*_send_attempts` is below `MAX_ATTEMPTS = 3`, and whose `starts_at`
falls in the window — ordered by `starts_at`, **limited to 50 rows per pass**
([L33-L34](../../app/api/cron/appointment-reminders/route.ts#L33-L34),
[L66-L101](../../app/api/cron/appointment-reminders/route.ts#L66-L101)).

### The email pass: one claim owns the window

The ~24h / ~2h email may carry an intake-form CTA, but it is always **one** email claimed on
**one** slot (`reminder_24h` or `reminder_2h`). The six-case law
([L183-L204](../../app/api/cron/appointment-reminders/route.ts#L183-L204)):

| Studio reminder toggle | Intake reminders | Latest intake | Result |
|---|---|---|---|
| on | on | in progress | one reminder with intake CTA |
| on | on | complete / none | one plain reminder |
| on | off | (not read) | one plain reminder |
| off | on | in progress | one standalone intake reminder |
| off | on | complete / none | nothing, **no claim** (probe before claiming) |
| off | off | (not read) | nothing, no read, no claim |

Per row, in order ([L238-L438](../../app/api/cron/appointment-reminders/route.ts#L238-L438)):

1. Cheap guards (studio, client email, toggles); for "reminder off, intake on" an intake
   **probe** decides whether to claim at all, so a completed intake never burns an attempt.
2. `claimEmailSend` → `claim_email_send` RPC. A lost claim is a skip.
3. **Status re-read** after the claim: a row cancelled or no-showed since the query is skipped.
4. **Live intake re-read** (a second query, never the probe) decides the CTA; if the case
   flipped to "nothing to send", the claim is cleared via `record_email_result(false)`.
5. A fresh stateless HMAC cancellation token is minted for the `/cancel` and `/reschedule`
   links (appointment tokens are hash-only at rest); minting failure records a failure.
6. Send, then `record_email_result(success)`. Intake-link metadata is stamped **only** when a
   link was in an email that actually sent.
7. On failure at the third attempt, a `reminder_send_exhausted` warning ops alert is recorded
   with non-sensitive details only ([L123-L156](../../app/api/cron/appointment-reminders/route.ts#L123-L156)).

### The claim contract (migration `0080`, effective definition `0098`)

`claim_email_send(appointment, type)` is a single conditional `UPDATE` that increments the
attempt counter and stamps `*_claimed_at` **only if** the row is unsent, under 3 attempts, and
not holding a claim younger than 5 minutes; it returns whether exactly one row changed.
`record_email_result` stamps `*_sent_at` on success and clears the claim either way, without
touching the counter. Both are `SECURITY DEFINER` and executable by `service_role` only. The
contract was introduced by `0080`
([L1-L32](../../supabase/migrations/0080_email_send_claims.sql#L1-L32),
[L53-L102](../../supabase/migrations/0080_email_send_claims.sql#L53-L102),
[L106-L142](../../supabase/migrations/0080_email_send_claims.sql#L106-L142)); `0098` is the last
migration to redefine both functions — same predicate, plus the now-historical
`intake_reminder_7d` / `intake_reminder_3d` branches — and re-applies the service-role-only
grants ([`0098` L43-L164](../../supabase/migrations/0098_intake_reminder_columns.sql#L43-L164)).
The SMS pass uses the older `claim_sms_send` / `record_sms_result` pair (migration `0049`)
with its own columns.

**Delivery semantics an agent must preserve:**

- **At most one successful email and at most one successful SMS per appointment per window**,
  and the two channels are independent slots
  ([DB proof](../../tests/db/reminder-window-composition.db.test.ts#L266-L333),
  [SMS independence](../../tests/db/reminder-window-composition.db.test.ts#L461-L519)).
- **Retry up to 3 attempts, then stop silently except for the exhaustion alert**
  ([DB proof](../../tests/db/reminder-window-composition.db.test.ts#L335-L380)).
- **Not exactly-once on crash.** A claim older than 5 minutes is reclaimable. If a process dies
  after the provider accepted the message but before `record_*_result`, a later run can send
  again. The claim prevents *concurrent* duplicates, not crash-window duplicates.
- **Starvation is possible.** The fixed 50-row page is ordered by `starts_at`; rows the route
  skips *without* claiming (for example an SMS candidate with no consent) keep their
  eligibility and their sort position. See §5 for the database-side fix that exists but is not
  wired.

### The SMS pass

`sendSmsReminderPass` re-queries on the `sms_reminder_*` columns, skips without a claim when the
studio's SMS toggle is off or the client lacks phone / consent / has opted out, re-reads status,
composes the intake CTA into the **same** SMS (there is no standalone intake SMS), mints a
`/manage` token, and hands off to `lib/sms/send-appointment.ts`, whose `sendOne` runs the
consent gate, takes the SMS claim, posts to Twilio and always records the result in `finally`
([route L444-L585](../../app/api/cron/appointment-reminders/route.ts#L444-L585);
[`sendOne` L369-L459](../../lib/sms/send-appointment.ts#L369-L459)). Provider, consent and STOP
details are on [SMS delivery](sms-consent-stop-and-senders.md).

### Intake reminders (migration `0186`)

`0186` retired the 7-day / 3-day intake reminder cadence in favour of composing the intake CTA
into the ~24h/~2h window email, adding exactly one column, `studios.send_intake_reminders`
(default `true` so the apply changed no studio's behaviour). The `0098` 7d/3d columns and claim
branches are **retained as history**, not reused
([`0186`](../../supabase/migrations/0186_intake_reminder_24h_2h.sql#L1-L77)).

## 3. Failure visibility: ops alerts and the scheduler heartbeat

- **`recordOpsAlert`** never throws; it always writes a structured stderr line, then inserts a
  redacted row into `public.ops_alerts` through the service-role client, and critical alerts
  are additionally emailed via a separate bare Resend client
  ([`lib/ops/alerts.ts` L9-L46](../../lib/ops/alerts.ts#L9-L46),
  [L106-L200](../../lib/ops/alerts.ts#L106-L200)). A thrown reminder run records a **critical**
  `cron_route_failed` and returns 500 ([route L662-L681](../../app/api/cron/appointment-reminders/route.ts#L662-L681)).
- **A stopped external scheduler produces silence, not an error.** So a successful run writes a
  single overwritten Upstash key `reminder_cron:last_success` (24h TTL) with aggregate counts
  only — best-effort and fail-open
  ([`lib/cron/reminder-heartbeat.ts` L7-L42](../../lib/cron/reminder-heartbeat.ts#L7-L42)).
- Health thresholds derive from the cadence: **degraded > 30 min** (2× cadence, where the 2h
  window loses coverage margin), **stale > 45 min** (3×), **missing** when absent/invalid, and a
  future-dated value beyond 5 minutes is not trusted ([L44-L80](../../lib/cron/reminder-heartbeat.ts#L44-L80)).
- `/admin` reads and classifies the heartbeat on render **without writing**
  ([`app/admin/page.tsx` L233-L240](../../app/admin/page.tsx#L233-L240)). Alerting happens from the
  **daily Vercel crons**, which call `recordReminderSchedulerHealthAlert()` in a `finally` that can
  neither mask nor fake their own result
  ([`materialize-recurring-breaks` L190-L219](../../app/api/cron/materialize-recurring-breaks/route.ts#L190-L219));
  the alert dedupes on an unresolved row, only `degraded` is a warning, and stale/missing are
  critical so they email ([wiring tests](../../tests/app/cron/reminder-heartbeat-wiring.test.ts#L121-L199)).

## 4. The other routes

- **`materialize-recurring-breaks`** reads every active `studio_recurring_break_rules` row and
  calls `materialize_recurring_break_rule(rule, horizon_end)` per rule, with the horizon computed
  in the studio's timezone as the maximum public booking horizon + 14 days; `23P01` exclusion
  conflicts are logged as conflicts and summarized in one warning alert
  ([route](../../app/api/cron/materialize-recurring-breaks/route.ts)). See
  [Availability, slots, buffers and timezones](../scheduling/availability-slots-buffers-and-timezones.md).
- **`no-show-check`** is a non-mutating stub: the old `starts_at + 30 min` heuristic flipped
  attended appointments to no-show, so the endpoint now only authenticates and reports
  `disabled: true`; no-show is a practitioner action via `mark_appointment_no_show`
  ([route L1-L55](../../app/api/cron/no-show-check/route.ts#L1-L55)).
- **`calendar-sync` / `calendar-reconcile`** are registered but gated by the Google Calendar
  worker flag and per-studio intent flags; see [Google Calendar](../integrations/google-calendar-sync.md).

## 5. Lifecycle status (dated, with authority)

| Fact | Status | Authority |
|---|---|---|
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L846-L861] heading anchor "L846-L861" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
| Reminder route reached by the external scheduler at a ~15-minute cadence with HTTP 200 | **Production exercised, observed 2026-08-12** (read-only request logs; no authenticated invocation made) | [`current-state.md` L846-L861](../../docs/production/current-state.md#L846-L861) |
<!-- openwiki: broken internal link [../../docs/08_EMAIL_SMS_AND_CRON.md#L262-L277] heading anchor "L262-L277" does not exist in "../../docs/08_EMAIL_SMS_AND_CRON.md". Fix the href or restore the target, then delete this comment. -->
| Scheduler account owner, backup owner, single-job confirmation, alert owner, admin card read as Healthy | **Unverified** — "running in production, ownership unattested" | same; register in [`docs/08` L262-L277](../../docs/08_EMAIL_SMS_AND_CRON.md#L262-L277), kept unchecked by [`reminder-cadence-truthfulness.test.ts` L162-L209](../../tests/docs/reminder-cadence-truthfulness.test.ts#L162-L209) |
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L863-L869] heading anchor "L863-L869" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
| Intake reminders at ~24h/~2h (`0186`) | **Migration applied and verified 2026-08-24** | [`current-state.md` L863-L869](../../docs/production/current-state.md#L863-L869) |
<!-- openwiki: broken internal link [../../docs/production/current-state.md#L871-L873] heading anchor "L871-L873" does not exist in "../../docs/production/current-state.md". Fix the href or restore the target, then delete this comment. -->
| SMS reminders | **Pilot scale only**, env-gated, per-studio toggle, per-client consent | [`current-state.md` L871-L873](../../docs/production/current-state.md#L871-L873) |
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L504-L594] heading anchor "L504-L594" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
| Bounded SMS candidate selection (`0199`) | **Migration applied 2026-09-18; application consumer (PR #716) NOT merged** | [`migration-ledger.md` L504-L594](../../docs/production/migration-ledger.md#L504-L594) |

The `0199` row is the sharpest lifecycle example in this area: `reminder_sms_candidates`,
`reminder_sms_unroutable_studios` and the `reminder_sms_eligible_appointments` view exist in the
repository and (per the ledger) in production, but **no file under `app/` or `lib/` calls them**;
the SMS reminder pass still uses the 50-row TypeScript selection above. `0199` describes itself
as a candidate filter, never send authority
([`0199` L1-L73](../../supabase/migrations/0199_reminder_sms_candidate_selection.sql#L1-L73)).

## 6. Change checklist

- Changing cadence or windows: edit `lib/cron/reminder-schedule.ts` only; the coverage
  invariant, the heartbeat thresholds and the docs guard all derive from it.
- Adding a cron route: authenticate first with `isAuthorizedCronRequest`; decide whether it
  belongs in `vercel.json` (daily only on the current plan) and update `cron-config.test.ts`.
- Adding a claimable send: claim before the provider call, record after, and never reuse a
  retired column with a different meaning.
- Never log or alert with client contact data, tokens, URLs or the cron secret; route alerts
  through `recordOpsAlert`, which redacts centrally.

## 7. Contradictions and open questions

1. **`0199`'s header describes a send path this tree does not have.** It says every selected
   appointment still passes "the unchanged send law in `sendOne`: consent / studio toggle / STOP,
   then `resolve_active_studio_sms_sender` AGAIN … and only then claim"
   ([`0199` L47-L66](../../supabase/migrations/0199_reminder_sms_candidate_selection.sql#L47-L66)).
   The `sendOne` in this tree runs the consent gate, claims, and posts through the platform
   sender without resolving a studio sender
   ([`lib/sms/send-appointment.ts` L369-L459](../../lib/sms/send-appointment.ts#L369-L459)). The
   comment matches the unmerged PR #716, not the merged code.
2. **The starvation defect `0199` was written to close is still live in the merged route**: the
   SMS pass selects a fixed 50-row page by `starts_at`
   ([route L66-L84](../../app/api/cron/appointment-reminders/route.ts#L66-L84)) and skips
   unsendable rows without claiming them.
3. **A code comment calls the crons dormant.** `next.config.ts` says Vercel cron monitors give
   signals "once the (currently dormant) cron jobs activate"
   ([L136-L139](../../next.config.ts#L136-L139)), while the canonical record says the reminder
   route was observed running in production and the daily crons are registered.
4. **Which external scheduler and who owns it** is outside the repository. Code comments name a
   specific hosted cron service; the authority records only that it fires and that ownership is
   unattested.
