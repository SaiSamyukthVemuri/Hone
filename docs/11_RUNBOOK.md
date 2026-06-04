# 11 Runbook

Operational recipes for after-deploy checks, incident response, and the SQL needed to investigate the state of the system. Audience: developer + operator (Sam).

## After every deploy

1. `gh pr view <N> --json mergeCommit,state`; confirm merge SHA.
2. Poll Vercel commit status to `success`:
   ```bash
   SHA=<merge-commit-sha>
   gh api "repos/SaiSamyukthVemuri/Hone/commits/${SHA}/status" --jq '.state'
   ```
3. Verify the production deployment is `READY` via Vercel MCP `get_deployment` (target=production, aliased to `hone.care`).
4. Run anonymous smoke ([docs/12 §10](./12_SMOKE_TESTS.md#10-security-route-smoke)).
5. Confirm the global browser security headers (PR #150) are present on production routes:
   ```bash
   curl -sI https://hone.care/book/willow-electrolysis \
     | grep -iE '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy)'
   ```
   Expected: every header listed; `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin`; CSP contains `frame-ancestors 'none'`. The token-route block additionally overrides `Referrer-Policy: no-referrer` on `/cancel/:token*`, `/reschedule/:token*`, `/manage/:token*`, `/intake/:token*`, `/portal/verify/:token*`, `/calendar-feed/:token*`.

## After every migration

1. `supabase migration list --linked`; confirm only the new file is missing remote.
2. `supabase db push --linked`; apply.
3. `supabase db query --linked "<verify the new column/table/RPC>"`; confirm.
4. Only then merge the code PR that references the new schema.

## Public route smoke

```bash
curl -sI -o /dev/null -w "%{http_code} -> %{redirect_url}\n" \
  "https://hone.care/book/willow-electrolysis"

curl -sI "https://hone.care/cancel/fake" \
  | grep -iE '^(x-robots-tag|referrer-policy)'
```

Expected:
- `/book/willow-electrolysis` returns `200`.
- `/cancel/fake` returns `200` with both `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`.

## Portal smoke

Manual (cannot be done from the harness).

1. Request a magic link at `/portal/login?studio=willow-electrolysis` with a test client's email.
2. Open the email; click the link.
3. Confirm `/portal/verify/<token>` shows the Continue form (not the consumed-token surface); i.e. the GET is non-consuming.
4. Click Continue. Verify the `hone_portal_session` cookie is set (httpOnly, secure).
5. Land on `/portal`. Verify the two-zone layout (Needs you / Your info).
6. Sign out (or wait for cookie expiry) and confirm `/portal/messages` redirects to `/login` (the global app login surface) when anonymous.

## Stripe card-on-file smoke (test mode)

1. From `/settings/payments`, confirm Stripe Connect is `enabled` with `chargesEnabled=true`.
2. On a test client's `/portal`, sign and submit a `card_authorization` form if not already.
3. Add a card via the portal Stripe Elements form with test card `4242 4242 4242 4242`.
4. Verify webhook delivery in Stripe Dashboard → Developers → Webhooks. Look for `setup_intent.succeeded`.
5. SQL:
   ```sql
   select id, brand, last4, exp_month, exp_year, status,
          stripe_account_id, stripe_livemode, stripe_customer_id,
          stripe_payment_method_id, card_authorization_signature_id,
          added_via, added_at
     from public.client_payment_methods
    where studio_id = '<studio uuid>'
      and client_id = '<client uuid>'
    order by added_at desc;
   ```
   Expected: one `status='active'` row with `stripe_livemode=false` and `card_authorization_signature_id is not null`.

## Manual fee test charge smoke (test mode)

1. On a cancelled or no-show test appointment, confirm full evidence stack:
   - Active card on file.
   - Signed card authorization.
   - Policy acknowledgement for this appointment.
   - Fee amount configured in `/settings/payments`.
2. Open `/calendar/<appointment-id>`. The "Cancellation/no-show fee" card should render.
3. Verify the test-mode banner is visible.
4. If the attempt is not yet prepared: pick a charge type, add an internal note, click "Prepare manual fee charge". Confirm the row appears with `status='ready'`.
5. Click "Run test charge". On success:
   - The card flips to the "Test charge succeeded" panel.
   - The PaymentIntent id is shown.
6. SQL:
   ```sql
   select id, charge_type, status, amount_cents, currency,
          stripe_livemode, stripe_account_id,
          stripe_payment_intent_id, stripe_charge_id,
          stripe_idempotency_key, charged_at,
          failed_at, failure_code, failure_message,
          cancelled_at, cancelled_reason
     from public.manual_fee_charge_attempts
    where appointment_id = '<appointment uuid>'
    order by created_at desc;
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated (`pi_…`), `stripe_charge_id` populated, `stripe_idempotency_key = 'hone:manual-fee:<attempt-id>:v1'`, `charged_at` set.
7. Refresh the appointment detail page and click "Run test charge" again. The action should short-circuit via `already_succeeded`; no second PaymentIntent is created. Verify in Stripe Dashboard → Payments under the connected account: exactly one PaymentIntent + Charge.

## Webhook delivery checks

Stripe Dashboard → Developers → Webhooks → `<connected-account endpoint>` → Recent deliveries.

Verify the signing secret matches `STRIPE_WEBHOOK_SECRET` in Vercel. Mismatch shows up as 400 responses on every event. Stripe will retry; fix the secret in Vercel env and re-deliver.

SQL ledger:

```sql
select stripe_event_id, event_type, stripe_account_id, stripe_livemode,
       studio_id, processed_at, processing_error,
       payload_summary, created_at
  from public.stripe_events
 order by created_at desc
 limit 20;
```

Look at `processed_at` (when it succeeded), `processing_error` (sanitized failure), and `payload_summary` (per-event metadata Hone chose to record).

## Failed email handling

The per-appointment counters tell you what happened:

```sql
select id, status, starts_at,
       confirmation_send_attempts, confirmation_sent_at,
       reminder_24h_send_attempts, reminder_24h_sent_at,
       reminder_2h_send_attempts, reminder_2h_sent_at,
       no_show_email_send_attempts, no_show_email_sent_at,
       postcare_email_send_attempts, postcare_email_sent_at
  from public.appointments
 where studio_id = '<studio uuid>'
   and starts_at > now() - interval '7 days'
 order by starts_at desc
 limit 20;
```

- `attempts > 0` and `sent_at IS NULL` → Resend rejected the message. Check Resend dashboard.
- `attempts >= 3` and `sent_at IS NULL` → 3-strike out; no more retries from the cron.
- The cron only ever picks rows where `attempts < 3` AND the matching `_sent_at IS NULL`.

## Failed SMS handling

```sql
select appointment_id, kind, claimed_at, sent_at, twilio_sid,
       failure_code, failure_message
  from public.sms_send_attempts
 order by claimed_at desc
 limit 30;
```

Look for `failure_code = 21610` (opt-out; the recipient previously sent STOP). The client's `sms_opted_out_at` should be set; if not, the STOP webhook may have missed delivery.

## Pending manual fee charge handling

```sql
select id, appointment_id, charge_type, status, amount_cents,
       stripe_payment_intent_id, stripe_idempotency_key,
       updated_at,
       extract(epoch from (now() - updated_at)) / 60 as minutes_since_claim
  from public.manual_fee_charge_attempts
 where status = 'pending_stripe'
 order by updated_at;
```

Per row:

- `stripe_payment_intent_id` set + `minutes_since_claim` any → next click runs `paymentIntents.retrieve` and finalizes.
- `stripe_payment_intent_id` null + `minutes_since_claim ≤ 60` → next click retries with same idempotency key; Stripe replays.
- `stripe_payment_intent_id` null + `minutes_since_claim > 60` → action returns `needs_manual_review`. Operator must reconcile by hand:
  1. Search Stripe Dashboard for a PaymentIntent on the connected account with `metadata.hone_manual_fee_charge_attempt_id = <id>`.
  2. If found: manually UPDATE the row with the PI id + result.
  3. If not found: manually UPDATE the row to `failed` or `cancelled` with a clear reason; the next prepare for the same `(appointment, charge_type)` will succeed.

## Webhook signature error handling

If every webhook is returning 400 with "signature mismatch":

1. Confirm Stripe Dashboard → Webhook → Signing secret matches `STRIPE_WEBHOOK_SECRET` in Vercel (Project → Settings → Environment Variables → Production).
2. Confirm the webhook is configured on the **connected-account** webhook surface, not the platform webhook. Earlier issue: the platform-webhook secret was set in `STRIPE_WEBHOOK_SECRET` while the connected-account events were being sent to a different endpoint, producing endless invalid-signature replies.
3. After fixing, redeliver from the Stripe Dashboard.

## Rollback

1. Identify the offending merge commit SHA.
2. Locally:
   ```bash
   git checkout claude/build-hone-saas-hOex7
   git pull
   git revert -m 1 <merge-commit-sha>
   git push
   ```
3. Vercel auto-deploys the revert as the new production.
4. If the offender was a migration, the revert restores the code; the schema change remains unless a follow-up migration drops the new objects (migrations are additive; a deliberate teardown migration is the only correct removal path).

## How to disable charging safely

If the test-mode manual fee charge action needs to be quickly disabled:

1. In Vercel env, set a feature flag (no such flag exists today; add one before live mode); OR:
2. SQL-disable by setting both fee amounts to NULL:
   ```sql
   update public.studios
      set late_cancel_fee_cents = null,
          no_show_fee_cents     = null
    where id = '<studio uuid>';
   ```
   The eligibility helper will block every new prepare with "fee amount is not configured." Existing `ready` rows can still be charged; cancel them first if needed:
   ```sql
   update public.manual_fee_charge_attempts
      set status                       = 'cancelled',
          cancelled_at                 = now(),
          cancelled_by_practitioner_id = '<your practitioner uuid>',
          cancelled_reason             = 'Disabled by operator'
    where studio_id = '<studio uuid>'
      and status    = 'ready';
   ```

## Ops alerts (PR #153)

**Operator surface in PR #153: SQL + Vercel logs.** Operator email dispatch is deliberately not implemented; the alerts helper avoids importing `lib/email/send-appointment.ts` to keep a clean separation from the email subsystem it observes. `OPS_ALERT_EMAILS` is reserved in env docs but not read. A future PR may add a standalone `lib/ops/alert-email.ts` calling Resend directly.

The `ops_alerts` table (migration 0067) is the durable record of silent-failure states. Recent alerts:

```sql
select id, created_at, severity, event, message,
       studio_id, appointment_id, client_id,
       manual_fee_attempt_id, stripe_event_id,
       stripe_payment_intent_id, route, safe_details,
       resolved_at
  from public.ops_alerts
 order by created_at desc
 limit 50;
```

Open alerts only:

```sql
select id, created_at, severity, event, message, safe_details
  from public.ops_alerts
 where resolved_at is null
 order by created_at desc;
```

Critical alerts that need same-day investigation:

| Event | Surface | Most likely cause | Investigate |
|---|---|---|---|
| `manual_fee_needs_manual_review` | `lib/billing/manual-fee-charge.ts` (reconcile + run) | Pending `manual_fee_charge_attempts` row past 60-min reconciliation window; PI retrieve failed; unknown error after claim | Match `manual_fee_attempt_id` to the `manual_fee_charge_attempts` row; cross-check Stripe Dashboard PaymentIntent search by metadata `hone_manual_fee_charge_attempt_id` |
| `manual_fee_charge_failed` | Same module | StripeError caught (declined / authentication_required) or PI status post-create was `requires_action` / `canceled` / `requires_payment_method` | Read `failure_code` + `stripe_status` in `safe_details`; the attempt row already has sanitized `failure_code` / `failure_message` |
| `card_on_file_setup_failed` | `app/api/stripe/webhook` `setup_intent.succeeded` arm | Lineage mismatch / customer mismatch / signature mismatch / PaymentMethod retrieve failure / insert failure | Stripe Dashboard → SetupIntents on the connected account → match `stripe_event_id`; the client probably believes their card was saved but Hone has no `client_payment_methods` row |
| `stripe_webhook_processing_failed` | Same route, other event types | Generic webhook handler exception | Read `safe_details.event_type` + `safe_details.stripe_account_id`; `stripe_events.processing_error` carries the matching error string |
| `cron_route_failed` | `/api/cron/appointment-reminders` or `/api/cron/materialize-recurring-breaks` | Cron route threw at the top level | Vercel logs for the same `route` will carry the error stack; rerun the cron after the underlying issue is fixed |

Warning alerts (the operator dashboard surface, not paging):

| Event | Surface | Most likely cause |
|---|---|---|
| `email_send_gave_up` | `lib/email/send-appointment.ts:logEmailFailure` | 3 failed Resend attempts on the same appointment + email type |
| `sms_send_failed` | `lib/sms/send-appointment.ts:logSmsFailure` | Final-attempt SMS failure (non-retryable Twilio code or 3-strike) |
| `recurring_break_materialization_failures` | `/api/cron/materialize-recurring-breaks` | At least one recurring-break rule failed; usually 23P01 collisions with manually-scheduled appointments |

Resolving an alert (operator workflow):

```sql
update public.ops_alerts
   set resolved_at = now(),
       resolved_by_practitioner_id = '<your practitioner uuid>',
       resolution_note = 'Investigated; PaymentIntent ' ||
                         'pi_xxx succeeded in Stripe; manual_fee_charge_attempts row corrected.'
 where id = '<alert uuid>';
```

The DB CHECK enforces that `resolved_at` is set whenever `resolved_by_practitioner_id` or `resolution_note` are; partial updates fail.

## Vercel env checks

The Vercel MCP `get_project` does not expose env-var values. To check production env, use the Vercel dashboard:

- Project → Settings → Environment Variables → Production. Confirm `ADMIN_EMAILS`, `NEXT_PUBLIC_APP_ORIGIN=https://hone.care`, `PORTAL_FINGERPRINT_SALT`, `CRON_SECRET`, `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET`, `STRIPE_ALLOW_LIVE_MODE=false` (or unset), `RESEND_API_KEY`, Twilio vars if SMS is in use.
