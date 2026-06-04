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

### Email send tracking

Appointment rows carry attempt counters and stamped timestamps:
- `confirmation_send_attempts` + `confirmation_sent_at`
- `reminder_24h_send_attempts` + `reminder_24h_sent_at`
- `reminder_2h_send_attempts` + `reminder_2h_sent_at`
- `no_show_email_send_attempts` + `no_show_email_sent_at`
- `postcare_email_send_attempts` + `postcare_email_sent_at`

Truthful-reporting rule: stamp the `*_sent_at` **only** when the Resend call actually delivered. The 3-strike pattern is on every transactional path: each attempt increments `_attempts`; once Resend confirms success the `_sent_at` is set; if attempts exceed 3 without delivery the cron stops retrying and logs a sanitized failure for the operator.

### Known gap

Email reminder claim/outbox discipline is **deferred**. The current path uses the attempts counter to bound retries but does not lock the row between read and send. In the rare race where the cron fires twice on the same row within milliseconds, a duplicate send is possible. The truthful counter still catches it after the fact, and the practitioner is the one who actually notices duplicates. Outbox-style claim is on the [backlog](./13_BACKLOG_AND_DECISIONS.md) as P1.

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

External scheduler (`https://cron-job.org/`) or Vercel cron. Routes:

| Route | Schedule | What it does |
|---|---|---|
| `/api/cron/appointment-reminders` | Every 5 minutes | Picks up confirmed appointments due in ~24h or ~2h, sends reminder email + SMS where eligible, increments attempts, stamps `_sent_at` on success. Bounded per-run (`PER_RUN_LIMIT = 50`). 3-strike per row. |

### `CRON_SECRET`

Every `/api/cron/*` route validates `Authorization: Bearer $CRON_SECRET` before doing anything. Missing or wrong secret → `401`. Generate with `openssl rand -hex 32`. Required in production.

### Disabled cron routes

The original `no-show finalize` cron route (pre-Stripe hardening) is **non-mutating** and must NOT be externally scheduled. The no-show transition is now manual practitioner-initiated only via the lifecycle UI (`Mark no-show`); see [docs/13](./13_BACKLOG_AND_DECISIONS.md) decision log.

## Testing instructions

Real Resend / Twilio sends need real credentials and a real inbox / phone number you control. The harness cannot exercise these from CI; they live in manual smoke ([docs/12](./12_SMOKE_TESTS.md)).

For email reminders specifically: an end-to-end walk-through against a Vercel preview deploy is documented in the original `TESTING_EMAIL_SYSTEM.md` (preserved as historical reference; the test recipe is still valid even though the surrounding email types have grown since).
