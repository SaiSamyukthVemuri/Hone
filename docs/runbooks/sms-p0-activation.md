# SMS P0 — production activation and Willow acceptance

**Scope:** SMS-00 (#812, migration `0206`), SMS-02 (#813) and SMS-01 (waitlist invitation texts).

**Status: NOTHING BELOW HAS BEEN DONE.** Every step that touches production — a migration apply, a deploy, a studio switch, a real message — needs the operator's explicit approval **at that step**. Approval of one step is not approval of the next.

Related: [migration-first-process.md](./migration-first-process.md) · [../08_EMAIL_SMS_AND_CRON.md](../08_EMAIL_SMS_AND_CRON.md) · [../10_DEPLOYMENT_AND_ENV.md](../10_DEPLOYMENT_AND_ENV.md)

---

## 0. Order

| # | Unit | Gate |
|---|---|---|
| 1 | **SMS-00 (#812)** | **Migration first:** apply `0206` from the exact reviewed head (§1), then merge. |
| 2 | SMS-02: replacement PR for the closed #813 | After #812. A new PR from a new branch, with fresh CI and one exact-head review (operator decision D5(A): a retargeted PR cannot become shepherd-ready). No migration. |
| 3 | SMS-01: replacement PR for the closed #814 | After SMS-02, the same way. No migration. |

Merging and deploying all three **sends nothing new by itself**:
- every new path is behind a studio switch that defaults off;
- every recipient must have recorded consent and no STOP. For prospects verification is optional (§5);
- non-production deployments are fenced.

## 1. Apply `0206` (operator)

1. Re-run `npm run migration:state` on the reviewed head. Repo max `0206`, hosted `0205`, **MIGRATION-FIRST PENDING**.
   - ⚠️ The parked WAIT-v4 PR0 candidate holds a *different*, local-only `0206`. It was never pushed and holds no claim. Whichever of the two lands second re-derives its number.
2. Confirm the linked project ref is the production Hone project, as in `migration-first-process.md`.
3. Apply, then verify on production:

```sql
select max(version) from supabase_migrations.schema_migrations;            -- '0206'
select relrowsecurity from pg_class where oid = 'public.sms_outbound_messages'::regclass;  -- true
select count(*) from pg_policies where tablename = 'sms_outbound_messages';                -- 0
select has_table_privilege('authenticated','public.sms_outbound_messages','SELECT'),
       has_table_privilege('service_role','public.sms_outbound_messages','SELECT');        -- false, false
select has_function_privilege('authenticated','public.settle_sms_message(uuid,text,text,integer,text)','EXECUTE'),
       has_function_privilege('service_role','public.settle_sms_message(uuid,text,text,integer,text)','EXECUTE'); -- false, true
select count(*) filter (where send_waitlist_invitation_sms) from public.studios;            -- 0
```

4. In the **same change**, record the apply: `docs/production/migration-state.json` (`hosted_migration_max` → `0206`) and the ledger's current block.

## 2. Configuration check (read-only; names, never values)

- **Production must have:**
  - `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`;
  - `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`;
  - **`TWILIO_WEBHOOK_BASE_URL`** = `https://hone.care`. Without it no delivery reports are requested: sends still work, but outcomes stop at `accepted` / `unknown`.
- **`HONE_SMS_NON_PRODUCTION_SENDS` must be unset everywhere**, previews especially: they run against the production database.
- **No Twilio Console change is needed.** The StatusCallback is set per message. `/api/twilio/message-status` verifies the signature with the existing Auth Token.

## 3. Controlled live test (operator's own phone, explicit approval)

Use a controlled studio, never Willow, and an operator-owned client and phone with recorded consent.

| Test | Expectation |
|---|---|
| Confirmation | Book on production → one SMS → ledger row `accepted` → `delivered` |
| 24h reminder | An appointment ~24h out; the next cron fire sends **one** reminder in the studio's local time, and its manage link opens |
| Move before the send | Move an appointment whose reminder has **not** gone out yet → its next reminder names the **new** time (the helper re-reads the start after the claim) |
| Cancel | Cancel before the window → no reminder |
| STOP | Reply STOP → `clients.sms_opted_out_at` stamped → no further SMS |
| Waitlist (only if §5 is armed) | Invite a verified, consenting test prospect → **one** text with the secure link and the email's deadline |

Ledger check after each test:

```sql
select purpose, status, skip_reason, provider_error_code, claimed_at, settled_at, provider_status_at
  from public.sms_outbound_messages
 where studio_id = '<controlled studio id>'
 order by claimed_at desc limit 20;
```

## 4. Enable for Willow (operator SQL, explicit approval)

There is no owner-facing switch yet (follow-up). Enable per studio:

```sql
-- SMS-02: appointment reminders (24h and 2h are separate switches)
update public.studios set send_24h_sms_reminders = true, send_2h_sms_reminders = true
 where id = '<willow studio id>';
-- SMS-01: waitlist invitation texts
update public.studios set send_waitlist_invitation_sms = true
 where id = '<willow studio id>';
```

Each switch only *permits*. Delivery still requires:
- the recipient's consent;
- for prospects, consent recorded with their stored number; verification is optional (§5);
- no STOP;
- a production deployment.

## 5. SMS-01 eligibility: consent and no STOP (verification optional)

Since Roadmap v1.25 (operator decision D4(2), 2026-10-08), `prospectMayReceiveSms` allows a text on **recorded consent and no STOP**. A verified mobile is optional strengthening, never a gate, because OTP / Twilio Verify is not a WAIT launch prerequisite. Mobile verification itself stays dormant (`HONE_MOBILE_VERIFICATION_LIVE`, the Twilio Verify service, the WAIT-04B capability flag), and SMS-01 does not need it.

**What still protects the prospect:**
- **Consent bound to one number.** Consent is recorded only beside a phone (the join and the completion both require one), and a stored phone can never be replaced or cleared (0202/0203). The claim reads both from one locked row, so the text goes to the number the consent was given with.
- **STOP.** It is phone-wide and terminal, and reaches prospect rows through the inbound route.
- **Phone validation.** A number that does not normalise is recorded `skipped` / `invalid_phone` and never tried.
- **The production fence.** Previews and other non-production deployments record `skipped` / `non_production_deployment`.

**Accepted residual.** Nobody proves the number reaches the person. A mistyped number, or a join that pairs someone's name and email with a phone the submitter controls, receives the invitation text and its booking link. STOP ends it.

The join form and the completion panel now say: "Check this is your own mobile number. If you agree to texts, they'll go to this number."

## 6. Monitoring

```sql
-- outcomes in the last day
select purpose, status, skip_reason, count(*)
  from public.sms_outbound_messages
 where claimed_at > now() - interval '1 day'
 group by 1,2,3 order by 1,2,3;

-- ambiguous attempts nobody has reported on
select id, purpose, studio_id, claimed_at
  from public.sms_outbound_messages
 where status in ('unknown','claimed') and claimed_at < now() - interval '1 hour';

-- D1(a), the accepted residual duplicate window: more than one attempt that may
-- have reached the provider for one appointment's reminder. Expect zero rows;
-- any row is a duplicate, or an attempt whose outcome needs reading.
select appointment_id, purpose, count(*) as attempts
  from public.sms_outbound_messages
 where purpose in ('appointment_reminder_24h', 'appointment_reminder_2h')
   and status not in ('skipped', 'refused')
 group by 1, 2
having count(*) > 1;
```

- **`ops_alerts`:** `sms_delivery_failed` (one per undelivered/failed message) and `sms_send_failed` (a send gave up: refused, ambiguous, or out of attempts).
- **Heartbeat:** the admin page's reminder heartbeat carries the SMS attempted/succeeded/failed counts.

## 7. Rollback

- **Per studio, immediate:** turn the switches off (§4 with `false`). The next cron fire, or the next invitation, sends nothing.
- **No data rollback is needed.** `0206` is additive (no trigger on any existing table), and the ledger holds no body or phone number.

## 8. Willow acceptance (real device, the Willow owner)

- [ ] A 24h and a 2h reminder arrive for a real appointment, in Willow's local time, with a working manage link.
- [ ] Moving an appointment **before** its reminder goes out produces a reminder naming the new time. Cancelling it stops the reminders.
- [ ] STOP stops texts. Email reminders continue.
- [ ] An invited, consenting prospect receives exactly one text. Its link opens the invitation, and its deadline matches the email.
- [ ] No duplicate text in any of the above (ledger: one `accepted` per message).
- [ ] An undelivered text appears as an `sms_delivery_failed` alert.

## Known limitations (deliberate, follow-ups)

- **Accepted for P0 by operator decision (2026-10-08), carried by SMS-03 (`docs/13`):**
  - **D1(a), the residual duplicate window.** An invocation that dies, or a `record_sms_result` that errors, in the one round trip after Twilio accepted can lead to one repeat reminder about 15 minutes later. It is monitored by the §6 query.
  - **D2(a), the in-flight cancel/move window (Codex P1 4224110906).** A cancel or move that commits while the provider call is in flight is not seen. The window is typically under a second, and the email reminder has the same one.
- **D4(2): prospect numbers are not verified (§5).** This is accepted under Roadmap v1.25.

- **A move after a reminder already went out gets no new reminder** (email and SMS, unchanged from before SMS-02). Specified follow-up **SMS-03** in `docs/13_BACKLOG_AND_DECISIONS.md`, with its design, required tests and acceptance criteria. Willow acceptance should not move an already-reminded appointment and expect a second reminder.
- **No owner UI for the SMS switches:** SQL only (§4).
- **The practitioner's invitation result shows the email's disposition.** The text's outcome lives in the ledger.
- **An attempt Twilio never reports on stays `unknown`** (§6 query).
- **Per-studio senders (#716) are still held:** all SMS use the shared platform sender, per the 2026-09-18 decision.
