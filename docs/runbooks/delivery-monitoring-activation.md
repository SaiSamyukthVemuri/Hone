# Delivery monitoring: activation and controlled acceptance (#824)

**Scope:** the delivery-monitoring stack. Each item is a draft PR.

| PR | Slice | Migration |
|---|---|---|
| #832 | DELIVERY-EVENTS-01: signed Resend event intake, receipts, email ledger | `0212` |
| #843 | DELIVERY-VISIBILITY-01: reminder email ledgering, deduplicated incidents, recovery sweep and heartbeat | `0215` |
| #846 | DELIVERY-VISIBILITY-02: owner delivery card, `/admin/delivery` support queue | none |
| #849 | DELIVERY-VISIBILITY-03: booking confirmation ledgering | none |
| #865 | DELIVERY-VISIBILITY-04: cancellation and postcare ledgering, "client says they didn't receive it" | `0221` |

**Status (2026-10-12):** nothing below has been done. No migration is applied, nothing is merged or configured, and no message has been sent.

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
| 4 | Merge #843, #846, #849 | **Behaviour changes on merge:** reminder and confirmation emails begin creating ledger rows and carry the `hone_m` tag, and owners see the delivery card (Settings → Launch, later the owner console). With no webhook yet, email rows stop at `accepted` / `refused` / `unknown`. The card and health say so; they do not claim delivery. |
| 5 | Apply `0216`-`0220` (other lanes), then `0221` (#865), then merge #865 | Cancellation and postcare join the ledger; owners can report "client says they didn't receive it". |
| 6 | Configure the Resend webhook (§2) | Separate approval. This is the step that makes bounce, delay, delivery and complaint visible. |
| 7 | Register the recovery sweep (§3) | Separate approval. Without it, unfinished receipts are recovered only by later deliveries. |

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

- Register `GET /api/cron/email-delivery-sweep` in `vercel.json` (with the existing CRON_SECRET), **every 15 minutes**. That cadence lets the 15-minute backlog finding mean something.
- **Verify:**
  - `select * from email_delivery_health()` shows `last_sweep_at` advancing;
  - a deliberately held receipt is finished by the sweep (rehearsed on a local stack: `tests/db/email-delivery-events.db.test.ts`, CRASH RECOVERY);
  - findings raise at most one unresolved ops alert per event.
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

The demo states these limits on screen. The card's own copy already says when email bounce reporting is not switched on.
