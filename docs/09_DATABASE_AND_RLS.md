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
| 0073 | Canonical `payment_charge_attempts` ledger (DORMANT) | Adds `public.payment_charge_attempts` with 27 columns covering the canonical v1 charge ledger for `session_payment` / `late_cancellation_fee` / `no_show_fee`. Two named CHECKs: `payment_charge_attempts_reason_shape_check` enforces the patched PR #171 rule (session_payment requires `session_id`; appointment_id is OPTIONAL for session_payment so a future freeform-session charge does not need a migration to relax; late_cancellation_fee and no_show_fee require `appointment_id` AND forbid `session_id`); `payment_charge_attempts_livemode_false_check` is the named dormancy guard the future live-enablement PR drops deliberately. Status enum mirrors `manual_fee_charge_attempts` exactly (`ready / blocked / cancelled / pending_stripe / succeeded / failed`). amount_cents bound `> 0 AND <= 200000` (the $2,000 CAD ceiling is intentionally larger than manual_fee's $200 cap because session payments represent the full treatment amount). FK ON DELETE rules: studio_id CASCADE; client_id and appointment_id composite RESTRICT; session_id SET NULL (corrected to RESTRICT by migration 0074 -- see below); client_payment_method_id and card_authorization_signature_id RESTRICT; created_by_practitioner_id composite RESTRICT; cancelled_by_practitioner_id RESTRICT. 12 secondary indexes (studio_created / studio_client / studio_appointment partial / studio_session partial / studio_status_reason / card_auth_sig partial / payment_method partial / charge_id partial) plus 4 partial unique indexes (idempotency / stripe_payment_intent / active-fee-per-appointment / active-session_payment-per-session). RLS enabled with `payment_charge_attempts_member_read` SELECT policy via `is_studio_member(studio_id)`; no INSERT / UPDATE / DELETE policy (service-role admin only). Touch trigger `payment_charge_attempts_touch_updated_at_trg` mirrors manual_fee. **DORMANT in PR #171: zero rows in production; first writes land in PR #181 (test mode only).** Runtime fee charging stays on `manual_fee_charge_attempts` until a separate PR unifies or formally deprecates the legacy table; live fee charging is gated on that unification per the dated checkpoint in docs/13 + docs/16. |
| 0074 | Corrective patch: session_id FK ON DELETE RESTRICT | PR #171 review caught that 0073's `session_id` FK declared `ON DELETE SET NULL` while the same migration's `payment_charge_attempts_reason_shape_check` requires `session_payment` rows to have a non-null `session_id`. Under SET NULL, a parent-session DELETE would attempt to null `session_id` on the dependent row and immediately fail the CHECK -- functionally a confusing hidden RESTRICT. 0074 drops the auto-named FK constraint (`payment_charge_attempts_session_id_fkey`) and re-adds it with `ON DELETE RESTRICT`, the honest declaration: sessions are immutable clinical artefacts and a session_payment row structurally requires the referenced session to stay put. No row-data change (table dormant; 0 rows before and after). No runtime change. No live-mode change. The combined effective state after 0073 + 0074 has `session_id` FK with `ON DELETE RESTRICT`. |
| 0082 | Clinical memory: block response + next-session note (PR #190) | `session_blocks` gains five structured client-response columns: `tolerance_rating smallint` (CHECK null or 1..5), `reaction_type text` (CHECK null or one of `none / mild_redness / moderate_redness / swelling / sensitivity / irritation / other`, mirrored in `lib/sessions/clinical-response.ts`), `reaction_notes text`, `caution_for_next_session boolean NOT NULL DEFAULT false`, `caution_note text`. `sessions` gains `next_session_note text` (the plan for the NEXT visit, surfaced as "From last visit" context when the client returns). All additive, nullable or defaulted; every pre-0082 row stays valid. No RLS/policy/grant change (both tables keep their studio-member policies). No new index. Migrations 0075-0081 are documented in docs/13 + docs/14 per-PR entries (payment refund columns, calendar feed token hash, email send claims, invite-only trigger). |
| 0092 | Secure treatment image storage (PR #271) | Private Supabase Storage bucket `treatment-images` (`public=false`) + `treatment_images` metadata table (studio_id + client_id required; session_id/session_block_id optional; storage_bucket/path, sanitized original_filename, content_type, size_bytes, uploaded_by, soft-delete deleted_at/deleted_by). Studio-scoped RLS via `is_studio_member` (member select/insert/update; NO delete policy; `revoke truncate, delete`). studio-scoped `storage.objects` policies (first path segment = studio_id) as defense-in-depth, wrapped in exception handlers so a platform-permission edge cannot fail the table creation. Access is server-side only: service-role upload + short-TTL `createSignedUrl` after a studio-ownership re-check; private bucket → no public URLs. Migrations 0083-0091 are documented in docs/13 + docs/14 per-PR entries. |

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

> **Clinical delete posture (PR #217, migration 0087):** core clinical/client-history tables (clients, sessions, session_blocks, photos, probe_lots, client_intake_forms, client_tags, treatment_goals, client_personal_notes) are no longer hard-deletable by normal authenticated studio members; the app archives or soft-deletes instead, and treatment memory is preserved because it is the product moat. DELETE remains, explicitly per-command, only where a reviewed UI affordance exists (electrolysis_entries, laser_entries, treatment_plan_stages, client_pricing). Record Keeping logbooks and audit events were already non-deletable (PR #205/#206). Future deletion needs should use archive/correction workflows. As of PR #220 this posture is verified by the DB/RLS integration harness below, not only by static SQL tests.

> **Exposure incident owner tier (PR #222, migration 0088):** `record_keeping_exposure_incidents` carries sensitive personal/health information (exposed person's name, address, phone, exposure details, action taken, staff involved), so reading the history and editing records is OWNER-ONLY (`is_studio_owner`); any active studio member can still FILE a new incident (`is_studio_member` INSERT), and there is still no DELETE policy. The audit table's SELECT policy gained a matching carve-out: exposure-incident audit rows (whose `changes` carry old/new field values) are owner-only to read, while all other record types stay member-readable; audit immutability (SELECT-only, trigger-written) is unchanged. This is privacy hardening ahead of any multi-practitioner studio; Willow today is solo (Chloe is the owner), so nothing changes for the pilot. Verified by the DB lane (tests/db/exposure-incident-owner-access.db.test.ts). Live payments remain disabled.

## DB/RLS integration test harness (PR #220)

`tests/db/` is a real-database lane that proves the security-critical DB behavior actually works, instead of inspecting migration SQL text:

- **What it does:** applies the FULL migration chain (0001-current) from scratch to a LOCAL Supabase Postgres (`supabase db start` + `supabase db reset --local`, db port 54322 from `supabase/config.toml`), then runs Vitest suites that connect with `pg` and exercise the migrated database directly.
- **How users are simulated:** each test runs statements inside a transaction with `set local role authenticated` and `request.jwt.claims` set to a fake user's `sub`, which is exactly how PostgREST presents a logged-in user, so `auth.uid()` and every RLS policy behave as in production. Seeded users are fake rows inserted into the LOCAL `auth.users` with random UUIDs and `@harness.local` emails. No real accounts, no production auth.
- **What it verifies (v1):** cross-studio isolation (clients, sessions, session_blocks, exposure incidents, audit events); record-keeping audit immutability (member INSERT throws RLS violation; UPDATE/DELETE affect zero rows) and trigger behavior (created/updated events, `changed_fields`, actor resolution via `auth.uid()`, no event on a no-op update); the migration 0087 clinical delete posture (nine protected tables: member DELETE affects zero rows; four intentionally deletable tables: member DELETE works, stranger DELETE does not); the double-booking exclusion constraint (overlap raises `23P01`, back-to-back allowed, cancelled rows do not block, the buffer trigger extends the blocked range); and the claim RPCs (`claim_email_send` wins exactly once; `claim_session_payment_charge_attempt` refuses non-ready rows and foreign practitioners, claims a ready row exactly once, second call sees `already_pending`).
- **How to run it locally:** `supabase db start && supabase db reset --local && npm run test:db` (needs Docker; the Supabase CLI is on brew). The unit lane (`npm test` / `npm run ci`) excludes `tests/db/` and never needs a database.
- **Safety:** the harness (`tests/db/helpers/harness.ts`) refuses any connection string whose host is not localhost and any URL matching hosted-database patterns (supabase.co/.com, pooler, amazonaws, ...). It reads no env var except `HONE_LOCAL_DB_URL` and never touches production. CI runs it as the separate `db-integration` job with no secrets and no `--linked` anywhere. Guardrails are pinned in the unit lane (`tests/scripts/db-harness-guardrails.test.ts`).
- **Still open after v1:** portal/anon token-route policies, storage policies, and browser E2E. The generated-types drift check shipped in PR #221 (next section).

## Generated types drift check (PR #221)

`scripts/check-db-types.mjs` (`npm run check:db-types`) keeps the hand-rolled `lib/types/database.ts` honest against the migrated schema:

- **How it works:** runs `supabase gen types typescript --local` against the SAME local migrated database the tests/db/ lane uses, then compares COLUMN SETS exactly, both directions, for 15 curated tables (studios, practitioners, clients, appointments, sessions, session_blocks, electrolysis_entries, laser_entries, client_intake_forms, treatment_plans, treatment_plan_stages, and the four record_keeping tables). A column in the database but missing from the app type fails; a phantom column in the app type fails. Eleven recently added columns (probe_lot_number, default_machine_frequency, aftercare fields, tolerance/reaction/caution fields, next_session_note, calendar_feed_token_hash) are individually pinned.
- **Why curated, not a full-file diff:** `lib/types/database.ts` is deliberately hand-rolled with narrowed unions (e.g. `modality: "electrolysis" | "laser"`) that carry MORE information than generated `string` types, so a byte diff against generated output is structurally impossible. Column-set comparison catches the drift that matters (missing or phantom columns) without forcing the types file into the generated shape.
- **Payment/webhook tables:** payment_charge_attempts, manual_fee_charge_attempts, stripe_events, and ops_alerts have no central hand-rolled type (billing modules type their rows inline), so the check asserts the DATABASE side: the columns the executors, receipt/refund senders, and webhook reconciliation rely on must exist in the migrated schema.
- **First-run catch:** the check immediately found six live columns missing from the app types (practitioners.calendar_feed_token_hash + the four 0027 terms/privacy stamps, clients.normalized_email); PR #221 added the declarations (types-only, additive).
- **How to run locally:** `supabase db start && supabase db reset --local && npm run check:db-types`. CI runs it in the `db-integration` job after the DB/RLS tests.
- **Safety:** generation is hardcoded to `--local` (no project ref, no `--linked`, no access token); the script refuses hosted or non-localhost `SUPABASE_DB_URL`/`HONE_LOCAL_DB_URL` values and reads no production credentials. It never touches production. Pins live in `tests/scripts/db-types-drift.test.ts`.
- **Deferred:** nullability/type-level comparison (column presence only in v1) and tables outside the curated list.
