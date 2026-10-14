# Delivery monitoring: activation and controlled acceptance (#824)

**Scope:** the delivery-monitoring stack. Each item is a draft PR.

| PR | Slice | Migration |
|---|---|---|
| #832 | DELIVERY-EVENTS-01: signed Resend event intake, receipts, email ledger | `0212` |
| #843 | DELIVERY-VISIBILITY-01: reminder email ledgering, deduplicated incidents, recovery sweep and heartbeat | `0215` |
| #846 | DELIVERY-VISIBILITY-02: owner delivery card, `/admin/delivery` support queue | none |
| #849 | DELIVERY-VISIBILITY-03: booking confirmation ledgering | none |
| #865 | DELIVERY-VISIBILITY-04: cancellation and postcare ledgering, "client says they didn't receive it" | `0221` |

**Status (2026-10-12):** `0211` and `0212` are **applied** to production, migration-first (D1; see [delivery-d1-release-packet.md](./delivery-d1-release-packet.md) and the migration ledger). Nothing else below has been done. No PR is merged, nothing is configured, no message has been sent, and `0215`/`0221` are not applied.

Every step that touches production needs the operator's explicit approval **at that step**:
- a migration apply;
- a merge or deploy;
- an environment variable;
- a Resend webhook endpoint;
- a cron registration;
- a real message.

Approval of one step is not approval of the next.

Related: [migration-first-process.md](./migration-first-process.md) · [../08_EMAIL_SMS_AND_CRON.md](../08_EMAIL_SMS_AND_CRON.md) · [../10_DEPLOYMENT_AND_ENV.md](../10_DEPLOYMENT_AND_ENV.md) · [sms-p0-activation.md](./sms-p0-activation.md)

---

## 0. The patient-data gate comes first (#828)

Resend states that it cannot sign a BAA. Patient-facing email through Resend is a HIPAA routing decision (D-4, #835), not something this stack settles.

What this stack adds stays inside the boundary #828 asked for:
- **No new content goes to Resend.** The only addition to a send is the opaque tag `hone_m = <ledger row id>`.
- **Nothing it stores holds an address, a subject, a body or a client name.** Ledger rows, receipts, incidents and concerns carry ids and codes only.

**Rules that hold until D-4 is decided:**
- **No emailed delivery alert to an owner or to support is built or enabled.** Owners see failures on the delivery card; support sees them at `/admin/delivery`. The existing critical-only `OPS_ALERT_EMAILS` path is unchanged, and the sweep's alerts carry counts only.
- **A Fett/US studio that handles PHI does not go live on email through Resend** while the routing gate is open. Its demo stays on synthetic data.
- **When D-4 picks a BAA-eligible provider** (e.g. Amazon SES under an executed AWS BAA), it joins the same ledger: a second receipt provider and normalizer. That is additive (#828 confirmation, 2026-10-12).

## 1. Order

| # | Step | Gate |
|---|---|---|
| 1 | Apply `0211` (#827), then `0212` (#832) | Migration-first, each from its exact reviewed head ([migration-first-process.md](./migration-first-process.md)). `supabase db push` applies in lexical order, so the hosted chain must already hold every lower pending number. |
| 2 | Merge #832 | After its `0212` apply. **Inert on merge**: the webhook answers 500 and records nothing without `RESEND_WEBHOOK_SECRET`, and no send path is tagged yet. |
| 3 | Apply `0213`, `0214` (other lanes), then `0215` (#843) | Migration-first. `0215` adds an AFTER trigger to **both** ledgers, including the live SMS ledger, so its first effect is that **SMS failures start opening incidents** in production. That is visibility only, with no message and no alert email. |
| 4 | Merge #843, #846, #849 | **Behaviour changes on merge:** reminder and confirmation emails begin creating ledger rows and carry the `hone_m` tag, and owners see the delivery card (Settings → Launch on this stack; Settings → Overview once #867 lands, which moves it). With no webhook yet, email rows stop at `accepted` / `refused` / `unknown`. The card and health say so; they do not claim delivery. |
| 5 | Apply `0216`-`0220` (other lanes), then `0221` (#865), then merge #865 | Cancellation and postcare join the ledger; owners can report "client says they didn't receive it". |
| 6 | Configure the Resend webhook (§2) | Separate approval. This is the step that makes bounce, delay, delivery and complaint visible. |
| 7 | Register the recovery sweep (§3) | Separate approval. Without it, an unfinished receipt is recovered only by Resend's own retries of that delivery (the webhook answers 500 while the receipt is pending), or by a later delivery. |

## 2. Resend webhook: configuration and controlled test

1. **Create one endpoint** in the Resend dashboard for `https://hone.care/api/resend/webhook`, subscribed to **exactly**:
   - `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.failed`, `email.suppressed`, `email.complained`.
   - **Not** `email.opened` or `email.clicked`: engagement is not delivery, and Hone does not track opens.
   - No other families.
2. **Set `RESEND_WEBHOOK_SECRET`** (the endpoint's `whsec_…`) in Vercel **production only**, then redeploy. Do not set it on preview: previews share the database, and the receipts would be real rows.
3. **Controlled test, no client involved.** Send Resend's dashboard test event to the endpoint. Expected:
   - one receipt row (`select processing_state, processing_result from email_provider_events order by received_at desc limit 1`);
   - `unmatched` / `unmatched_email_id`, or `quarantined` / `unknown_event_type`, depending on the test event's shape;
   - **no** ledger row changed, and **no** incident opened.

   A 403 means the secret does not match. A 500 means the secret is absent or the receipt could not be written. Fix before continuing.
4. **Controlled test with a real send to a staff mailbox** (separate approval):
   - book a staff-only appointment in a staff test studio whose client email is the operator's own mailbox;
   - expect the confirmation's ledger row to move `accepted` → `sent` → `delivered`, with the receipts `applied`;
   - the owner card shows nothing, because a delivery is not a problem.

   To prove the failure path without touching a client, a send to `bounced@resend.dev` (Resend's test address) from the same staff studio should open one `bounced` incident visible on that studio's card and in `/admin/delivery`.
5. **Rollback:** delete or disable the endpoint and unset `RESEND_WEBHOOK_SECRET`. Receipts already recorded stay as evidence, ledger rows keep their last status, and nothing is resent or deleted.

## 3. Recovery sweep and heartbeat

- Register `GET /api/cron/email-delivery-sweep` in `vercel.json` (with the existing CRON_SECRET), **once a day**. The Vercel plan caps cron at once a day, as `docs/08_EMAIL_SMS_AND_CRON.md` already records for `calendar-reconcile`. Recovery does not wait for it: Resend's retries and each webhook's post-response drain recover receipts first. The daily sweep is the backstop, and the point at which backlog findings are evaluated, so a stuck backlog is reported within a day.
- **Verify:**
  - `select * from email_delivery_health()` shows `last_sweep_at` advancing;
  - a deliberately held receipt is finished by the sweep (rehearsed on a local stack: `tests/db/email-delivery-events.db.test.ts`, CRASH RECOVERY);
  - findings raise at most one unresolved ops alert per event, always at **warning**: the sweep never records a critical alert, because critical ops alerts are emailed to `OPS_ALERT_EMAILS` (#828 gate). A finding assessed critical carries `assessed_severity: "critical"` in its details.
- **Rollback:** remove the cron entry. Health then reports `last_sweep_at` going stale, which is the intended signal.

## 4. Go / no-go for the Friday demo (synthetic only)

**Go**, on a synthetic studio, if all of these hold:
- #832, #843, #846, #849 and #865 CI are green at their exact heads, except for the documented contiguity reds;
- the browser spec `e2e/delivery-visibility.spec.ts` passes on the integrated synthetic stack;
- the owner card, the support queue and the concern flow are rehearsed with seeded failures (refused, bounced, suppressed, SMS undelivered).

**No-go for real patient data** until all of these hold:
- the #828 routing gate is decided;
- the hosted migrations are applied;
- the webhook is configured and tested (§2);
- the sweep is registered (§3).

The demo states these limits on screen. The card never claims bounce reporting is live: it states that a bounce appears only once Hone receives the provider's delivery reports, so no listed problem is not proof of delivery. A stored `RESEND_WEBHOOK_SECRET` is not treated as activation (Codex P2 4253217747). §2's controlled test is the activation evidence.

## 5. Decisions still open: exact steps, validation, rollback

Nothing here has been done. Each numbered decision is approved on its own. Before every step, run the CLAUDE.md §5 checks:
- `supabase/.temp/project-ref` is the canonical Hone project;
- read-only SQL only, through `supabase db query --linked`;
- re-derive the hosted max at that moment. `docs/production/migration-state.json` records **0210** as of this writing; that is a declaration, not a reading.

### D1. Apply `0211`, then `0212` (#832)

The exact release packet (heads, evidence, commands, permission and behaviour effects, verification, recovery) is [delivery-d1-release-packet.md](./delivery-d1-release-packet.md). It separates `0211`'s consent guard on the live `clients` table from `0212`'s new, unused tables. The summary below is for `0212`.

**Precondition:** `0211` (#827) is applied first. `0212` is not applicable on top of 0210 alone, because the pending suffix must be contiguous.

**File:** `supabase/migrations/0212_email_delivery_events.sql`, sha256 `cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1`. Verify the hash at the reviewed head before applying.

**What it does:**
- creates two new tables, `email_outbound_messages` and `email_provider_events`, each with two guard/default triggers;
- creates five service_role-only commands: `begin_appointment_email_message`, `settle_email_message`, `record_email_provider_event`, `claim_email_provider_events`, `process_email_provider_event`;
- adds no column, trigger or constraint to any existing table, and has no top-level DML.

**Validation (read-only):**

```sql
select version from supabase_migrations.schema_migrations where version >= '0211' order by 1;
  -- expect 0211, 0212 exactly once each, nothing above
select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'execute') as can_exec
from pg_proc p cross join pg_roles r
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('begin_appointment_email_message','settle_email_message','record_email_provider_event',
                    'claim_email_provider_events','process_email_provider_event')
  and r.rolname in ('anon','authenticated','service_role') order by 1, 2;
  -- expect can_exec false for anon and authenticated, true for service_role
select c.relname, r.rolname, has_table_privilege(r.oid, c.oid, 'select') as can_select
from pg_class c cross join pg_roles r
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('email_outbound_messages','email_provider_events')
  and r.rolname in ('anon','authenticated');
  -- expect false everywhere
select (select count(*) from public.email_outbound_messages) as ledger_rows,
       (select count(*) from public.email_provider_events) as receipts;
  -- expect 0, 0 until #832 is merged
```

**Rollback:** never edit the applied file.
- Before #832 is merged, the tables are empty and nothing reads them, so a new forward migration that drops the five functions and two tables is safe. It is a separate approved change.
- After the merge, revert the merge first; then the drop migration.

### D2. Apply `0215` (#843)

**Precondition:** `0213` (#831) and `0214` (#833) are applied. `0214` was amended twice; its current sha256 is `25da63b7…65f`, per the coordination record.

**File:** `0215_delivery_incidents.sql`, sha256 `09b01315e5159a1786a0bcabf0c5a3a8abffe62790123099b887c3d29de5e9d2`.

**What it does:**
- creates two tables, `delivery_incidents` and `delivery_sweep_heartbeat`;
- creates commands, all service_role-only except `owner_delivery_incidents`, which goes to authenticated and checks `is_studio_owner` inside;
- adds **AFTER `UPDATE OF status` triggers on both ledgers, including the live `sms_outbound_messages`.**

**SMS trigger risk:** the trigger has no exception handler, so an error inside it would roll back the SMS status write. Checked against every value the SMS ledger admits:
- all five SMS purposes in 0210's check match `delivery_incidents_purpose_ck`;
- the trigger fires only for `refused` / `undelivered` / `failed`, which are exactly the SMS failure classes the incident check allows;
- the reason `twilio_<integer>` matches `delivery_incidents_reason_ck`.

No admissible SMS row can make it raise. The residual cost is a row lock on the one open incident per (studio, purpose, class), which serializes only concurrent failures of the same kind.

**Validation (read-only):**

```sql
select tgname, tgrelid::regclass, tgenabled from pg_trigger
where tgname in ('sms_outbound_messages_open_incident','email_outbound_messages_open_incident');
  -- expect both present, tgenabled 'O'
-- the privilege query from D1 over: email_delivery_health, owner_delivery_incidents, record_email_sweep_run,
--   resolve_delivery_incident, support_delivery_incidents, support_email_receipt_outcomes
  -- expect anon false everywhere; authenticated true ONLY for owner_delivery_incidents; service_role true
select channel, failure_class, count(*) from public.delivery_incidents group by 1, 2;
  -- expect 0 rows at apply; afterwards only SMS rows until email ledgering is merged
```

**Rollback:**
- The first lever is a forward migration `drop trigger sms_outbound_messages_open_incident on public.sms_outbound_messages;`. It stops SMS incidents and leaves the SMS ledger and Twilio callbacks untouched. It is a production write and needs its own approval.
- Dropping the tables follows only after #843 is reverted.

### D3. Apply `0221` (#865)

**Precondition:** `0216`–`0220` are applied (other lanes; `0220` is confirmed by its lane).

**File:** `0221_delivery_concerns_and_purposes.sql`, sha256 `b881fa9052edabee0af3140ee8b7e09108b2013b16268dce894003f5bec4e19a`.

**What it does:**
- replaces `email_outbound_messages_purpose_ck` to admit `appointment_cancellation` and `appointment_postcare`;
- redefines `begin_appointment_email_message`;
- creates `delivery_concerns` with two triggers;
- creates the commands `report_delivery_concern` and `owner_delivery_concerns` (authenticated, owner-checked inside), and `support_delivery_concerns` and `close_delivery_concern` (service_role).

**Validation:**

```sql
select pg_get_constraintdef(oid) from pg_constraint where conname = 'email_outbound_messages_purpose_ck';
  -- expect both new purposes listed
-- the privilege query from D1 over the four concern commands
  -- expect authenticated true only for report_delivery_concern and owner_delivery_concerns
```

**Rollback:** a forward migration restoring 0212's purpose check is safe only while `select count(*) from email_outbound_messages where purpose in ('appointment_cancellation','appointment_postcare')` is 0. Otherwise revert #865 first and keep the wider check.

### D4. Resend webhook (§2)

**Exact configuration:**
- one endpoint, `https://hone.care/api/resend/webhook`;
- the seven `email.*` delivery events in §2, and no others;
- `RESEND_WEBHOOK_SECRET` set in Vercel **Production only**, then a redeploy.

**Precondition:** #832 is merged and deployed with `0212` applied. Without the secret, the route answers 500 and writes nothing.

**Validation:** §2 steps 3 and 4. The dashboard test event comes first; the staff-mailbox send needs its own approval, because it is a live message.

**Rollback:** disable or delete the endpoint and unset the secret, then redeploy. Recorded receipts stay as evidence; nothing is resent or deleted.

**Behaviour to expect:**
- while a receipt is still pending, the route answers 500, so Resend retries that delivery;
- after five failed attempts the database quarantines the receipt, and the next retry gets 200. A poison event cannot keep the endpoint failing indefinitely.

### D5. Register the recovery sweep (§3)

**Exact change:** add one entry to `vercel.json` `crons`:

```json
{ "path": "/api/cron/email-delivery-sweep", "schedule": "30 10 * * *" }
```

10:30 UTC is after the existing daily crons (08:00, 09:00, 09:30).

The route already exists and authenticates with the existing `CRON_SECRET`.

**Plan limit, resolved:** the Vercel plan caps cron at **once a day**. `docs/08_EMAIL_SMS_AND_CRON.md` records it for `calendar-reconcile`, and every existing cron is daily. A sub-daily schedule here would fail the deployment.
- A faster cadence would need an external scheduler calling the route with the `CRON_SECRET` bearer, or a plan change. Either is its own decision.
- With a daily sweep, the backlog finding (15 minutes, critical at 6 hours, recorded at warning) is evaluated once a day. Recovery itself is primary through Resend's retries (D4) and each webhook's post-response drain. The sweep is the backstop.

**Validation:**
- `select last_sweep_at, last_sweep_failed from public.email_delivery_health();` advances each run;
- `/admin/ops-alerts` shows no `email_delivery_*` alert at **critical** (pinned by `tests/app/api/email-delivery-sweep.test.ts`);
- the sweep sends no email or SMS and calls no provider.

**Rollback:** remove the cron entry and redeploy. `last_sweep_at` then goes stale, which health reports as a finding.

### Emailed delivery alerts stay off (#828)

No step above enables an emailed delivery alert:
- owners read the card; support reads `/admin/delivery`;
- the sweep caps its ops alerts at warning, so nothing reaches the critical-only `OPS_ALERT_EMAILS` path.

Turning any of that on is a separate decision after D-4.

### The smallest decision that unblocks the rest

**Approve D1: apply `0211` then `0212` from their reviewed heads.**

Everything else depends on it, and it is inert:
- it adds two empty tables and service-only commands;
- it touches no existing table;
- nothing reads it until #832 merges.
