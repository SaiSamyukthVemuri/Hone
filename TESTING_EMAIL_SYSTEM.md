# Testing the email reminder + cancellation + reschedule + no-show system

End-to-end walkthrough for Session 19.2. Run on a Vercel preview deploy with
`CRON_SECRET` set and `RESEND_API_KEY` set. Use a real email inbox you
control for the test client (an alias of your own address works).

## Setup

Variables you'll use throughout. Set them locally for the curl commands:

```bash
export HONE_URL="https://hone.care"
export CRON_SECRET="<the value you set in Vercel env vars>"
```

If you're testing against a preview deploy, use the preview URL. Cron
endpoints work on any deploy that has `CRON_SECRET` set.

Pick one client and one appointment you can mutate freely in Supabase.
You'll need the appointment's `id` (uuid) for several scenarios. Get it
once and reuse:

```sql
select id, status, starts_at, client_id, studio_id, cancellation_token
  from public.appointments
  order by created_at desc
  limit 5;
```

Replace `<APT_ID>` and `<TOKEN>` below with the values for your test row.

## Migration verification

Before walking scenarios, confirm migration 0025 landed cleanly.

```sql
-- 8 new appointment columns
select column_name from information_schema.columns
  where table_name = 'appointments'
    and column_name in (
      'confirmation_sent_at', 'reminder_24h_sent_at',
      'reminder_2h_sent_at', 'no_show_email_sent_at',
      'cancellation_token',
      'confirmation_send_attempts', 'reminder_24h_send_attempts',
      'reminder_2h_send_attempts'
    );

-- 5 new studio columns
select column_name from information_schema.columns
  where table_name = 'studios'
    and column_name in (
      'send_confirmation_emails', 'send_24h_reminders',
      'send_2h_reminders', 'auto_mark_no_shows', 'send_no_show_followup'
    );

-- 1 new service column
select column_name from information_schema.columns
  where table_name = 'services' and column_name = 'pre_care_instructions';

-- All existing confirmed appointments got tokens
select count(*) from public.appointments
  where cancellation_token is null and status = 'confirmed';
-- Should return 0
```

---

## 1. Confirmation email

**Goal:** booking a fresh appointment sends a confirmation email within 30
seconds, with greeting, detail block, Reschedule + Cancel buttons.

1. Go to `/book/<your-studio-slug>` on the preview deploy.
2. Pick a service, a date, a slot. Fill name + your test email.
3. Submit.

**Verify in inbox:** email arrives within 30 seconds with subject
`Appointment confirmed: <service> with <studio> on <date>`. Body contains
greeting, service + practitioner line, date + time + duration in the
studio timezone (Toronto), Reschedule button, Cancel link.

**Verify in Supabase:**

```sql
select confirmation_sent_at, confirmation_send_attempts, cancellation_token
  from public.appointments
  where id = '<APT_ID>';
-- confirmation_sent_at should be a timestamp within the last minute
-- confirmation_send_attempts = 1
-- cancellation_token should be a 32-char base64url string, not null
```

---

## 2. Pre-care instructions

**Goal:** confirmation and reminder emails for a service with pre-care
text include that text in a distinct block.

1. Go to **Settings → Services**.
2. On any service row, set **Pre-care instructions** to:
   `Please arrive 5 minutes early. Skin should be free of lotion or makeup.`
   Save.
3. Book a fresh appointment for that service via the public booking page.

**Verify in inbox:** email contains a separate "Before your appointment"
panel with the exact pre-care text, visually distinct (light tan
background, vertical left border).

---

## 3. 24-hour reminder

**Goal:** the reminders cron sends a 24h reminder for any confirmed
appointment whose `starts_at` is 23-25 hours from now and which hasn't
been reminded yet.

Force the test appointment into the window and clear any prior send state:

```sql
update public.appointments
  set starts_at = now() + interval '24 hours',
      ends_at = now() + interval '24 hours' + interval '30 minutes',
      reminder_24h_sent_at = null,
      reminder_24h_send_attempts = 0
  where id = '<APT_ID>';
```

Curl the reminders cron:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  "$HONE_URL/api/cron/appointment-reminders"
```

**Verify response:** JSON shows `reminder_24h: { attempted: 1, succeeded: 1, failed: 0 }` (or attempted >= 1 if other appointments also fell into the window).

**Verify in inbox:** reminder email arrives. Subject
`Reminder: <service> tomorrow at <time>`.

**Verify in Supabase:**

```sql
select reminder_24h_sent_at, reminder_24h_send_attempts
  from public.appointments
  where id = '<APT_ID>';
-- reminder_24h_sent_at is now a timestamp
-- reminder_24h_send_attempts = 1
```

---

## 4. 2-hour reminder

Same pattern, different window. Force the appointment into 1h45m-2h15m
from now:

```sql
update public.appointments
  set starts_at = now() + interval '2 hours',
      ends_at = now() + interval '2 hours' + interval '30 minutes',
      reminder_2h_sent_at = null,
      reminder_2h_send_attempts = 0
  where id = '<APT_ID>';
```

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  "$HONE_URL/api/cron/appointment-reminders"
```

**Verify response:** `reminder_2h: { attempted: 1, succeeded: 1 }`.

**Verify in inbox:** subject `Reminder: <service> today at <time>`.

**Verify in Supabase:** `reminder_2h_sent_at` is populated.

---

## 5. Cancellation link

**Goal:** the Cancel button in any email opens a public page that lets
the client cancel without logging in.

1. Open the confirmation email from Scenario 1.
2. Click the **Cancel** link.
3. Public page loads showing the appointment details.
4. Click **Confirm cancellation**.

**Verify in Supabase:**

```sql
select status, cancelled_at, cancelled_by, cancellation_reason
  from public.appointments
  where id = '<APT_ID>';
-- status = 'cancelled'
-- cancelled_at populated
-- cancelled_by = 'client'
```

**Verify second click on same link:** page should show "Cancellation link is
no longer valid" or "already cancelled" state. Behavior depends on whether
the page route returns the success page after the action or re-fetches.

**Verify a tampered token:** open `<HONE_URL>/cancel/garbage-token`. Page
should render "This cancellation link is no longer valid." Not a stack
trace.

---

## 6. Reschedule link

**Goal:** the Reschedule button opens a public availability picker; picking
a new slot cancels the original and creates a new appointment.

Reset the appointment to a future confirmed state:

```sql
update public.appointments
  set status = 'confirmed',
      starts_at = now() + interval '5 days',
      ends_at = now() + interval '5 days' + interval '30 minutes',
      cancelled_at = null,
      cancelled_by = null,
      cancellation_reason = null
  where id = '<APT_ID>';
```

Get the token (it may have been regenerated; fetch fresh):

```sql
select cancellation_token from public.appointments where id = '<APT_ID>';
```

Open `<HONE_URL>/reschedule/<TOKEN>`. The page shows the current appointment
plus a date picker and available slots. Pick a different date with
availability, pick a slot, click **Confirm new time**.

**Verify in Supabase:**

```sql
-- Original is cancelled
select status, cancelled_at, cancellation_reason
  from public.appointments
  where id = '<APT_ID>';
-- status = 'cancelled', cancellation_reason = 'Rescheduled via email link'

-- New appointment exists for the same client, with a fresh token
select id, status, starts_at, cancellation_token, confirmation_sent_at
  from public.appointments
  where client_id = (select client_id from public.appointments where id = '<APT_ID>')
    and status = 'confirmed'
    and created_at > now() - interval '5 minutes';
-- Returns one row: status confirmed, fresh token, confirmation_sent_at populated
```

**Verify in inbox:** a new confirmation email for the new appointment time.

---

## 7. No-show automation

**Goal:** the no-show cron flips status to `no_show` for confirmed
appointments that started >30 min ago. Optionally sends a follow-up
email when the studio toggle is on.

Force the appointment into the past:

```sql
update public.appointments
  set status = 'confirmed',
      starts_at = now() - interval '45 minutes',
      ends_at = now() - interval '15 minutes'
  where id = '<APT_ID>';
```

Curl the no-show cron:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  "$HONE_URL/api/cron/no-show-check"
```

**Verify response:** JSON includes `marked: 1`.

**Verify in Supabase:**

```sql
select status from public.appointments where id = '<APT_ID>';
-- status = 'no_show'
```

**Follow-up email test:** if the studio has `send_no_show_followup` on,
the response also reports `followups_sent: 1` and an email arrives with
subject `We missed you today`. To toggle:

```sql
update public.studios set send_no_show_followup = true
  where id = '<STUDIO_ID>';
```

Then re-run the steps with a fresh past appointment.

---

## 8. Studio toggles

**Goal:** disabling a toggle prevents the corresponding email send.

1. Go to **Settings → Studio → Email notifications**.
2. Turn off **Send 24-hour reminders**. Confirm the green "Saved" hint
   flashes.
3. Set up another test appointment in the 24-hour window using the SQL
   from Scenario 3.
4. Curl the reminders cron.

**Verify response:** `reminder_24h: { attempted: 0 }` or 0 succeeded if
the only appointment in the window was the test one.

**Verify in Supabase:**

```sql
select reminder_24h_sent_at from public.appointments where id = '<APT_ID>';
-- still null
```

Turn 24h reminders back on after the test.

Repeat for `send_2h_reminders`, `send_confirmation_emails`,
`auto_mark_no_shows`, `send_no_show_followup` as needed.

---

## 9. Email activity log on appointment detail

**Goal:** the appointment detail page surfaces every email timestamp.

1. Open `/calendar/<APT_ID>` in the app as a practitioner.
2. Scroll to the **Email activity** section near the bottom.

**Verify:** each row shows either the timestamp or `Not sent`:
- Confirmation sent
- 24-hour reminder sent
- 2-hour reminder sent
- No-show follow-up sent (only present when populated)

Values should match what's in `public.appointments`.

---

## 10. Edge cases

### 10a. Appointment with no client email

Force a client to have no email and book on their behalf via the in-app
calendar flow:

```sql
update public.clients set email = null where id = '<CLIENT_ID>';
```

Curl the reminders cron after putting the appointment in the window.

**Verify response:** the appointment is skipped silently. `reminder_24h:
{ attempted: 0 }` if it was the only candidate. No crash.

Restore the email when done:

```sql
update public.clients set email = '<original email>'
  where id = '<CLIENT_ID>';
```

### 10b. Cron called without auth

```bash
curl -i "$HONE_URL/api/cron/appointment-reminders"
```

**Verify:** HTTP 401 with body `{"ok":false,"error":"Unauthorized"}`.

### 10c. Cancellation link for already-cancelled appointment

After running Scenario 5, click the same Cancel link again.

**Verify:** the page handles the second click gracefully (either
"already cancelled" state or a no-op). No crash, no double-cancellation
audit row.

### 10d. Reschedule to a slot no longer available

Open the reschedule page in two browser tabs. In Tab 1, book the slot via
the in-app calendar (or another reschedule link). In Tab 2, try to pick
the same slot.

**Verify:** Tab 2 shows "That slot was just taken. Pick another." The
original appointment is **not** cancelled, the new appointment is **not**
created.

### 10e. Token enumeration

```bash
curl -i "$HONE_URL/cancel/aaaaaa"
curl -i "$HONE_URL/cancel/$(openssl rand -base64 24 | tr -d '=' | tr '+/' '-_')"
```

**Verify:** both render the public page with "This cancellation link is
no longer valid." No data leakage, no 500.

---

## Cleanup

After testing, reset any mutated rows to sane state and remove the test
client's appointments if they accumulated:

```sql
-- Optional: hard-delete test appointments
delete from public.appointments
  where client_id = '<TEST_CLIENT_ID>'
    and created_at > '<your-test-session-start>';
```

Or just leave them and let the soft-delete / status fields tell the story.

## Pass criteria

All 10 scenarios + 10a-10e pass. If any scenario fails:

- Cron returning 401: `CRON_SECRET` mismatch between Vercel env vars and
  the Authorization header you sent.
- Cron returning 200 but no email: check Resend dashboard for delivery
  failures. Could also be the studio toggle being off.
- Migration verification queries returning unexpected counts: re-run
  `supabase/migrations/0025_email_system.sql`.
- Reschedule page shows "Reschedule link unavailable": the token in the
  URL doesn't match `appointments.cancellation_token` for any row.
