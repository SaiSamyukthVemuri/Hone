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

External scheduler (`https://cron-job.org/`) or Vercel cron. The cron schedule currently lives **outside the repo** (configured in the external scheduler dashboard, not in `vercel.json` or `next.config.ts`). Routes:

| Route | Status | Should be scheduled? | What it does |
|---|---|---|---|
| `/api/cron/appointment-reminders` | Active, mutating | **Yes, frequent cadence (~every 5 minutes)** | Picks up confirmed appointments due in ~24h or ~2h, sends reminder email + SMS where eligible, increments attempts, stamps `_sent_at` on success. Bounded per-run (`PER_RUN_LIMIT = 50`). 3-strike per row. |
| `/api/cron/materialize-recurring-breaks` | Active, mutating | **Yes, daily** | Daily rolling-horizon refresh for recurring break occurrences. For every active `studio_recurring_break_rules` row, materializes missing occurrences from today (in the studio's local tz) through today + ~186 days (covers the 6-month maximum public booking horizon). The underlying RPC uses `ON CONFLICT DO NOTHING` so repeated runs are idempotent. **If this is not scheduled, recurring-break availability drifts: the studio's break windows stop appearing on public booking and the calendar as the rolling horizon advances.** |
| `/api/cron/no-show-check` | **Disabled (non-mutating)** | **No** | The previous implementation auto-flipped confirmed appointments to no_show after `starts_at + 30min`. That heuristic was unsafe (treatment sessions run long; no manual-complete UI existed) and the route is now non-mutating. The first safe no-show path is the practitioner-initiated `mark_appointment_no_show` RPC via the calendar lifecycle UI. **Do not re-enable this cron without a deliberate PR following the design constraints in `app/api/cron/no-show-check/route.ts` source comments.** |

### `CRON_SECRET`

Every `/api/cron/*` route validates `Authorization: Bearer $CRON_SECRET` before doing anything. Missing or wrong secret → `401`. Generate with `openssl rand -hex 32`. Required in production.

### Ops alerts (PR #153)

When an email or SMS send gives up (final-attempt non-retryable failure OR attempt counter reaches 3), `logEmailFailure` / `logSmsFailure` now ALSO record a durable row in the `ops_alerts` table via `recordOpsAlert`. The helper never throws to the caller, so the booking / reminder / postcare path that triggered the log is not affected by alerting failures.

Events:

- `email_send_gave_up` (warning): emitted from `logEmailFailure` when the email send is non-retryable OR attempt_number >= 3. The ops helper does not dispatch operator email at all in PR #153 (deferred), so the give-up alert lives purely as a `ops_alerts` row + stderr log.
- `sms_send_failed` (warning): emitted from `logSmsFailure` under the same threshold.
- `cron_route_failed` (critical): emitted from the catch block at the top of `/api/cron/appointment-reminders/route.ts` and `/api/cron/materialize-recurring-breaks/route.ts`.
- `recurring_break_materialization_failures` (warning): emitted once per run when at least one rule failed.

The no-show-check route is intentionally non-mutating (responds with `{ ok: true, disabled: true }`) and does NOT emit cron alerts.

### Operational expectations

- **`appointment-reminders` schedule drift**: if the scheduler stops hitting this route, the 24h and 2h reminder emails stop going out. The per-row 3-strike attempts counter caps the retry blast radius once the scheduler resumes, but real reminders will be missed in the meantime.
- **`materialize-recurring-breaks` schedule drift**: if the scheduler stops hitting this route, recurring break occurrences are NOT materialized for newly-extended horizon days. Public booking eventually starts offering slots inside recurring-break windows once the rolling horizon advances past the last materialized day. The RPC is idempotent, so re-running catches up.
- **No cron heartbeat in this repo yet.** A future PR may add a /healthz-style cron heartbeat surface so missed runs are observable inside Hone instead of requiring an external scheduler check. Out of scope for PR #149.

## Testing instructions

Real Resend / Twilio sends need real credentials and a real inbox / phone number you control. The harness cannot exercise these from CI; they live in manual smoke ([docs/12](./12_SMOKE_TESTS.md)).

For email reminders specifically: an end-to-end walk-through against a Vercel preview deploy is documented in the original `TESTING_EMAIL_SYSTEM.md` (preserved as historical reference; the test recipe is still valid even though the surrounding email types have grown since).
