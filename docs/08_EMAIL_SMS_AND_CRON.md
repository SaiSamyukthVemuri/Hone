# 08 Email, SMS, and cron

## Email (Resend)

Provider: Resend. From-address pattern: `<Studio name> via hone <hello@hone.care>` for transactional client mail; owner notifications come from the same studio surface.

### Templates

| Template | Sender | Triggered by |
|---|---|---|
| Booking confirmation | Client | Public + practitioner booking actions |
| Booking notification | Studio owner | Same booking actions (gated by `notify_practitioner_on_new_booking`, PR #47) |
| 24h reminder | Client | Cron route `/api/cron/appointment-reminders` |
| 2h reminder | Client | Same cron route |
| Cancellation notification | Studio owner | Client public cancel action |
| Cancellation confirmation | Client | Practitioner cancel action |
| Reschedule confirmation | Client | Public reschedule action |
| No-show follow-up | Client | Practitioner Mark no-show action |
| Postcare | Client | Manual practitioner click on session detail |
| Portal magic link | Client | `requestPortalMagicLinkAction` |
| Portal message notification | Client | Practitioner sends portal message |
| Portal reply notification | Studio owner | Client replies in portal (PR #129) |
| Intake update request | Client | Practitioner re-issues an intake |

### Pre-appointment instructions (PR #160)

Booking confirmation + 24h + 2h reminder emails render a per-service `Before your appointment` block sourced from `services.pre_care_instructions` (nullable text, migration 0025). The studio edits it from `Settings → Services` per service; the same field also feeds the portal Care instructions section (PR #159), so a single edit reaches both surfaces.

Prior to PR #160 the confirmation template also rendered a hardcoded "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph above the editable block. That constant was removed so the studio owns the wording end to end. When a service has no prep text set, the block is omitted entirely from the email (no leftover heading, no empty card).

The threading lives in `lib/email/send-appointment.ts`: the booking action selects `services(name, default_duration_minutes, pre_care_instructions)`, threads `preCareInstructions: service?.pre_care_instructions ?? null` into the template props, and the template's conditional block does the rest. Reminder templates use the same shape and were already on the editable-only path before PR #160; the file `tests/lib/email/prep-instructions.test.ts` pins both behaviors.

### Email send tracking

Appointment rows carry attempt counters and stamped timestamps:
- `confirmation_send_attempts` + `confirmation_sent_at`
- `reminder_24h_send_attempts` + `reminder_24h_sent_at`
- `reminder_2h_send_attempts` + `reminder_2h_sent_at`
- `no_show_email_send_attempts` + `no_show_email_sent_at`
- `postcare_email_send_attempts` + `postcare_email_sent_at`

Truthful-reporting rule: stamp the `*_sent_at` **only** when the Resend call actually delivered. The 3-strike pattern is on every transactional path: each attempt increments `_attempts`; once Resend confirms success the `_sent_at` is set; if attempts exceed 3 without delivery the cron stops retrying and logs a sanitized failure for the operator.

### Reminder email claim (PR #189, migration 0080)

The double-send gap is closed. The reminder cron now claims each row via `claim_email_send(appointment_id, email_type)` BEFORE calling Resend: one conditional UPDATE that increments the attempts counter and stamps the matching `*_claimed_at`, gated on sent-is-null, attempts under the 3-strike cap, and no fresh claim (claims older than 5 minutes are stale and reclaimable, so a crashed sender never permanently blocks a row). Two overlapping cron runs can no longer both send; the loser counts the row as `skipped` in the response stats. Outcomes are recorded via `record_email_result` (stamps `*_sent_at` on success, clears the claim, never increments). Both RPCs are SECURITY DEFINER with locked search_path, `revoke from public/anon/authenticated`, execute granted to `service_role` only. This mirrors the SMS `claim_sms_send` / `record_sms_result` pair from migration 0049. The unclaimed one-shot paths (booking confirmation, reschedule notices, no-show cron, postcare) keep using `record_email_attempt` (0028); they run inside a single user request and do not race a scheduler.

## SMS (Twilio)

### Posture

- **Default off.** `studios.send_*_sms` columns default `false`. Toggling on requires a SQL update (the practitioner UI does not toggle this yet).
- **Per-client consent required.** `clients.sms_consent_at` must be set AND `clients.sms_opted_out_at` must be null.
- **Per-environment gate.** Missing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` makes the SMS helper return `ok: false` cleanly; the booking continues.
- **Test exposure.** SMS is not exercised in this pilot beyond manual smoke. Real production SMS would need real Twilio test runs.

### Outgoing message types

| Type | Body shape |
|---|---|
| Booking confirmation | Studio name + service + formatted starts-at + manage link |
| 24h reminder | Same shape, shorter; ends with policy reminder if studio has policy text |
| 2h reminder | Time + manage link only |

The 24h / 2h reminders use a single `manage/<token>` link (the neutral entry point) rather than separate cancel + reschedule, per Sam's direction to keep SMS from actively inviting cancellation.

### STOP webhook

Endpoint: `/api/twilio/inbound-sms`.

- Verifies the Twilio signature using `TWILIO_WEBHOOK_BASE_URL` to build the canonical signed URL. Falls back to `request.url` when unset.
- Idempotent: writes `clients.sms_opted_out_at` only when currently null.
- Generic response regardless of whether the number was known to Hone.

### SMS RPC grants hardened (PR #141 / migration 0062)

`claim_sms_send` and related SMS RPCs are `revoke from public, anon, authenticated; grant to service_role only`. The action layer always invokes via `createAdminClient()`. Audit grep on every caller is part of the PR template's security checklist.

## Cron

**Cron scheduling (PR #258).** Previously the schedule lived outside the repo (an external `cron-job.org` dashboard) while `vercel.json` had an empty `"crons": []`, so every active route was unscheduled in-repo. PR #258 moves what the plan allows into `vercel.json` and pins the rest. **The production Vercel plan caps cron cadence at once-per-day**, so a `*/15` reminder cron is rejected at deploy time — the appointment-reminders route therefore stays on an **external every-15-minute scheduler** (cron-job.org) for now, while the **daily** `materialize-recurring-breaks` cron lives in `vercel.json`. Both paths send/validate `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron attaches it automatically; the external scheduler is configured to send it; `lib/cron/auth.ts` validates either). The cadence + reminder windows are a single source of truth in `lib/cron/reminder-schedule.ts`, shared by the route and the invariant tests so they cannot drift.

**Schedules:**

| Route | How it is scheduled |
|---|---|
| `/api/cron/appointment-reminders` | **External scheduler (cron-job.org), `GET` every 15 min** with `Authorization: Bearer $CRON_SECRET`. (NOT in `vercel.json` — `*/15` exceeds the current plan's once-per-day cron cap. If the project moves to Vercel Pro, add `{ "path": "/api/cron/appointment-reminders", "schedule": "*/15 * * * *" }` to `vercel.json` and drop the external job — that schedule string is `APPOINTMENT_REMINDER_CRON_SCHEDULE`.) |
| `/api/cron/materialize-recurring-breaks` | **Vercel Cron, `vercel.json`, `0 8 * * *`** (daily, 08:00 UTC — allowed on every plan). |
| `/api/cron/no-show-check` | **intentionally NOT scheduled** (disabled, non-mutating stub). |

**Reminder schedule/window compatibility (why every 15 min):** a reminder window `W` minutes wide, sampled by a cron firing every `P` minutes, is only missable when `W < P` (a closed window of width `≥ P` always contains a point of the `P`-minute grid). The 24h window is `[23h, 25h]` (120 min, safe at any cadence). The 2h window is `[105, 135]` (30 min) — at the old assumed **hourly** cadence (`P = 60`) a 30-min window silently misses ~half of all appointment minute offsets; at every-15-minutes (`P = 15`) `W = 30 = 2·P`, so every appointment is eligible at least once **and** a single skipped fire still leaves a grid point in-window. So the external scheduler MUST be configured at ≤15-minute cadence (the `reminder-schedule` invariant assumes it). `tests/lib/cron/reminder-schedule.test.ts` proves every minute offset 0–59 is covered at 15-min cadence and that the hourly + 30-min combination fails; `tests/app/cron-config.test.ts` pins the `vercel.json` config + the required cadence. **Max-attempt posture:** after a reminder fails `MAX_ATTEMPTS` (3) it is filtered out of the window query; PR #258 emits a `reminder_send_exhausted` ops alert (warning) with non-sensitive metadata only (studio_id, appointment_id, reminder_type, attempt_count, retryable, reason — no client email/phone/notes/token/free-text). The route also re-checks appointment `status='confirmed'` immediately before sending (both the email and SMS passes) so a reminder is never sent for an appointment cancelled after the window query. Live payments remain disabled.

Routes:

| Route | Status | Should be scheduled? | What it does |
|---|---|---|---|
| `/api/cron/appointment-reminders` | Active, mutating | **Yes — external scheduler, every 15 min** (not in `vercel.json`; plan caps cron at daily) | Picks up confirmed appointments due in ~24h or ~2h, sends reminder email + SMS where eligible, increments attempts, stamps `_sent_at` on success. Bounded per-run (`PER_RUN_LIMIT = 50`). 3-strike per row. Window/cadence compatibility + max-attempt alert + status re-check per PR #258 (above). |
| `/api/cron/materialize-recurring-breaks` | Active, mutating | **Yes, daily** | Daily rolling-horizon refresh for recurring break occurrences. For every active `studio_recurring_break_rules` row, materializes missing occurrences from today (in the studio's local tz) through today + ~186 days (covers the 6-month maximum public booking horizon). The underlying RPC uses `ON CONFLICT DO NOTHING` so repeated runs are idempotent. **If this is not scheduled, recurring-break availability drifts: the studio's break windows stop appearing on public booking and the calendar as the rolling horizon advances.** |
| `/api/cron/no-show-check` | **Disabled (non-mutating)** | **No** | The previous implementation auto-flipped confirmed appointments to no_show after `starts_at + 30min`. That heuristic was unsafe (treatment sessions run long; no manual-complete UI existed) and the route is now non-mutating. The first safe no-show path is the practitioner-initiated `mark_appointment_no_show` RPC via the calendar lifecycle UI. **Do not re-enable this cron without a deliberate PR following the design constraints in `app/api/cron/no-show-check/route.ts` source comments.** |

### `CRON_SECRET`

Every `/api/cron/*` route validates `Authorization: Bearer $CRON_SECRET` before doing anything. Missing or wrong secret → `401`. Generate with `openssl rand -hex 32`. Required in production.

### Ops alerts (PR #153)

When an email or SMS send gives up (final-attempt non-retryable failure OR attempt counter reaches 3), `logEmailFailure` / `logSmsFailure` now ALSO record a durable row in the `ops_alerts` table via `recordOpsAlert`. The helper never throws to the caller, so the booking / reminder / postcare path that triggered the log is not affected by alerting failures.

**Alert message redaction (PR #285).** Cron / email / SMS alert call sites that pass a provider `error.message` (e.g. `cron_route_failed`) are safe by default: `recordOpsAlert` now runs `redactOpsAlertMessage` (`lib/ops/redact.ts`) on the message before the stderr log, the `ops_alerts` row, the admin page, and the critical email — scrubbing email/phone/CRON_SECRET/Bearer tokens/JWTs/signed URLs/storage paths/Stripe secrets while preserving safe ids (non-secret Stripe object ids, UUIDs). See docs/03 §ops_alerts.

**Critical-alert delivery is production-gated (PR #291).** Critical ops alerts email the recipients in `OPS_ALERT_EMAILS` via `lib/ops/alert-email.ts` (after the durable row, never throws). Because an unset/empty `OPS_ALERT_EMAILS` makes that email a silent no-op (the alert then lives only as a DB row + `/admin/ops-alerts`), **`OPS_ALERT_EMAILS` is now REQUIRED in production**: the env gate `scripts/check-production-env-gates.mjs` (wired into `npm run build`) fails the production build if it does not list ≥1 recipient (whitespace-only / comma-only counts as none). Enforced only when `VERCEL_ENV === "production"`; local/CI/preview SKIP. Names-only output — the addresses are never printed. This is delivery-config verification only: no alert is sent at build time, and the reminder/email/cron runtime is unchanged.

Events:

- `email_send_gave_up` (warning): emitted from `logEmailFailure` when the email send is non-retryable OR attempt_number >= 3. The ops helper does not dispatch operator email at all in PR #153 (deferred), so the give-up alert lives purely as a `ops_alerts` row + stderr log.
- `sms_send_failed` (warning): emitted from `logSmsFailure` under the same threshold.
- `cron_route_failed` (critical): emitted from the catch block at the top of `/api/cron/appointment-reminders/route.ts` and `/api/cron/materialize-recurring-breaks/route.ts`.
- `recurring_break_materialization_failures` (warning): emitted once per run when at least one rule failed.
- `reminder_scheduler_stale` (warning) / `reminder_scheduler_missing` (critical) — **PR #283**: recorded by the daily `materialize-recurring-breaks` cron's best-effort scheduler-health check (`recordReminderSchedulerHealthAlert`, `lib/cron/reminder-heartbeat.ts`) when the external every-15-min reminder scheduler's heartbeat is stale (>45 min) or missing (no recorded run). Deduped on an existing unresolved `ops_alerts` row for the same event, so repeated daily checks never spam. `safe_details` carry only `status`, `last_success_at`, `age_minutes`, `cadence_minutes`, `stale_after_minutes`, `checked_at` — never `CRON_SECRET`, an Authorization header, client phone/email/PII, reminder contents, or a provider payload. The check NEVER sends reminders and never calls `/api/cron/appointment-reminders`.

The no-show-check route is intentionally non-mutating (responds with `{ ok: true, disabled: true }`) and does NOT emit cron alerts.

### Operational expectations

- **`appointment-reminders` schedule drift**: if the scheduler stops hitting this route, the 24h and 2h reminder emails stop going out. The per-row 3-strike attempts counter caps the retry blast radius once the scheduler resumes, but real reminders will be missed in the meantime.
- **`materialize-recurring-breaks` schedule drift**: if the scheduler stops hitting this route, recurring break occurrences are NOT materialized for newly-extended horizon days. Public booking eventually starts offering slots inside recurring-break windows once the rolling horizon advances past the last materialized day. The RPC is idempotent, so re-running catches up.
- **Cron heartbeat (PR #265).** The external every-15-min `/api/cron/appointment-reminders` job now writes a non-sensitive "last successful run" heartbeat to Upstash (`reminder_cron:last_success`) on each authorized success, and the operator-only `/admin` console surfaces it as a **Reminder scheduler** card (healthy ≤45 min / stale / missing) so missed runs are observable inside Hone without an external-scheduler check. (Originally deferred from PR #149.) The heartbeat is best-effort/fail-open and stores only a timestamp + aggregate counts — never CRON_SECRET or client PII.

### Reminder scheduler alerting + runbook (PR #283)

The PR #265 heartbeat was **passive** — an operator only learned the external scheduler had stopped if they happened to open `/admin`. PR #283 makes it **active** without a new scheduler, cron route, or migration.

**How it works.** The **existing daily** `materialize-recurring-breaks` cron (`0 8 * * *`) now runs a best-effort `recordReminderSchedulerHealthAlert()` after its own work. That cron fires automatically and **independently** of the external every-15-min scheduler, so it can detect a dead scheduler that never calls its own route. The check reads the heartbeat, classifies it (`computeReminderSchedulerStatus`), and records ONE deduped ops alert when stale/missing. It **never sends reminders** and never calls `/api/cron/appointment-reminders`; a failure of the check can never break the daily cron (it is wrapped). The always-on admin **Reminder scheduler** card remains the **real-time read-only** view.

**Scheduler facts.**
- **URL:** `/api/cron/appointment-reminders` — the external scheduler (cron-job.org) remains the source of reminder execution.
- **Auth:** `Authorization: Bearer <CRON_SECRET>` (validated by `lib/cron/auth.ts`; missing/wrong → `401`).
- **Cadence:** every **15 minutes**.
- **Expected success:** `2xx` response → heartbeat (`reminder_cron:last_success`) updates → admin status **Healthy** (≤45 min).

**Failure meanings.**
- **`401`** = missing/bad `CRON_SECRET` (the scheduler is calling but unauthorized).
- **`5xx`** = app/runtime/provider issue inside the route (records `cron_route_failed` critical).
- **stale** = the scheduler is not calling, or recent runs failed: last success older than 45 min → `reminder_scheduler_stale` (warning).
- **missing** = no successful run has ever been recorded (or the 24h heartbeat key expired) → `reminder_scheduler_missing` (critical, emails `OPS_ALERT_EMAILS`).

**Alert + dedupe behavior.** stale/missing records **one** deduped ops alert; while an unresolved alert for the same event exists, repeated daily checks record **nothing** (no spam). **Detection latency is up to ~24h** (the daily cron cadence); the admin card is the real-time view for anyone who looks sooner. **No auto-resolve** — the operator resolves the alert manually on the admin **Ops alerts** page after the scheduler is confirmed healthy.

**Operator response (do NOT manually trigger reminders unless explicitly approved):**
1. Check the **external scheduler provider** (cron-job.org) — is the job enabled and firing every 15 min?
2. Check the **`CRON_SECRET`** configuration (scheduler header vs. Vercel env) if you see `401`s.
3. Check the **Vercel deployment / logs** for the reminder route (`5xx`, exceptions).
4. Check the **admin Ops alerts** page for the `reminder_scheduler_*` (and `cron_route_failed` / `reminder_send_exhausted`) alerts + details.
5. After the scheduler is confirmed healthy (admin card returns to **Healthy**), **resolve** the alert manually.

Live payments remain disabled (unrelated to this change).

### Disinfectant discard reminders — read-time only (PR #280)

The disinfectant "discard / replace by" date (`record_keeping_disinfectants.discard_due_date`, migration 0096) drives a **read-time** due/overdue/due-soon badge on the Record Keeping page, computed in the studio timezone when the page renders. **There is NO cron, bell notification, email, or SMS for it** — a proactive reminder was deliberately deferred (Option A). If/when a proactive reminder is built, the intended design reuses the existing `practitioner_notifications` table + a new daily `/api/cron/disinfectant-reminders` route (same `CRON_SECRET` auth + heartbeat pattern) inserting one notification per due batch, made idempotent by a `reminder_sent_at` marker column. Until then, disinfectant reminders are visible only when a practitioner opens Record Keeping.

## Testing instructions

Real Resend / Twilio sends need real credentials and a real inbox / phone number you control. The harness cannot exercise these from CI; they live in manual smoke ([docs/12](./12_SMOKE_TESTS.md)).

For email reminders specifically: an end-to-end walk-through against a Vercel preview deploy is documented in the original `TESTING_EMAIL_SYSTEM.md` (preserved as historical reference; the test recipe is still valid even though the surrounding email types have grown since).
