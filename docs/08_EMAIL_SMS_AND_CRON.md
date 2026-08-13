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
- `postcare_email_send_attempts` + `postcare_email_sent_at` (+ `_claimed_at` / `_failed_at` / `_last_error` / `_last_attempt_at`, migration 0100) — PR #311
- `intake_reminder_7d_send_attempts` + `intake_reminder_7d_sent_at` (+ `_claimed_at`) — PR #306
- `intake_reminder_3d_send_attempts` + `intake_reminder_3d_sent_at` (+ `_claimed_at`) — PR #306

Truthful-reporting rule: stamp the `*_sent_at` **only** when the Resend call actually delivered. The 3-strike pattern is on every transactional path: each attempt increments `_attempts`; once Resend confirms success the `_sent_at` is set; if attempts exceed 3 without delivery the cron stops retrying and logs a sanitized failure for the operator.

**Postcare send-state correctness (PR #311, migration 0100).** The manual postcare send (`sendPostcareEmailAction`) previously used `postcare_email_sent_at` as **both** the atomic first-send claim **and** the "sent" marker, stamping it **before** the Resend call — so a provider failure left a false "Postcare sent" (a P1 overclaim). It now mirrors the reminder claim discipline with per-appointment columns: the first send **claims `postcare_email_claimed_at`** (guarded by `sent_at IS NULL` + no fresh claim; ~5-min stale-reclaim window) and sets `postcare_email_last_attempt_at` + increments attempts **without** stamping `sent_at`; `postcare_email_sent_at` is stamped **only after Resend confirms success** (which also clears `_failed_at`/`_last_error`/`_claimed_at`). A provider **failure** sets `postcare_email_failed_at` + a **safe/generic** `postcare_email_last_error` (never the raw provider payload, client email/name, health data, or exception details) and clears the claim, leaving `sent_at` NULL on a first send (a failed **resend** keeps any prior real `sent_at`). The appointment-detail UI shows Sent / **Send failed — try again** / Sending… / Not-sent, and "sent" means **handed to the provider**, never delivered/received/opened. Postcare still bypasses `record_email_attempt` (single-request, no scheduler race). Additive/backfill-safe; existing historical `postcare_email_sent_at` rows are unchanged.

### Intake-form reminders (PR #306, migration 0098)

The appointment-reminders cron also sends **intake-form reminder emails ~7 days and ~3 days before a confirmed appointment**, but only when the client's latest intake is still `in_progress`. It **reuses the exact 24h/2h idempotency machinery**: two new per-appointment column trios (`intake_reminder_7d_sent_at`/`_send_attempts`/`_claimed_at` and the `3d` set, migration 0098, additive/backfill-safe), two partial due-window indexes, and **two new branches on `claim_email_send` / `record_email_result`** (existing confirmation/reminder_24h/reminder_2h branches reproduced byte-for-byte). Each `sendIntakeReminderPass` (kind `7d`/`3d`, 2-hour windows centered on the target day via `intakeReminderWindowIso`, ≥ the 15-min cadence so no offset is missed): loads confirmed appointments in the window (`sent_at IS NULL`, `attempts < 3`), resolves the client's **latest intake with the admin client, studio+client scoped** (isolation preserved), **skips** if the intake is missing / submitted / reviewed or the client has no email, **claims before send**, re-checks the appointment is still confirmed, **always mints a fresh valid link** (`generateIntakeLinkUrl`, now + 14-day TTL; signed token stays authoritative; saved answers preserved — reuses the existing intake row), sends the reminder-specific copy (`buildIntakeReminderEmail` / `sendIntakeReminderToClient`), records the outcome via `record_email_result`, and on success stamps the PR #303 intake-link metadata (`stampIntakeLinkIssued({ emailed: true })`). Logs carry only appointment/studio ids + kind — **never a raw token or client PII**. No per-studio toggle (the per-appointment dedupe + skip-submitted + 7d/3d cadence keep it non-spammy); no SMS, no extra cadence. Email copy: subject "Reminder: please complete your intake form before your appointment" (no PII/date in the subject), body mentions the appointment date/time, says the form helps the practitioner prepare safely, carries the fresh link, and says "If you've already completed it, you can ignore this message." — no medical claims, no delivery/receipt overclaim.

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

This endpoint is **not** a cron endpoint and does **not** use `CRON_SECRET`. It authenticates on the Twilio `X-Twilio-Signature` header (HMAC-SHA1 over the full URL plus sorted POST fields) validated inside the route handler; `middleware.ts` allows the exact path `/api/twilio/inbound-sms` unauthenticated for the same reason `/api/stripe/webhook` is allowed — the route itself is the auth gate.

**Twilio Console wiring** (carried over from the retired `CRON_SETUP.md`, PR OPS-01): Messaging → Services → (your service) → Inbound Settings → *Process inbound messages* → **Send a webhook**; Webhook URL `https://hone.care/api/twilio/inbound-sms`; Method `HTTP POST`; Save. Set `TWILIO_WEBHOOK_BASE_URL=https://hone.care` in the Vercel production env so the signature validator builds the canonical URL deterministically regardless of which internal Vercel hostname the runtime sees.

STOP keywords (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`) opt out every Hone client whose stored phone normalizes to the inbound `From` digits, writing one `audit_logs` row per matched client. Non-STOP inbound messages are acknowledged with empty TwiML and not persisted (v1 is opt-out only, not conversational). After STOP, **email** reminders for that client continue; only SMS sends are blocked.

### SMS RPC grants hardened (PR #141 / migration 0062)

`claim_sms_send` and related SMS RPCs are `revoke from public, anon, authenticated; grant to service_role only`. The action layer always invokes via `createAdminClient()`. Audit grep on every caller is part of the PR template's security checklist.

## Cron

**Cron scheduling (PR #258).** Previously the schedule lived outside the repo (an external `cron-job.org` dashboard) while `vercel.json` had an empty `"crons": []`, so every active route was unscheduled in-repo. PR #258 moves what the plan allows into `vercel.json` and pins the rest. **The production Vercel plan caps cron cadence at once-per-day**, so a `*/15` reminder cron is rejected at deploy time — the appointment-reminders route therefore stays on an **external every-15-minute scheduler** (cron-job.org) for now, while the **daily** `materialize-recurring-breaks` cron lives in `vercel.json`. Both paths send/validate `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron attaches it automatically; the external scheduler is configured to send it; `lib/cron/auth.ts` validates either). The cadence + reminder windows are a single source of truth in `lib/cron/reminder-schedule.ts`, shared by the route and the invariant tests so they cannot drift.

**Schedules:**

| Route | How it is scheduled |
|---|---|
| `/api/cron/appointment-reminders` | **External scheduler (cron-job.org), `GET` every 15 min** with `Authorization: Bearer $CRON_SECRET`. (NOT in `vercel.json` — `*/15` exceeds the current plan's once-per-day cron cap. If the project moves to Vercel Pro, add `{ "path": "/api/cron/appointment-reminders", "schedule": "*/15 * * * *" }` to `vercel.json` and drop the external job — that schedule string is `APPOINTMENT_REMINDER_CRON_SCHEDULE`.) |
| `/api/cron/materialize-recurring-breaks` | **Vercel Cron, `vercel.json`, `0 8 * * *`** (daily, 08:00 UTC — allowed on every plan). Also runs the reminder-scheduler health check in a `finally` (PR OPS-01). |
| `/api/cron/calendar-reconcile` | **Vercel Cron, `vercel.json`, `0 9 * * *`** (daily, B2.3-c3 — daily because the plan caps cron at once/day). **DORMANT:** the reconciliation sweep finds zero intent-eligible studios while every studio outbound flag is OFF. Schedule pinned in `lib/cron/calendar-cron-schedule.ts`. |
| `/api/cron/calendar-sync` | **Vercel Cron, `vercel.json`, `30 9 * * *`** (daily, B2.3-c3, after reconciliation). **DORMANT:** `worker_enabled=false` → the claim RPC returns zero rows and mutates nothing → no-work. The **first scheduled run doubles as the B2.3-c2 no-work production validation** (Vercel Cron auto-supplies the production `CRON_SECRET`). Schedule pinned in `lib/cron/calendar-cron-schedule.ts`. |
| `/api/cron/no-show-check` | **intentionally NOT scheduled** (disabled, non-mutating stub). |

### Reminder scheduler: RUNTIME OPERATION PROVEN 2026-08-12 · HUMAN OWNERSHIP still OPEN

These are two different claims and they must never be conflated. The runtime
claim is now evidenced; the ownership claim is not, and no probe can supply it.

**Evidence run: 2026-08-12, against production SHA `773dbc7008b5`.** Method:
read-only Vercel request logs for the production deployment
(`dpl_ErKKmeUfJ4qCp8iBZzZmXxB9RzXq`, aliased to `hone.care`, built from the
`773dbc7008b5` merge commit 4 seconds after it landed) plus one *unauthenticated*
probe. **No authenticated reminder invocation was made, no reminder was sent, no
production DB was touched, and the `CRON_SECRET` value was never read.**

#### PROVEN RUNTIME FACTS (observed, dated)

| Fact | Evidence |
|---|---|
| The external job **is firing** | Three consecutive requests to `GET /api/cron/appointment-reminders` on `hone.care`: **23:00:19Z, 23:15:10Z, 23:30:14Z** (2026-08-12) |
| Cadence is **~15 minutes** | Intervals of **+14.85 min** and **+15.07 min** — an hourly job cannot produce a 15-minute interval |
| The scheduler **authenticates successfully** | All three returned **HTTP 200**; `200` is reachable only via the route's full success path |
| The endpoint **is auth-gated** | One unauthenticated GET returned exactly `401 {"ok":false,"error":"Unauthorized"}` — the gate is the first statement of the handler, so a 401 touches no admin client, claim, provider, or heartbeat |
| Exact URL is correct | `https://hone.care/api/cron/appointment-reminders`, production branch, production deployment |
| `CRON_SECRET` **is configured in production** | Present in the Vercel Production environment (presence proven via `vercel env ls`; the value was never displayed) |
| **No duplicate scheduler** on any axis we can observe | `vercel.json` does not register it and `vercel crons ls` returns exactly 3 jobs (none of them reminders); no `pg_cron`/`pg_net` in any migration; no `supabase/functions`; the only GitHub Actions schedule is the nightly CI matrix against `localhost` with a dummy secret; and the request logs show exactly **one** request per 15-minute slot |

#### OPERATOR / HUMAN FACTS STILL TO VERIFY

No log line can establish these. They stay unchecked until a human confirms them.

- [ ] External scheduler account identified, and its **owner named** (who can log in).
- [ ] **Backup owner** named (who takes over if the primary is unavailable).
- [ ] **Single enabled job** confirmed in the cron-job.org dashboard — the request logs rule out a duplicate hitting *this* app, but only the dashboard rules out a second job configured inside the provider.
- [ ] Operator **alerting ownership named** — who acts on `reminder_scheduler_*` / `reminder_send_exhausted`, and which inbox `OPS_ALERT_EMAILS` resolves to.
- [ ] The `/admin` **Reminder scheduler** card observed reading **Healthy** — this is the one remaining *runtime* gap: an HTTP 200 proves the run succeeded but **not** that the Upstash heartbeat was persisted, because the heartbeat write is deliberately fail-open.

Until the ownership boxes are checked, describe reminder delivery as
**"running in production, ownership unattested"** — not as fully verified.

**Reminder schedule/window compatibility (why every 15 min):** a reminder window `W` minutes wide, sampled by a cron firing every `P` minutes, is only missable when `W < P` (a closed window of width `≥ P` always contains a point of the `P`-minute grid). The 24h window is `[23h, 25h]` (120 min, safe at any cadence). The 2h window is `[105, 135]` (30 min) — at the old assumed **hourly** cadence (`P = 60`) a 30-min window silently misses ~half of all appointment minute offsets; at every-15-minutes (`P = 15`) `W = 30 = 2·P`, so every appointment is eligible at least once **and** a single skipped fire still leaves a grid point in-window. So the external scheduler MUST be configured at ≤15-minute cadence (the `reminder-schedule` invariant assumes it). `tests/lib/cron/reminder-schedule.test.ts` proves every minute offset 0–59 is covered at 15-min cadence and that the hourly + 30-min combination fails; `tests/app/cron-config.test.ts` pins the `vercel.json` config + the required cadence. **Max-attempt posture:** after a reminder fails `MAX_ATTEMPTS` (3) it is filtered out of the window query; PR #258 emits a `reminder_send_exhausted` ops alert (warning) with non-sensitive metadata only (studio_id, appointment_id, reminder_type, attempt_count, retryable, reason — no client email/phone/notes/token/free-text). The route also re-checks appointment `status='confirmed'` immediately before sending (both the email and SMS passes) so a reminder is never sent for an appointment cancelled after the window query. *(Point-in-time note; supervised live session payments are now live for approved studios — see [docs/production/current-state.md](./production/current-state.md).)*

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
- `reminder_scheduler_degraded` (warning) / `reminder_scheduler_stale` (**critical**) / `reminder_scheduler_missing` (critical) — **PR #283, hardened by PR OPS-01**: recorded by the best-effort scheduler-health check (`recordReminderSchedulerHealthAlert`, `lib/cron/reminder-heartbeat.ts`), which now runs from **three** independent daily Vercel crons. Deduped on an existing unresolved `ops_alerts` row for the same event, so three daily callers still record at most **one** alert per outage per event. `safe_details` carry only `status`, `last_success_at`, `age_minutes`, `cadence_minutes`, `degraded_after_minutes`, `stale_after_minutes`, `checked_at` — never `CRON_SECRET`, an Authorization header, client phone/email/PII, reminder contents, or a provider payload. The check NEVER sends reminders and never calls `/api/cron/appointment-reminders`.

The no-show-check route is intentionally non-mutating (responds with `{ ok: true, disabled: true }`) and does NOT emit cron alerts.

### Operational expectations

- **`appointment-reminders` schedule drift**: if the scheduler stops hitting this route, the 24h and 2h reminder emails stop going out. The per-row 3-strike attempts counter caps the retry blast radius once the scheduler resumes, but real reminders will be missed in the meantime.
- **`materialize-recurring-breaks` schedule drift**: if the scheduler stops hitting this route, recurring break occurrences are NOT materialized for newly-extended horizon days. Public booking eventually starts offering slots inside recurring-break windows once the rolling horizon advances past the last materialized day. The RPC is idempotent, so re-running catches up.
- **Cron heartbeat (PR #265).** The external every-15-min `/api/cron/appointment-reminders` job now writes a non-sensitive "last successful run" heartbeat to Upstash (`reminder_cron:last_success`) on each authorized success, and the operator-only `/admin` console surfaces it as a **Reminder scheduler** card (healthy ≤45 min / stale / missing) so missed runs are observable inside Hone without an external-scheduler check. (Originally deferred from PR #149.) The heartbeat is best-effort/fail-open and stores only a timestamp + aggregate counts — never CRON_SECRET or client PII.

### Reminder scheduler alerting + runbook (PR #283)

The PR #265 heartbeat was **passive** — an operator only learned the external scheduler had stopped if they happened to open `/admin`. PR #283 makes it **active** without a new scheduler, cron route, or migration.

**How it works (PR OPS-01).** The best-effort `recordReminderSchedulerHealthAlert()` runs from **three** existing daily Vercel crons — `materialize-recurring-breaks` (`0 8 * * *`), `calendar-reconcile` (`0 9 * * *`) and `calendar-sync` (`30 9 * * *`). All three fire automatically and **independently** of the external every-15-min scheduler, so they can detect a dead scheduler that never calls its own route. The check reads the heartbeat, classifies it (`computeReminderSchedulerStatus`), and records ONE deduped ops alert when degraded/stale/missing. It **never sends reminders** and never calls `/api/cron/appointment-reminders`; a failure of the check can never break the host cron (it is wrapped, and in the two routes with their own auth gate it runs in a `finally` that contains no `return`/`throw`, so it cannot alter the route's real result). The always-on admin **Reminder scheduler** card remains the **real-time read-only** view.

*Why three callers:* PR #283 had exactly one, inside the materialize happy path — so an unrelated recurring-break lookup failure took its `return 500` and skipped reminder monitoring for the whole day, and that single cron was a silent single point of failure. Dedupe (an unresolved `ops_alerts` row for the same event) is what keeps three daily callers from producing three alerts.

**Scheduler facts.**
- **URL:** `/api/cron/appointment-reminders` — the external scheduler (cron-job.org) remains the source of reminder execution.
- **Auth:** `Authorization: Bearer <CRON_SECRET>` (validated by `lib/cron/auth.ts`; missing/wrong → `401`).
- **Cadence:** every **15 minutes** (`CRON_INTERVAL_MINUTES`).
- **Expected success:** `2xx` response → heartbeat (`reminder_cron:last_success`) updates → admin status **Healthy**.

**Health states.** Both thresholds are multiples of `CRON_INTERVAL_MINUTES`, so a cadence change moves the monitoring contract with it — there is no second magic 15.

| State | Heartbeat age | Severity | Emails? | Meaning |
|---|---|---|---|---|
| **Healthy** | ≤ 30 min (2× cadence) | — | — | Cadence contract met |
| **Degraded** | 31–45 min | warning | no | **Cadence margin lost.** The 2h reminder window is only 30 min wide, so once the effective cadence exceeds 30 min appointment offsets start being missed outright (at 45 min: 19/60 offsets; at 60 min: 29/60). |
| **Stale** | > 45 min (3× cadence) | **critical** | **yes** | Three missed cycles — sustained failure |
| **Missing** | no valid heartbeat | critical | yes | No run recorded, or the 24h heartbeat key expired |

*Why 2× and 3×:* the reliability invariant in `lib/cron/reminder-schedule.ts` is that a window `W` minutes wide sampled every `P` minutes is only missable when `W < P`. The 2h window is `W = 30`, so `P ≤ 30` is still correct and `P > 30` is not — that is exactly the degraded boundary. `3×` matches the 3-strike `MAX_ATTEMPTS` posture of the route itself.

**Failure meanings.**
- **`401`** = missing/bad `CRON_SECRET` (the scheduler is calling but unauthorized). ⚠️ The route returns 401 *before* any alerting, so a 401 storm is **silent app-side** — it surfaces only as a heartbeat going degraded → stale.
- **`5xx`** = app/runtime/provider issue inside the route (records `cron_route_failed` critical).

**Alert + dedupe behavior.** Each unhealthy state records **one** deduped ops alert; while an unresolved alert for that event exists, later checks record **nothing** (no spam). The three states are **separate events**, so a worsening outage still escalates: an unresolved `degraded` warning does not suppress the `stale` critical.

**Detection latency (PR OPS-01).** `stale` is now **critical**, so it **emails `OPS_ALERT_EMAILS` on the first daily check after 45 minutes of silence**. Previously `stale` was a warning — which never emails — so a dead scheduler produced no operator email until the 24h heartbeat TTL expired the key into `missing`, i.e. **~25–48h**. With checks at 08:00 / 09:00 / 09:30 UTC the worst case is now **≈22.5h** (dying just after 09:30, caught at 08:00 the next day) and the best case ~1h. The admin card remains the real-time view for anyone who looks sooner. **No auto-resolve** — the operator resolves the alert manually on the admin **Ops alerts** page after the scheduler is confirmed healthy.

**Operator response (do NOT manually trigger reminders unless explicitly approved):**
1. Check the **external scheduler provider** (cron-job.org) — is the job enabled and firing every 15 min?
2. Check the **`CRON_SECRET`** configuration (scheduler header vs. Vercel env) if you see `401`s.
3. Check the **Vercel deployment / logs** for the reminder route (`5xx`, exceptions).
4. Check the **admin Ops alerts** page for the `reminder_scheduler_*` (and `cron_route_failed` / `reminder_send_exhausted`) alerts + details.
5. After the scheduler is confirmed healthy (admin card returns to **Healthy**), **resolve** the alert manually.

#### Scheduler ownership register — UNVERIFIED, fill in by hand

Code cannot establish who owns a third-party dashboard account. These stay
unchecked until a human confirms each one; **do not tick a box on the strength
of the runtime evidence above** — a job that is provably firing today still has
no named owner to call when it stops.

| # | Fact | Status | Value |
|---|---|---|---|
| 1 | cron-job.org **primary account owner** (who can log in) | ☐ unverified | _(record here)_ |
| 2 | **Backup owner** (who takes over if the primary is unavailable) | ☐ unverified | _(record here)_ |
| 3 | **Exactly one enabled reminder job** in the provider dashboard | ☐ unverified | request logs show one call per slot, but only the dashboard rules out a second configured job |
| 4 | **Alert owner / on-call recipient** — who acts on `reminder_scheduler_*`, and which inbox `OPS_ALERT_EMAILS` resolves to | ☐ unverified | _(record here)_ |
| 5 | `/admin` **Reminder scheduler** card observed reading **Healthy** | ☐ unverified | proves the Upstash heartbeat is actually being persisted — an HTTP 200 does **not**, because the write is fail-open |

Never record a credential, token, or the `CRON_SECRET` in this table.

*(Point-in-time note; supervised live session payments are now live for approved studios — see [docs/production/current-state.md](./production/current-state.md). Unrelated to this change.)*

### Disinfectant discard reminders — read-time only (PR #280)

The disinfectant "discard / replace by" date (`record_keeping_disinfectants.discard_due_date`, migration 0096) drives a **read-time** due/overdue/due-soon badge on the Record Keeping page, computed in the studio timezone when the page renders. **There is NO cron, bell notification, email, or SMS for it** — a proactive reminder was deliberately deferred (Option A). If/when a proactive reminder is built, the intended design reuses the existing `practitioner_notifications` table + a new daily `/api/cron/disinfectant-reminders` route (same `CRON_SECRET` auth + heartbeat pattern) inserting one notification per due batch, made idempotent by a `reminder_sent_at` marker column. Until then, disinfectant reminders are visible when a practitioner opens Record Keeping **and (PR #295) on the inspector print view** (`/records/print?section=disinfectants`): each batch prints a **"Replace by"** date (or "Not set") plus a **"Replace status"** line for overdue/due-today/due-soon batches, computed with the same studio-timezone `todayInTz` + `disinfectantDueStatus`/`disinfectantStatusLabel` helpers, so a printed inspection log matches the screen. Still read-time / display-only — no cron, notification, schema, or migration was added.

## Testing instructions

Real Resend / Twilio sends need real credentials and a real inbox / phone number you control. The harness cannot exercise these from CI; they live in manual smoke ([docs/12](./12_SMOKE_TESTS.md)).

For email reminders specifically: an end-to-end walk-through against a Vercel preview deploy is documented in the original `TESTING_EMAIL_SYSTEM.md` (preserved as historical reference; the test recipe is still valid even though the surrounding email types have grown since).
