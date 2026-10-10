# SMS P0 — production activation and Willow acceptance

**Scope:**
- SMS-00 (#812, migrations `0206` and `0207`);
- SMS-02 (#818, replacing #813);
- SMS-01 (#819, replacing #814, migration `0208`): waitlist invitation texts and recorded consent;
- SMS-04 (migration `0210`): a phone number required on every new public waitlist signup, the version-2 text question, and the one waitlist join acknowledgement text.

**Status (2026-10-10).**
- **Done:**
  - `0206` and `0207` were applied to production (§1);
  - SMS-00 merged as `46a1db9e`;
  - SMS-02 merged and deployed as `1bdc10ba`.
  - Willow's confirmation and 24h/2h reminder switches were already on before SMS-02. SMS-02 changed their send path, not the switches.
  - `0208` was applied and verified on production on 2026-10-10 (§1b), migration-first, before the SMS-01 merge.
  - SMS-01 merged and deployed as `4564383c` (2026-10-10).
- **Pending:**
  1. Willow's consent backfill (§5);
  2. the controlled tests (§3);
  3. Willow's waitlist switch (§4);
  4. SMS-04: its own review, then `0210` after WAIT #820's `0209` (§1c), then its merge and deploy.

Every step that touches production — a migration apply, a deploy, a studio switch, a real message — needs the operator's explicit approval **at that step**. Approval of one step is not approval of the next.

Related: [migration-first-process.md](./migration-first-process.md) · [../08_EMAIL_SMS_AND_CRON.md](../08_EMAIL_SMS_AND_CRON.md) · [../10_DEPLOYMENT_AND_ENV.md](../10_DEPLOYMENT_AND_ENV.md)

---

## 0. Order

| # | Unit | Migration | Gate | Status |
|---|---|---|---|---|
| 1 | **SMS-00 (#812)** | `0206`, `0207` | **Migration first:** apply each from the exact reviewed head (§1), then merge. | **Done.** Applied 2026-10-09; merged as `46a1db9e`. |
| 2 | **SMS-02 (#818)**, replacing the closed #813 | none | After SMS-00. A new PR from a new branch, with fresh CI and one exact-head review (operator decision D5(A): a retargeted PR cannot become shepherd-ready). | **Done.** Merged and deployed as `1bdc10ba`. |
| 3 | **SMS-01 (#819)**, replacing the closed #814 | **`0208`** | After SMS-02. **Migration first: apply and verify `0208` (§1b) from the exact reviewed head, then merge and deploy the application.** The new public signup calls `join_new_client_waitlist_with_sms_answer`, which exists only after `0208`, so deploying first makes every durable public waitlist join fail. | **Done.** `0208` applied and verified 2026-10-10; merged and deployed as `4564383c`. |
| 4 | **SMS-04**, required phone and the join text | **`0210`** | After SMS-01, **and after WAIT #820's `0209` is merged and applied** (`0209` is reserved by #820; apply order is `0209`, then `0210`). **Migration first: apply and verify `0210` (§1c) from the exact reviewed head, then merge and deploy the application.** The new public signup calls `join_new_client_waitlist_with_phone_and_sms_answer`, which exists only after `0210`, so deploying first makes every durable public waitlist join fail. `0208`'s command stays, so the deployed application keeps working (and keeps recording v1) until the new one replaces it. | Authored; awaiting review. Not applied. |

**Whether a migration is still pending is DERIVED, never restated:** run `npm run migration:state` on the head. A unit's migration-first gate holds while it reads **MIGRATION-FIRST PENDING** for that unit's migration.

Merging and deploying all four **sends nothing new by itself**:
- every new path is behind a studio switch that defaults off;
- every recipient must have recorded consent and no STOP. For prospects verification is optional (§5);
- non-production deployments are fenced.

## 1. Apply `0206` (operator) — DONE 2026-10-09, with `0207`

**Done.** `0206` was applied from the reviewed #812 head on 2026-10-09, and `0207` (the serialized invitation claim) from `2998b6a3` the same night. Both are recorded in `docs/production/migration-state.json` and the ledger. The steps are kept as the record of what was run.

1. Re-run `npm run migration:state` on the reviewed head. Repo max `0206`, hosted `0205`, **MIGRATION-FIRST PENDING**.
   - SMS-00's `0206` landed first. The parked WAIT-v4 PR0 candidate's local-only `0206` was never pushed and holds no claim, so it re-derives its number.
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

## 1b. Apply and verify `0208` (operator) — BEFORE the SMS-01 merge and deploy — DONE 2026-10-10

**Done.** Applied on 2026-10-10 from the reviewed #819 head `82d2ef1a`, and verified read-only. It is recorded in `docs/production/migration-state.json` and the ledger. The steps are kept as the record of what was run.

`0208_waitlist_sms_consent_practitioner_and_signup_answer.sql` is forward-only and writes no data. It is safe with the application already deployed: everything it adds is nullable or new, and that application calls neither of its commands. It must be applied **before** SMS-01's application deploys, because that application's signup calls `join_new_client_waitlist_with_sms_answer`.

1. **Derive the state.** On the exact reviewed head, run `npm run migration:state`. Expect repo max `0208`, hosted `0207`, **MIGRATION-FIRST PENDING**, next free `0209`.
2. **Use a throwaway worktree.** Work in a detached worktree at that head, never a shared checkout. Run `supabase link --project-ref alhhybgqdmcdyzpybykj`, then confirm `supabase/.temp/project-ref` and the project name **Hone**, never Hone Staging, as `migration-first-process.md` describes.
3. **Check the file.** Its sha256 must equal the value recorded in the reviewed PR.
4. **List the migrations.** `supabase migration list --linked` must show `0208` as the only local-only row, and no remote-only row.
5. **Dry-run.** `supabase db push --linked --dry-run` must list exactly `0208_waitlist_sms_consent_practitioner_and_signup_answer.sql`.
6. **Preflight (read-only).** The count of entries with `sms_consent_source = 'practitioner'` must be 0; otherwise 0208's own preflight refuses. Note the consents and entries totals.
7. **Apply once.** Run `supabase db push --linked --yes`, with no `--include-all`. Capture the exit code and the apply window.
8. **Verify on production (read-only):**

```sql
select max(version) from supabase_migrations.schema_migrations;                       -- '0208'
select count(*) from supabase_migrations.schema_migrations where version = '0208';   -- 1
select count(*) from information_schema.columns
 where table_schema = 'public' and table_name = 'new_client_waitlist_entries'
   and is_nullable = 'YES'
   and column_name in ('sms_consent_recorded_by_practitioner_id', 'sms_consent_scope',
                       'sms_consent_evidence_ref', 'sms_consent_given_on');           -- 4
select pg_get_functiondef('public.new_client_waitlist_entries_transition_guard()'::regprocedure)
       ~ 'may not be replaced or cleared';                                            -- true (write-once)
select has_function_privilege('anon','public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean)','EXECUTE'),
       has_function_privilege('service_role','public.join_new_client_waitlist_with_sms_answer(uuid, text, text, text, boolean, boolean)','EXECUTE');  -- false, true
select has_function_privilege('authenticated','public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date)','EXECUTE'),
       has_function_privilege('service_role','public.record_waitlist_sms_consent_by_practitioner(uuid, uuid, uuid, text, text, boolean, date)','EXECUTE');  -- false, true
select count(*) from public.new_client_waitlist_entries where sms_consent_source = 'practitioner';  -- 0
select count(*) filter (where send_waitlist_invitation_sms) from public.studios;     -- 0
```

   The consents and entries totals must match step 6, and every studio's SMS switches must be unchanged.
9. **Clean up.** Remove `supabase/.temp`, then delete the worktree.
10. **Record it in a change on the SMS-01 PR:** `docs/production/migration-state.json` (`hosted_migration_max` → `0208`) and the ledger's current block, giving PARITY and next free `0209`. That moves the PR head, so it needs fresh CI and an exact-head review before the merge approval.

## 1c. Apply and verify `0210` (operator) — AFTER WAIT #820's `0209`, BEFORE the SMS-04 merge and deploy

`0210_sms_waitlist_join_acknowledgement.sql` is forward-only and writes no data. It adds:
- the signup command `join_new_client_waitlist_with_phone_and_sms_answer`, which requires a phone and records v2;
- the join-text claim `claim_waitlist_join_ack_sms`;
- the ledger's fifth purpose, with its subject column, checks and once-per-entry index;
- the widened wording-version check (v1 or v2).

`0208`'s signup command is kept, so the deployed application keeps working through the apply.

1. **Order.** WAIT #820 (`0209`) must be merged into production and `0209` applied first. Then merge production into the SMS-04 branch. Its census must read hosted `0209` and repo max `0210`, with only `0210` pending.
2. **The same procedure as §1b**, steps 2 to 9:
   - a throwaway worktree at the exact reviewed head;
   - the linked project confirmed as **Hone** (`alhhybgqdmcdyzpybykj`);
   - the file's sha256 equal to the reviewed value;
   - `supabase migration list --linked` showing `0210` as the only local-only row;
   - a dry run listing exactly `0210_sms_waitlist_join_acknowledgement.sql`;
   - one `supabase db push --linked --yes`, with no `--include-all`;
   - read-only verification, then clean-up.
3. **Verify (read-only):**

```sql
select max(version) from supabase_migrations.schema_migrations;                       -- '0210'
select has_function_privilege('anon','public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean)','EXECUTE'),
       has_function_privilege('service_role','public.join_new_client_waitlist_with_phone_and_sms_answer(uuid, text, text, text, boolean, boolean)','EXECUTE');  -- false, true
select has_function_privilege('authenticated','public.claim_waitlist_join_ack_sms(uuid, uuid)','EXECUTE'),
       has_function_privilege('service_role','public.claim_waitlist_join_ack_sms(uuid, uuid)','EXECUTE');  -- false, true
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'new_client_waitlist_entries_sms_consent_text_version_check';      -- v1 or v2
select count(*) from public.sms_outbound_messages where waitlist_entry_id is not null;  -- 0
select count(*) filter (where send_waitlist_invitation_sms) from public.studios;     -- unchanged
```

   The entries and consents totals, every studio's SMS switches and the ledger row count must be unchanged.
4. **Record it in a change on the SMS-04 PR:** `docs/production/migration-state.json` (`hosted_migration_max` → `0210`) and the ledger's current block. That moves the PR head, so it needs fresh CI and an exact-head review before the merge approval.

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
| Waitlist (only after `0208` is applied, SMS-01 is deployed, and the controlled studio's waitlist switch is on) | Invite a consenting test prospect (verification optional, §5) → **one** text with the secure link and the email's deadline |
| Join text (only after `0210` is applied, SMS-04 is deployed, and the controlled studio's waitlist switch is on) | A NEW public join with the test number and **Yes** → **one** text: "`<Studio>`: you've joined our waitlist. We'll contact you when you're invited to book. Reply STOP to opt out." A resubmission with the same email sends none. A **No** joins (a phone is still required) and gets none. A blank or invalid phone is refused by the form and the server. |

Ledger check after each test:

```sql
select purpose, status, skip_reason, provider_error_code, claimed_at, settled_at, provider_status_at
  from public.sms_outbound_messages
 where studio_id = '<controlled studio id>'
 order by claimed_at desc limit 20;
```

## 4. Enable for Willow (operator SQL, explicit approval)

There is no owner-facing switch yet (follow-up). Enable per studio.

**Willow's 24h and 2h reminder switches (and confirmations) were already on before SMS-02**, and they are unchanged. The first statement below is for any other studio. Willow's remaining step is the waitlist switch, and only **after** `0208` is applied (§1b), SMS-01 is deployed, and the consent backfill is applied and verified (§5). Each of those is its own approval.

```sql
-- SMS-02: appointment reminders (24h and 2h are separate switches)
update public.studios set send_24h_sms_reminders = true, send_2h_sms_reminders = true
 where id = '<studio id>';
-- SMS-01: waitlist invitation texts
update public.studios set send_waitlist_invitation_sms = true
 where id = '<willow studio id>';
```

Each switch only *permits*. Delivery still requires:
- the recipient's consent;
- for prospects, consent recorded with their stored number; verification is optional (§5);
- no STOP;
- a production deployment.

**SMS-04: what the waitlist switch also permits, once `0210` is applied and SMS-04 is deployed.**
- The same switch permits the one join text, for **new** public joins only.
- **Turning it on sends nothing by itself.** No job texts existing entries. An invitation text goes only with an owner's "Invite to book", and a join text only in the request that created a new entry.
- Nobody already on the waitlist ever gets a join text, whatever their consent.

## 5. SMS-01 eligibility: consent and no STOP (verification optional)

Since Roadmap v1.25 (operator decision D4(2), 2026-10-08), `prospectMayReceiveSms` allows a text on **recorded consent and no STOP**. A verified mobile is optional strengthening, never a gate, because OTP / Twilio Verify is not a WAIT launch prerequisite. Mobile verification itself stays dormant (`HONE_MOBILE_VERIFICATION_LIVE`, the Twilio Verify service, the WAIT-04B capability flag), and SMS-01 does not need it.

**What still protects the prospect:**
- **Consent bound to one number.** Consent is recorded only beside a phone, and a stored phone can never be replaced or cleared (0202/0203). The claim reads both from one locked row, so the text goes to the number the consent was given with.
- **STOP.** It is phone-wide and terminal, and reaches prospect rows through the inbound route. Since 0208 the sender also re-reads it phone-wide just before texting, so a row created after the STOP is covered; a failed read is `skipped` / `suppression_check_failed`.
- **Phone validation.** A number that does not normalise is recorded `skipped` / `invalid_phone` and never tried.
- **The production fence.** Previews and other non-production deployments record `skipped` / `non_production_deployment`.

**Accepted residual.** Nobody proves the number reaches the person. A mistyped number, or a join that pairs someone's name and email with a phone the submitter controls, receives the invitation text and its booking link. STOP ends it.

**Correction (2026-10-09).** An earlier revision said the join form and the completion panel showed "Check this is your own mobile number. If you agree to texts, they'll go to this number." They did not: those two surfaces (`WaitlistJoinForm`, `CompleteProfilePanel`) are not routed in production. The **live** form is `app/book/[slug]/NewClientWaitlistForm.tsx`, and it shows that note only from 0208's change onward.

**How consent is recorded (0208, applied 2026-10-10; its application change is pending).** Until SMS-01's application is deployed, **no live path records prospect consent**: the live form never asked, so no prospect is textable. 0208 adds the only two paths:
- **The signup answer.** The live form asks the approved sentence with Yes / No, neither preselected. A Yes is recorded on the new entry (`public_form`, v1). A No joins the same way and records nothing.
- **The owner's record of consent given outside Hone** (`/settings/waitlist`): source `practitioner`, who recorded it, scope `waitlist_operational`, an evidence reference, the recording time, and the day they agreed only when known.

Existing Willow prospects who agreed directly with the studio are recorded through the second path, from the bounded backfill packet (`/srv/hone/handoffs/SMS_01_CONSENT_PATCH_AND_WILLOW_BACKFILL_2026-10-09.md`), after 0208 is applied. **0208 is migration-first:** apply it before deploying the application that calls its commands.

**SMS-04 (0210): a required phone, the version-2 question, and the join text.**
- **The signup.**
  - Name, email and phone number are required for every **new** public signup, whatever the answer. The form and the server action both apply `normalizePhoneForSms`, and the command refuses an unsendable number too. There is no verification code.
  - The question is version 2: "May we text you about joining this waitlist and any appointment offered from it? Reply STOP at any time to opt out." A Yes is recorded as `waitlist_sms_operational_v2`. v1 answers keep v1.
  - A No still joins, with the same entry, emails and place.
  - Existing entries, email-only ones included, are untouched.
- **The join text** goes once to a **genuinely new** public join. Each of these must hold:
  - its own v2 Yes, recorded in the join itself;
  - the join less than 15 minutes old;
  - the studio's waitlist texts on;
  - no earlier join text for that entry;
  - no join text that may have reached the same number in the last 24 hours, in any studio;
  - then the same checks as the invitation text: STOP phone-wide, a usable number, and the production fence.
- **Who never gets it:**
  - people already waiting;
  - consent recorded by the owner or the backfill;
  - a v1 Yes;
  - a No;
  - a resubmission.
- **The text** carries no link. The booking link only comes with an invitation.

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

-- SMS-04: join texts in the last day, and never more than one per entry (expect zero rows)
select status, skip_reason, count(*)
  from public.sms_outbound_messages
 where purpose = 'waitlist_join_acknowledgement' and claimed_at > now() - interval '1 day'
 group by 1, 2 order by 1, 2;
select waitlist_entry_id, count(*) from public.sms_outbound_messages
 where purpose = 'waitlist_join_acknowledgement'
 group by 1 having count(*) > 1;
```

- **`ops_alerts`:** `sms_delivery_failed` (one per undelivered/failed message) and `sms_send_failed` (a send gave up: refused, ambiguous, or out of attempts).
- **Heartbeat:** the admin page's reminder heartbeat carries the SMS attempted/succeeded/failed counts.

## 7. Rollback

- **Per studio, immediate:** turn the switches off (§4 with `false`). The next cron fire, or the next invitation, sends nothing.
- **No data rollback is needed.** None of the three migrations writes data:
  - `0206` is additive, with no trigger on any existing table;
  - `0207` redefines one function;
  - `0208` adds nullable columns and two `service_role` commands, and replaces checks and a guard that every existing row already satisfies.

  Rolling the application back after `0208` is safe: the earlier application calls neither command. The ledger holds no body or phone number. The consent backfill's records are a separate, approved write, and consent evidence is write-once.
- **`0210` writes no data either.** Rolling the SMS-04 application back is safe: the earlier application calls `0208`'s signup command, which `0210` leaves in place, and never calls the join-text claim. Turning the waitlist switch off stops join texts at once.

## 8. Willow acceptance (real device, the Willow owner)

- [ ] A 24h and a 2h reminder arrive for a real appointment, in Willow's local time, with a working manage link.
- [ ] Moving an appointment **before** its reminder goes out produces a reminder naming the new time. Cancelling it stops the reminders.
- [ ] STOP stops texts. Email reminders continue.
- [ ] An invited, consenting prospect receives exactly one text. Its link opens the invitation, and its deadline matches the email.
- [ ] (SMS-04) A NEW joiner who answers Yes receives exactly one join text. A resubmission and a No receive none, and nobody already waiting receives one.
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
- **SMS-04: one join text per number per 24 hours, across studios.** Two people sharing a number, or one person joining two studios in a day, get one join text. Each still gets the email acknowledgement.
- **SMS-04: the join text belongs to the joining request.** If that request's post-response work never runs within 15 minutes, no join text is sent later. The email acknowledgement is unaffected.
- **SMS-04: `0208`'s signup command is kept** for the rollout window. Retiring it is a later, separate migration.
