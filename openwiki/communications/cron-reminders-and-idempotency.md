---
type: operations
title: Cron jobs, reminders and idempotency
description: The five /api/cron routes, which scheduler drives each and how they authenticate; the ~24h/~2h reminder pass with its one-claim-per-window email law, retry and exhaustion semantics and what can still double-send; the external-scheduler heartbeat and ops alerts; the other cron routes; and the lifecycle state of each piece, pointing to the canonical record rather than restating dated observations.
tags: [cron, reminders, idempotency, email, sms, ops-alerts, scheduler]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
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
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Cron jobs, reminders and idempotency

Hone runs its time-driven work through five `GET` route handlers under `app/api/cron/`. They share one
authentication helper, use the service-role client, and protect every outbound message with a **database
claim taken before the provider call**. Two different schedulers drive them, and that split is the most
common source of confusion.

## 1. Routes and schedulers

| Route | Scheduler | Mutates? | Purpose |
|---|---|---|---|
| `/api/cron/appointment-reminders` | **an external every-15-minute job**, not `vercel.json` | yes: sends email and SMS, writes claim and attempt columns | the ~24h and ~2h reminder passes |
| `/api/cron/materialize-recurring-breaks` | Vercel Cron, daily | yes | materializes recurring-break occurrences; also runs the reminder-scheduler health check |
| `/api/cron/calendar-reconcile` | Vercel Cron, daily | gated | Google Calendar reconciliation (see [Google Calendar](../integrations/google-calendar-sync.md)) |
| `/api/cron/calendar-sync` | Vercel Cron, daily | gated | Google Calendar outbound worker drain |
| `/api/cron/no-show-check` | **not scheduled** | **no** | a disabled stub that reports `disabled: true` |

[`vercel.json`](../../vercel.json#L1-L16) registers exactly the three daily routes. The plan caps Vercel cron at
once a day, so the 15-minute reminder cadence comes from an external scheduler
([`lib/cron/reminder-schedule.ts` L12-L33](../../lib/cron/reminder-schedule.ts#L12-L33)).
[`tests/app/cron-config.test.ts`](../../tests/app/cron-config.test.ts#L34-L87) pins this: reminders and no-show
must not be in `vercel.json`, the calendar crons must be daily with reconcile before sync, and no path may be
duplicated.

**Authentication.** Every route's first statement is `isAuthorizedCronRequest(req)`. It rejects when
`CRON_SECRET` is unset, when the `Authorization` header is missing, or when the header is not exactly
`Bearer <secret>`, using a length check and then `timingSafeEqual`
([`lib/cron/auth.ts` L17-L30](../../lib/cron/auth.ts#L17-L30)). Middleware lets `/api/cron/` through
unauthenticated precisely because each handler does this itself, and a 401 happens before any admin client,
claim or heartbeat is touched.

## 2. The reminder pass

[`app/api/cron/appointment-reminders/route.ts`](../../app/api/cron/appointment-reminders/route.ts) runs four passes
in order (email 24h, email 2h, SMS 24h, SMS 2h) and records a heartbeat only after all four complete
([L587-L681](../../app/api/cron/appointment-reminders/route.ts#L587-L681)).

**Windows and cadence.** Windows are closed intervals in minutes from now: **24h = [1380, 1500]** and
**2h = [105, 135]**. A window `W` minutes wide sampled every `P` minutes can only miss an appointment when
`W < P`, so the 15-minute cadence covers every minute offset of the 30-minute 2h window, which an hourly cadence
would not ([L35-L91](../../lib/cron/reminder-schedule.ts#L35-L91),
[`cron-config.test.ts` L89-L99](../../tests/app/cron-config.test.ts#L89-L99)).

**Selection.** `loadAppointmentsForWindow` reads, through the service-role client, `confirmed` appointments
whose `*_sent_at` is null, whose `*_send_attempts` is below `MAX_ATTEMPTS = 3` and whose `starts_at` is in the
window, ordered by `starts_at` and **limited to 50 rows per pass**
([L33-L34](../../app/api/cron/appointment-reminders/route.ts#L33-L34),
[L66-L101](../../app/api/cron/appointment-reminders/route.ts#L66-L101)).

### The email pass: one claim owns the window

The window email may carry an intake-form call to action, but it is always **one** email claimed on **one**
slot (`reminder_24h` or `reminder_2h`). The six-case law
([L183-L204](../../app/api/cron/appointment-reminders/route.ts#L183-L204)):

| Studio reminder toggle | Intake reminders | Latest intake | Result |
|---|---|---|---|
| on | on | in progress | one reminder with the intake call to action |
| on | on | complete or none | one plain reminder |
| on | off | not read | one plain reminder |
| off | on | in progress | one standalone intake reminder |
| off | on | complete or none | nothing, and **no claim** (a probe runs before claiming) |
| off | off | not read | nothing, no read, no claim |

Per row ([L238-L438](../../app/api/cron/appointment-reminders/route.ts#L238-L438)):

1. cheap guards (studio, client email, toggles), plus an intake **probe** for "reminder off, intake on", so a
   completed intake never burns an attempt;
2. `claim_email_send`; a lost claim is a skip;
3. a **status re-read** after the claim, so a row cancelled since the query is skipped;
4. a **live intake re-read** that decides the call to action; if the case flipped to "nothing to send", the
   claim is cleared with `record_email_result(false)`;
5. a fresh stateless HMAC token for the `/cancel` and `/reschedule` links (appointment tokens are hash-only at
   rest);
6. send, then `record_email_result(success)`; intake-link metadata is stamped only when a link was in an email
   that actually sent;
7. on failure at the third attempt, a `reminder_send_exhausted` warning ops alert with non-sensitive details only
   ([L123-L156](../../app/api/cron/appointment-reminders/route.ts#L123-L156)).

### The claim contract

`claim_email_send(appointment, type)` is one conditional `UPDATE` that increments the attempt counter and
stamps `*_claimed_at` **only if** the slot is unsent, under three attempts and not holding a claim younger than
five minutes. `record_email_result` stamps `*_sent_at` on success and clears the claim either way. Both are
`SECURITY DEFINER` and executable by `service_role` only. `0080` introduced the contract
([L1-L32](../../supabase/migrations/0080_email_send_claims.sql#L1-L32)) and `0098` holds the latest definitions
and grants ([`0098` L43-L164](../../supabase/migrations/0098_intake_reminder_columns.sql#L43-L164)). The SMS pass
uses the older `claim_sms_send` / `record_sms_result` pair with its own columns.

**Delivery semantics to preserve:**

- **At most one successful email and at most one successful SMS per appointment per window**, as independent
  slots ([DB proof](../../tests/db/reminder-window-composition.db.test.ts#L202-L333),
  [SMS independence](../../tests/db/reminder-window-composition.db.test.ts#L461-L519)).
- **Retry up to three attempts**, then stop, with only the exhaustion alert
  ([DB proof](../../tests/db/reminder-window-composition.db.test.ts#L335-L380)).
- **Not exactly-once on a crash.** A claim older than five minutes is reclaimable, so a process that dies after
  the provider accepted the message but before `record_*_result` can be followed by a second send. The claim
  prevents concurrent duplicates, not crash-window duplicates.
- **Starvation is possible.** The fixed 50-row page is ordered by `starts_at`; a row skipped *without* a claim
  (an SMS candidate without consent, say) keeps its eligibility and its sort position.

### The SMS pass

`sendSmsReminderPass` re-queries on the `sms_reminder_*` columns, skips without a claim when the studio's SMS
toggle is off or the client lacks a phone or consent or has opted out, re-reads status, composes any intake call
to action into the **same** SMS, mints a `/manage` token, and hands off to `sendOne` in
`lib/sms/send-appointment.ts`. `sendOne` runs the consent gate, takes the SMS claim, posts to Twilio and always
records the result in `finally` ([route L444-L585](../../app/api/cron/appointment-reminders/route.ts#L444-L585),
[`sendOne` L369-L459](../../lib/sms/send-appointment.ts#L369-L459)). Provider, consent and STOP details are on
[SMS delivery](sms-consent-stop-and-senders.md).

### Intake reminders (`0186`)

`0186` retired the 7-day and 3-day intake reminders in favour of composing the intake call to action into the
~24h/~2h window email. It added exactly one column, `studios.send_intake_reminders` (default `true`), and keeps
the `0098` 7d/3d columns and claim branches as history ([`0186`](../../supabase/migrations/0186_intake_reminder_24h_2h.sql#L1-L77)).

## 3. Failure visibility

- **`recordOpsAlert`** never throws. It writes a structured stderr line, inserts a redacted `ops_alerts` row
  through the service-role client, and emails critical alerts through a separate alert-email path
  ([`lib/ops/alerts.ts` L9-L46](../../lib/ops/alerts.ts#L9-L46), [L106-L200](../../lib/ops/alerts.ts#L106-L200)).
  A thrown reminder run records a **critical** `cron_route_failed` and returns 500.
- **A stopped external scheduler produces silence, not an error**, so a successful run writes one overwritten
  Upstash key, `reminder_cron:last_success`, with a 24-hour TTL and aggregate counts only, best-effort and
  fail-open ([`lib/cron/reminder-heartbeat.ts` L7-L42](../../lib/cron/reminder-heartbeat.ts#L7-L42)).
- Health thresholds derive from the cadence: **degraded** beyond 2× (30 minutes), **stale** beyond 3×
  (45 minutes), **missing** when absent, and a value more than five minutes in the future is not trusted
  ([L44-L80](../../lib/cron/reminder-heartbeat.ts#L44-L80),
  [test L36-L54](../../tests/lib/cron/reminder-heartbeat.test.ts#L36-L54)).
- `/admin` reads and classifies the heartbeat without writing
  ([`app/admin/page.tsx` L233-L240](../../app/admin/page.tsx#L233-L240)). Alerting comes from the **daily Vercel
  crons**, which call `recordReminderSchedulerHealthAlert()` in a `finally` that can neither mask nor fake
  their own result ([`materialize-recurring-breaks` L190-L219](../../app/api/cron/materialize-recurring-breaks/route.ts#L190-L219),
  [wiring tests](../../tests/app/cron/reminder-heartbeat-wiring.test.ts#L97-L199)).

## 4. The other routes

- **`materialize-recurring-breaks`** materializes every active `studio_recurring_break_rules` row through
  `materialize_recurring_break_rule`, up to a studio-local horizon of the maximum public booking horizon plus
  14 days. `23P01` exclusion conflicts are expected conflicts, summarized in one warning alert
  ([L39](../../app/api/cron/materialize-recurring-breaks/route.ts#L39-L39),
  [L67-L160](../../app/api/cron/materialize-recurring-breaks/route.ts#L67-L160)). See
  [Availability, slots, buffers and timezones](../scheduling/availability-slots-buffers-and-timezones.md).
- **`no-show-check`** is a non-mutating stub. The old `starts_at + 30 min` heuristic flipped attended
  appointments to no-show, so the endpoint now only authenticates and reports `disabled: true`; no-show is a
  practitioner action ([L1-L55](../../app/api/cron/no-show-check/route.ts#L1-L55)).
- **`calendar-sync` / `calendar-reconcile`** are registered but gated by the Google Calendar worker switch and
  per-studio flags.

## 5. Lifecycle state, with the record that holds it

| Fact | State | Record |
|---|---|---|
| Reminder route fired by the external scheduler | **production exercised**, observed from read-only request logs; no authenticated invocation was made | [`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications) |
| Scheduler account owner, backup owner, single job, alert owner, admin card read as Healthy | **unverified**: "running in production, ownership unattested" | the register in [`docs/08` § Scheduler ownership register](../../docs/08_EMAIL_SMS_AND_CRON.md#scheduler-ownership-register--unverified-fill-in-by-hand), which a docs guard keeps unchecked ([L162-L209](../../tests/docs/reminder-cadence-truthfulness.test.ts#L162-L209)) |
| Intake reminders at ~24h/~2h (`0186`) | **migration applied and verified** | [`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications) |
| Bounded SMS candidate selection (`0199`) | **migration applied; its application consumer (PR #716) not merged** | [migration ledger, post-0199 block](../../docs/production/migration-ledger.md#previous-state-verified-2026-09-18-post-0199-apply-0199-applied) |

`0199` is the sharpest example here: `reminder_sms_candidates`, `reminder_sms_unroutable_studios` and the
`reminder_sms_eligible_appointments` view exist in the repository and, per the ledger, in production, but **no
file under `app/` or `lib/` calls them** at this source head; the SMS pass still uses the 50-row TypeScript
selection. `0199` describes itself as a candidate filter, never send authority
([`0199` L1-L73](../../supabase/migrations/0199_reminder_sms_candidate_selection.sql#L1-L73)).

## 6. Change checklist

- Changing cadence or windows: edit `lib/cron/reminder-schedule.ts` only; the coverage invariant, the
  heartbeat thresholds and the docs guard derive from it.
- Adding a cron route: authenticate first with `isAuthorizedCronRequest`, decide whether it belongs in
  `vercel.json` (daily only on the current plan), and update `cron-config.test.ts`.
- Adding a claimable send: claim before the provider call, record after, and never reuse a retired column with a
  different meaning.
- Never log or alert with client contact data, tokens, URLs or the cron secret; route alerts through
  `recordOpsAlert`, which redacts centrally.

## 7. Contradictions and open questions

1. **`0199`'s header describes a send path this tree does not have.** It says every selected appointment still
   passes a `sendOne` that resolves the active studio SMS sender again before claiming
   ([`0199` L47-L66](../../supabase/migrations/0199_reminder_sms_candidate_selection.sql#L47-L66)). The `sendOne` in
   this tree runs the consent gate, claims and posts through the platform sender without resolving a studio
   sender ([`send-appointment.ts` L369-L459](../../lib/sms/send-appointment.ts#L369-L459)). The comment matches the
   unmerged PR #716, not the merged code.
2. **The starvation defect `0199` was written to close is still live** in the merged route: the SMS pass selects
   a fixed 50-row page by `starts_at` ([route L66-L84](../../app/api/cron/appointment-reminders/route.ts#L66-L84))
   and skips unsendable rows without claiming them.
3. **A code comment calls the crons dormant.** `next.config.ts` says Vercel cron monitors give signals "once the
   (currently dormant) cron jobs activate" ([L136-L139](../../next.config.ts#L136-L139)), while the canonical
   record says the reminder route runs in production and the daily crons are registered.
4. **Which external scheduler, and who owns it,** is outside the repository. Code comments name a hosted cron
   service; the authority records only that the route fires and that ownership is unattested.
