# 09 Database and RLS

Hone uses Supabase Postgres. 71 migrations live in `supabase/migrations/`, applied sequentially. All migrations are **strictly additive** and **idempotent** (`drop … if exists` before `add …`). Migrations may add columns, indexes, RPCs, or grants; they do not run destructive backfills.

## Migration discipline

- File name: `00NN_<short_underscore_name>.sql`, padded to four digits. The next migration is `0072`.
- Apply to production via `supabase db push --linked` BEFORE merging code that reads new columns or tables. A merged PR whose code references a column not yet in prod produces a 500. See the [Migration data + DDL splits](../README.md) memory.
- For mixed `UPDATE` + `ALTER CONSTRAINT` migrations, paste the `UPDATE` first and inspect the row count before applying the constraint.
- For atomic install patterns with cross-step invariants, wrap in `begin; … commit;` with `raise exception` validators between backfill and final constraints.
- Update this doc's migration table in the same PR.

Verify via:

```bash
supabase migration list --linked
supabase db push --linked
supabase db query --linked "<verification sql>"
```

## RLS principles

Every studio-scoped table:

1. `alter table … enable row level security;`
2. `drop policy if exists "<name>_member_read" on …; create policy "<name>_member_read" on … for select using (public.is_studio_member(studio_id));`
3. Stricter policies for INSERT / UPDATE / DELETE based on the table's role:
   - **Owner-only ALL** for studio configuration tables (`studios`, `services`, `availability_defaults`, `blockouts`).
   - **Member INSERT** for tables practitioners write to in normal workflow (`appointments` indirectly via RPC; `studio_timed_blocks` directly via PR #140 policy).
   - **Service-role-only write** for tables the action layer or webhook layer manages (`client_payment_methods`, `manual_fee_charge_attempts`, `appointment_audit`, `stripe_events`, `client_consent_signatures`).
4. No DELETE policy unless deliberate. Soft-archive via `status` columns is the default retirement path.

`public.is_studio_member(studio_id uuid) returns boolean` is `SECURITY DEFINER` and looks at `public.practitioners` for an `active` row matching the calling auth user.

## SECURITY DEFINER RPC rules

| Rule | Why |
|---|---|
| `language plpgsql` + `set search_path = pg_catalog, pg_temp` | Prevents search-path injection. Required in every RPC body. |
| Returns a typed `table(…)` or scalar; never raw row | Lets the caller branch on the result code without trusting the row shape. |
| `revoke execute … from public, anon, authenticated; grant execute … to service_role;` | Default surface is closed. |
| Argument list is fully typed; never `… variadic anyelement` or similar | Concrete signatures are auditable. |
| `for update` row lock before any conditional UPDATE | Concurrency safety for claim-then-act patterns. |
| Audit row insert in the same transaction as the status flip | A successful state change always has a matching audit record. |

Current SECURITY DEFINER RPCs:

- `claim_stripe_event` (0032); webhook claim.
- `sync_studio_account_status` (0032); connected-account status sync.
- `create_or_claim_stripe_account_provisioning` / `complete_stripe_account_provisioning` / `mark_stripe_account_provisioning_failed` (0032).
- `create_or_claim_stripe_customer_provisioning` / `complete_stripe_customer_provisioning` / `mark_stripe_customer_provisioning_failed` (0032).
- `find_or_create_client_for_booking` / `find_or_create_client_for_booking_payment_strict` (0032).
- `start_card_required_booking_session` and friends (0032); dormant.
- `record_payment_consent_for_session` (0032); dormant.
- `finalize_card_required_public_booking` (0032); dormant.
- `public_cancel_appointment_with_token(text, text)` and the new overloaded `public_cancel_appointment_with_token(text, text, text, text, boolean)` (0033 + 0063).
- `practitioner_cancel_appointment` (0033).
- `mark_appointment_no_show` (0033).
- `claim_manual_fee_charge_attempt` (0065 / PR #146).

## Migration timeline summary

| # | What it added | Why it matters |
|---|---|---|
| 0001 | Initial schema | Studios, practitioners, clients, sessions. |
| 0010 | Booking v1 | `appointments` + `appointment_audit` + RLS. |
| 0025 | Email system | Email send tracking + HMAC `cancellation_token`. |
| 0028 | No-show attempts counter | 3-strike retry for no-show follow-up email. |
| 0029 | Double-booking constraint | Trailing-buffer exclusion constraint + `buffer_minutes_snapshot`. |
| 0032 | Stripe Connect Phase 1 | The full charge backend (appointment_payments + stripe_charge_attempts + refund_attempts + refunds + disputes + payment_recovery_tokens + stripe_events + audit RPCs). **Dormant.** PR #135 (0058) plugs into the customer / settings tables; the charge tables stay idle. |
| 0033 | Pre-Stripe operational hardening | `public_cancel_appointment_with_token`, `practitioner_cancel_appointment`, `mark_appointment_no_show`; moved direct UPDATEs into SECURITY DEFINER RPCs. |
| 0043 | Postcare email | Postcare send tracking on `appointments`. |
| 0045 | Studio policy fields | `cancellation_policy_text`, `no_show_policy_text`, `policy_version`, `policy_updated_at`. |
| 0046 | Calendar feed token | `practitioners.calendar_feed_token` (raw; hashed storage on backlog). |
| 0047 | Owner opt-out of new-booking notification | `studios.notify_practitioner_on_new_booking`. |
| 0048 | Postcare email polish | Studio toggles + body shape. |
| 0049 | SMS foundation | `studios.send_*_sms`, `clients.sms_consent_at`/`sms_opted_out_at`, `claim_sms_send` RPCs. |
| 0050 | Clients archive | `clients.status='archived'` with read-only behavior across the app. |
| 0051 | Treatment plan multi-area + timeline | Structured area enum + plan timeline. |
| 0052 | Portal foundation | `client_portal_magic_links`, magic-link hash + TTL columns. |
| 0053 | Portal messages | Studio-to-client one-way messages. |
| 0054 | Portal message replies | Client reply rows. |
| 0055 | Portal RLS policies | Tightened policies for messages + replies. |
| 0056 | Policy acknowledgements | `appointment_policy_acknowledgements` with snapshot + SHA-256 hash. |
| 0057 | Consent / e-sign | `consent_form_templates` + `client_consent_signatures` (immutable). |
| 0058 | Card-on-file | `client_payment_methods` with FK to `client_consent_signatures(card_authorization_signature_id)`. |
| 0059 | Card SetupIntent unique | Partial unique on `(stripe_account_id, stripe_livemode, stripe_setup_intent_id)` to backstop the webhook idempotency check. |
| 0060 | Photo consent response | `client_consent_signatures.response` + `response_label_snapshot`. |
| 0061 | Timed block member-INSERT policy | RLS fix: active practitioners can INSERT their own `studio_timed_blocks` row. |
| 0062 | Harden SMS RPC grants | Revoke from anon/authenticated; grant only to service_role. |
| 0063 | Cancellation insight | Overloaded `public_cancel_appointment_with_token(text, text, text, text, boolean)` for structured reason/note/follow_up_allowed. |
| 0064 | Manual fee protection | `studios.late_cancel_fee_cents` + `studios.no_show_fee_cents`. `manual_fee_charge_attempts` table. Partial unique on `(appointment_id, charge_type) WHERE status IN ('ready', 'pending_stripe', 'succeeded')`. |
| 0065 | Manual fee charge test-mode result | Stripe result columns on `manual_fee_charge_attempts` (`stripe_livemode` CHECK-pinned to `false`). `claim_manual_fee_charge_attempt` RPC. Partial uniques on `stripe_payment_intent_id` and `stripe_idempotency_key`. |
| 0066 | Reschedule future guard | DB CHECK on `reschedule_appointment` RPC that the new starts_at is strictly in the future and the original is confirmed. |
| 0067 | Ops alerts | `ops_alerts` table with redaction; `record_ops_alert` service-role helper; never-throws contract. |
| 0068 | Sessions ↔ appointments link | Nullable `sessions.appointment_id` with FK to `appointments(id) ON DELETE SET NULL`. Two partial indexes (`sessions_appointment_id_idx`, `sessions_studio_appointment_idx`) keyed on `appointment_id is not null`. NO unique constraint (one appointment may have multiple sessions). NO historical backfill. NO RLS change. Server-side `startSessionAction` validates `(studio_id, client_id)` lineage before writing the FK. |
| 0069 | Appointment referral source | Nullable `appointments.referral_source` text. Stores the visitor's answer to the public booking form's "How did you hear about us?" dropdown (PR #163). No CHECK constraint (option set enforced at the action layer in `lib/booking/referral-source.ts`); no index (low cardinality, practitioner-only read on the appointment detail page); no RLS change. No historical backfill (null on every existing row is the honest representation). |
| 0070 | Practitioner notifications | New `practitioner_notifications` table (id / studio_id / practitioner_id / event_type / title / body / appointment_id / client_id / href / read_at / created_at). Three secondary indexes: `practitioner_notifications_studio_created_idx`, `practitioner_notifications_practitioner_created_idx` (partial on `practitioner_id is not null`), `practitioner_notifications_unread_idx` (partial on `read_at is null`). RLS enabled with `practitioner_notifications_member_read` (SELECT) + `practitioner_notifications_member_update` (UPDATE with WITH CHECK) gated on `is_studio_member(studio_id)`. NO insert policy by design: writes happen via the server-only helper `lib/notifications/practitioner-notifications.ts:recordPractitionerNotification` using service_role. NO CHECK on event_type (allowlist enforced in the helper). |
| 0071 | Fractional thermolysis duration | `alter column electrolysis_entries.thermolysis_duration_seconds type numeric using thermolysis_duration_seconds::numeric`. Migration 0042 declared the column as integer, which silently truncated values like `0.15` to `0`. Numeric is unbounded scale; the existing `>= 0` CHECK from 0042 still applies. Only the thermolysis column was widened; galvanic_duration_seconds and intensity_percent fields are intentionally untouched. No backfill (existing integer values remain valid numeric values). |
| 0072 | Consent template Live / Draft client visibility | Adds `consent_form_templates.is_live boolean NOT NULL DEFAULT false`. Backfills `is_live = true` for every row with `status = 'active'` so pre-migration portal visibility is preserved (single-digit row count per pilot studio; 4 rows on Willow). Adds `consent_form_templates_live_requires_active_check CHECK ((NOT is_live) OR (status = 'active'))` so a draft or archived row can never be live. No RLS change. No new index (the audit deferred a partial index until the query plan regresses; pilot row counts are too small to need one). The portal query (`lib/consent/queries.ts:getActiveConsentTemplatesForPortal`) was updated in the same PR to filter `is_live=true` in addition to `status='active'` as defense-in-depth. |

## Future migration checklist

Use this list every time before opening a migration PR.

- [ ] RLS enabled on every new table.
- [ ] SELECT policy uses `is_studio_member(studio_id)` unless deliberately wider.
- [ ] No anon / authenticated INSERT / UPDATE / DELETE grants unless deliberate and reviewed.
- [ ] SECURITY DEFINER functions set `search_path = pg_catalog, pg_temp`.
- [ ] Grants minimal: `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- [ ] If the column will be referenced by app code, the migration is applied to prod BEFORE the code PR merges.
- [ ] TypeScript types updated in `lib/types/database.ts` for any added column the app reads.
- [ ] Rollback considered (`drop … if exists` shape).
- [ ] Updated this doc's migration table in the same PR.
- [ ] Audit table touched if the migration changes state-mutation behavior.
