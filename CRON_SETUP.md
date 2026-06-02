# Cron setup for Hone

> **Pre-Stripe hardening status:** the **no-show endpoint is currently
> non-mutating AND must NOT be externally scheduled** until the
> lifecycle redesign is approved (see "Re-enabling auto no-show"
> below). The external `cron-job.org` job that previously hit
> `/api/cron/no-show-check` has been disabled in production; do NOT
> re-enable it. Reminder cron remains scheduled hourly.

The current scheduled endpoint is:

- `GET /api/cron/appointment-reminders` — every hour (mutating: sends
  reminder emails and stamps `reminder_*_sent_at`). As of PR Twilio v1
  the same endpoint also attempts SMS reminders when the per-studio
  SMS toggles are on AND the client has an explicit `sms_consent_at`
  AND the client is not opted out. SMS reminders use a separate
  `claim_sms_send` RPC for per-row mutual exclusion, so even two
  concurrent invocations of this endpoint cannot duplicate an SMS
  send. Email reminders are unchanged.

`GET /api/cron/no-show-check` remains deployed for manual testing and
returns `{ ok: true, disabled: true, ... }`. It is INTENTIONALLY NOT
on any active schedule. Calling it manually with the
`Authorization: Bearer <CRON_SECRET>` header is safe and non-mutating.

Both endpoints require an `Authorization: Bearer <CRON_SECRET>` header.
Set `CRON_SECRET` in Vercel env vars (generate with `openssl rand -hex 32`).

## Why this isn't in vercel.json

Vercel's **Hobby plan caps cron jobs at once per day**. The hourly
reminder schedule we need runs more frequently than that, so
`vercel.json` currently ships with an empty `crons` array. Deployment
passes; nothing is scheduled by Vercel itself.

When you upgrade to **Pro** ($20/mo), restore the reminder schedule
**only** — do NOT add `/api/cron/no-show-check` until the lifecycle
redesign ships:

```json
{
  "crons": [
    { "path": "/api/cron/appointment-reminders", "schedule": "0 * * * *" }
  ]
}
```

Until then, use the external scheduler option below — for the reminder
endpoint ONLY.

## Option A: cron-job.org (free, 5 minutes to set up)

1. Sign up at https://cron-job.org.
2. Create ONE job:
   - **Reminders** — URL `https://hone.care/api/cron/appointment-reminders`, schedule every hour (minute 0).
3. Under the job's **Advanced** settings, add a request header:
   - Name: `Authorization`
   - Value: `Bearer <your CRON_SECRET>`
4. Save and enable.

The previous "No-show check" job in cron-job.org has been **disabled**
and must remain disabled until the lifecycle redesign ships. Do NOT
add a new no-show schedule here.

## Option B: GitHub Actions (free, requires repo)

Create `.github/workflows/cron.yml`:

```yaml
name: Hone crons
on:
  schedule:
    - cron: "0 * * * *"      # reminders, hourly (ONLY)
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Reminders
        run: |
          curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
            https://hone.care/api/cron/appointment-reminders
        env:
          CRON_SECRET: ${{ secrets.HONE_CRON_SECRET }}
```

DO NOT add a `*/15 * * * *` job hitting `/api/cron/no-show-check`.
That endpoint is currently non-mutating, but the operational stance
is to leave it OFF any active schedule until the safe lifecycle
redesign is approved.

Then in the GitHub repo: **Settings → Secrets and variables → Actions →
New repository secret**, add `HONE_CRON_SECRET` with the same value.

Caveat: GitHub Actions cron schedules can be delayed by 10-30 minutes
under load. Fine for reminders.

## Option C: Supabase pg_cron (already-in-stack option)

Supabase supports `pg_cron` extension. Enable it in the dashboard
(**Database → Extensions → pg_cron**) and schedule a function that calls
the endpoints via `pg_net.http_get`. More setup; only worth doing if you
want everything in one place.

## Testing the endpoints manually

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://hone.care/api/cron/appointment-reminders
# Successful run:
# → {"ok":true,"reminder_24h":{"scanned":N,"sent":N,"skipped":N,...},
#    "reminder_2h":{"scanned":N,"sent":N,"skipped":N,...}}

# Manual / smoke-test invocation of the no-show endpoint. Safe to run
# ad hoc — the endpoint is non-mutating in this build:
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://hone.care/api/cron/no-show-check
# → {"ok":true,"disabled":true,"reason":"...","scanned":0,"marked":0,
#    "followups_sent":0}
```

## What "rate limited" and "idempotent" actually mean today

The previous version of this document claimed both endpoints were
"idempotent and rate-limited internally." That claim was overstated;
here is what is actually true today, and what we want to be true before
re-enabling production cron at scale.

### Reminders endpoint: `/api/cron/appointment-reminders`

- **Per-run cap (in the route):** the route filters appointments by a
  time window and `*_sent_at IS NULL` predicate, plus a
  `send_attempts < 3` cap. There is currently NO `LIMIT` on the SELECT,
  so a backlog of late appointments could in principle process the
  entire backlog in one run. In practice the time windows are narrow
  enough that runs stay small.
- **Idempotency:** the route is NOT idempotent under concurrent
  invocations. Two cron pings landing in the same 60-second window can
  both pass the `*_sent_at IS NULL` check before either calls
  `record_email_attempt`, sending the same reminder twice. The only
  practical defense today is "don't fire two schedulers."
- **Send-attempts cap:** the `send_attempts < 3` filter prevents
  runaway resends for the same row, but does NOT prevent the duplicate
  send within a single attempt window described above.

### No-show endpoint: `/api/cron/no-show-check`

- **Currently non-mutating** (see top of this document).
- When re-enabled, the endpoint MUST route through
  `public.mark_appointment_no_show(...)` (added in migration 0033),
  which takes a FOR UPDATE lock on the appointment row and refuses any
  source state other than `confirmed`. That serializes the mutation,
  but does NOT solve the duplicate-followup-email problem on its own.

## Re-enabling auto no-show (lifecycle redesign)

Before turning the no-show cron back into a mutating endpoint:

1. **Cutoff is `ends_at + grace_minutes`, NOT `starts_at + 30min`.**
   `grace_minutes` is a studio-configurable column on `public.studios`
   (default 60). A late-running treatment does not become a no-show.
2. **Mutation goes through `mark_appointment_no_show`.** The route
   may not issue a direct UPDATE on `appointments.status`. The RPC
   already exists (migration 0033) and is service_role only.
3. **Duplicate-email protection.** Before sending the followup email,
   atomically claim the row via a partial UPDATE that increments
   `no_show_email_send_attempts` and sets a fresh
   `no_show_email_claim_token` (column to be added in a follow-on
   migration). The followup is sent only if the worker still owns the
   claim token after a Stripe-style 5-minute lease window. Lease takes
   over after expiry.
4. **Per-run cap.** The SELECT MUST add `.limit(N)` (~50) so a
   never-running cron does not process an entire backlog at once.

Until items (1)-(4) are in place, the no-show endpoint stays
non-mutating and `studios.auto_mark_no_shows` is force-OFF in the
settings UI.

## Reminder claim atomicity (the remaining P1-1 gate)

A reminder-send race can still produce duplicate emails. The two
candidate fixes:

- **Outbox table** (`public.email_outbox`). A trigger on
  `appointments` enqueues `(appointment_id, email_type, due_at)` rows.
  The cron route claims rows via a single `UPDATE ... SET
  claimed_at = now() WHERE claimed_at IS NULL AND due_at <= now()
  RETURNING *` so concurrent runs cannot both see the same row.
  `record_email_attempt` stamps the row terminal. This is the
  industry-standard pattern but adds a new migration and runtime
  table.

- **Inline claim column on appointments**. Reuse the existing
  `reminder_24h_send_attempts` / `reminder_2h_send_attempts` columns
  plus a new `reminder_*_claim_token uuid` plus a `LIMIT 1` per row
  inside the SELECT (filter on
  `reminder_*_claim_token IS NULL OR claimed_at < now() - interval '5 minutes'`).
  Cheaper migration; works inline with the existing schema.

Recommended: ship **inline claim columns** as the next migration
(0034). Until that ships, do not schedule the reminder endpoint at
sub-hourly cadence and do not run two schedulers simultaneously.

## Twilio inbound SMS webhook (STOP opt-out)

Inbound SMS is handled at:

`POST /api/twilio/inbound-sms`

This endpoint is intentionally NOT a cron endpoint and does NOT use
`CRON_SECRET`. It authenticates via the standard Twilio `X-Twilio-Signature`
header (HMAC-SHA1 over the full URL plus sorted POST fields) validated
inside the route handler. The middleware allows the exact path
`/api/twilio/inbound-sms` unauthenticated for the same reason
`/api/stripe/webhook` is allowed: the route itself is the auth gate.

Configure Twilio to POST inbound messages to:

```
https://hone.care/api/twilio/inbound-sms
```

Steps in the Twilio Console:

1. Messaging -> Services -> (your service) -> Inbound Settings ->
   Process inbound messages -> Send a webhook.
2. Webhook URL: `https://hone.care/api/twilio/inbound-sms`.
3. Method: `HTTP POST`.
4. Save.

Set `TWILIO_WEBHOOK_BASE_URL=https://hone.care` in Vercel env so the
signature validator builds the canonical URL deterministically
regardless of which internal Vercel hostname the runtime sees.

STOP keywords (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`,
`QUIT`) opt out every Hone client whose stored phone normalizes to
the inbound `From` digits and write one `audit_logs` row per matched
client. Non-STOP inbound messages are acknowledged with an empty
TwiML and not persisted (v1 is opt-out only, not conversational).

After STOP, email reminders for the opted-out client continue; only
SMS sends are blocked.

## SMS send concurrency

`claim_sms_send` and `record_sms_result` (migration 0049) wrap every
SMS send in an atomic claim-then-send-then-record cycle:

- `claim_sms_send` increments the matching `sms_*_send_attempts`
  column and stamps `sms_*_claimed_at = now()` only if the matching
  `_sent_at` is null, attempts are `< 3`, and either no other claim
  is held or the existing claim is older than 5 minutes.
- The send helper POSTs to Twilio only after a successful claim, with
  a 15-second fetch timeout.
- `record_sms_result` runs in a `finally` regardless of outcome: on
  success it stamps `_sent_at` and clears `_claimed_at`; on failure
  it clears `_claimed_at` so the next cron pass can retry up to the
  3-attempts cap.

Result: two concurrent invocations of `/api/cron/appointment-reminders`
cannot both send the same SMS, and a crashed sender unblocks itself
after 5 minutes without operator intervention.
