# 09 Database and RLS

Hone uses Supabase Postgres. **As of 2026-08-02 the production migration max = 0165
(`0165_revoke_service_role_laser_entry_execute.sql`) — 164 applied, each exactly once, `0163`
immediately preceding `0164`. `0158` is deliberately skipped and will never be applied.
`0163` was applied 2026-08-02, independently verified, and is now **frozen**, as is `0162`
before it. `0164` and `0165` were both applied 2026-08-02 and are **frozen**. The repository max is also
**0165**, so repository and hosted migration state **match**; the next migration number is
**0166**.**
The canonical, regularly-reconciled ledger is
[docs/production/migration-ledger.md](./production/migration-ledger.md); the current-state
summary is [docs/production/current-state.md](./production/current-state.md). Always re-check
the highest file in `supabase/migrations/` and `supabase migration list --linked` before
trusting any count or applied-status number in a doc.

Most migrations are **additive** and **idempotent** (`drop … if exists` before `add …`); a few are deliberately destructive security-hardening migrations — notably **0091 (PR #264) drops the raw `appointments.cancellation_token` column** and two dead compatibility RPCs after the hash-at-rest cutover (0090/PR #260).

> **Historical note.** Earlier revisions of this section stated, at various dates, "96
> migrations, 0096 not yet applied", "production is at 0112", and "production migration max =
> 0113", "the production max is 0157", "the production max is 0160", "the production max is 0162",
> "the production max is 0163". All of those are **superseded** — the production max is **0164**. The per-migration
> prose table below remains historical through ~0092; everything from 0093 onward is
> enumerated in the migration ledger linked above. Dated statements elsewhere in the docs are
> point-in-time history, not current state.

**Treatment image storage trust boundary (0093, PR #276):** `treatment_images` objects are **service-role only** — 0093 drops the authenticated `storage.objects` select/insert policies for `treatment-images`, so normal members never touch storage objects directly; all upload/sign/archive goes through the server actions (service-role, after a studio-ownership re-check + a path validator). The metadata table adds CHECK constraints binding `storage_bucket = 'treatment-images'` and `storage_path` to `<studio_id>/<client_id>/<file>.<jpg|jpeg|png|webp>` (the row's own ids), a "block requires session" CHECK, and a BEFORE INSERT OR UPDATE trigger (`enforce_treatment_image_integrity`) that (a) enforces client∈studio / session∈studio+client / block∈session+studio and (b) freezes the identity columns (bucket/path/studio/client/session/block) after insert — archive only flips `deleted_at`/`deleted_by`. **0093 is applied in production** (the "must not be applied until explicitly approved after merge" gating in earlier revisions of this note was a pre-apply instruction and is now historical). **PR #277 (treatment image content validation + EXIF stripping) is app-layer only — NO schema change and NO migration**; it adds server-side `sharp` decode/re-encode in the upload action and does not touch `treatment_images` columns, RLS, constraints, or triggers. **PR #284 (attach photo to session/block at upload) is also app-layer only — NO schema change and NO migration**: it populates the already-existing nullable `session_id` / `session_block_id` columns (0092) with ids it validates server-side (session ∈ studio+client; block ∈ its session + studio, session derived from the block), backstopped by the existing 0093 `enforce_treatment_image_integrity` trigger. No new column/constraint/trigger/RLS; the DB lane is unchanged — `tests/db/treatment-image-hardening.db.test.ts` already proves the trigger rejects every cross-tenant/mismatched parent (cross-studio client/session, block-from-another-session, block-without-session), and a valid session+block insert passes. **PR #287 (treatment image archive scope + zero-row handling) is also app-layer only — NO schema change and NO migration**: 0092/0093 protect storage/path/identity integrity (and prevent re-pointing a row), but neither scopes an *archive action* by the route client — a same-studio `deleted_at` flip on another client's row is a legitimate update at the DB layer. The fix lives entirely in `archiveTreatmentImageAction`, which now scopes the conditional UPDATE by `id + studio_id + client_id + deleted_at IS NULL` and confirms exactly one row changed via `.select("id")` (zero rows → generic "Treatment photo not found.", not success). No new column/constraint/trigger/RLS; the DB lane is unchanged. **PR #292 (treatment image upload pre/post-buffer size hardening) is also app-layer only — NO schema change and NO migration**: it adds two defense-in-depth byte-length guards in `uploadTreatmentImageAction` (re-validate the actual buffered length before the Sharp sanitizer; cap the sanitized output length before the storage upload), both reusing the single-source `TREATMENT_IMAGE_MAX_BYTES`. No `treatment_images` column/constraint/trigger/RLS change, no storage/bucket/signing/sanitizer change; the DB lane is unchanged.

## Migration discipline

- File name: `00NN_<short_underscore_name>.sql`, padded to four digits. The next migration
  number is one above the current repo max — see the
  [migration ledger](./production/migration-ledger.md). **Current repo max `0165`, so the next is
  `0166`** — `0158` is permanently skipped and must never be reused. Do not hardcode this number
  anywhere it can go stale: derive it from
  `supabase/migrations/` (as `scripts/verify-production.mjs` does).
  **Repo and hosted are at parity: both are `0165`.** `0165` (revoke the unintended
  `service_role` EXECUTE that `0164` left on `create_laser_entry`) was applied 2026-08-02 and is
  frozen — see [known-limitations L18](./production/known-limitations.md).

**`service_role` EXECUTE repair (0165 — APPLIED 2026-08-02, frozen).** `0164` intended EXECUTE on
`create_laser_entry` to reach `authenticated` only, and its header said so — but Supabase's
`ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`, `authenticated` **and `service_role`** at
create time, and `0164` revoked only from `public` and `anon`. The deployed ACL was therefore
`{postgres=X, authenticated=X, service_role=X}`. This is the same defect as `0129` (which left
`anon` holding EXECUTE until `0130`), one role over. **No exposure was found:** the command's
first statement requires a non-null `auth.uid()`, so a service-role caller raises
`check_violation` before touching a row. `0165` revoked that one grant on that one signature and
changed nothing else — the post-apply ACL is exactly `{postgres=X, authenticated=X}` and the
function definition md5 is byte-identical across the apply. The generalised rule — an authenticated-only clinical RPC must revoke from
`public`, `anon` AND `service_role` explicitly, by name — is now pinned by
`tests/security/clinical-rpc-grant-guard.test.ts`, which excludes `returns trigger` functions
because those are not directly callable.

**Clinical entry command boundary (0164 — APPLIED 2026-08-02, frozen, LASER-ONLY).** L18 Phase 1A.
`authenticated` holds direct row DML on five clinical tables; closing that means moving every
legitimate runtime writer onto narrow reviewed commands FIRST, deploying them, and only then
revoking the grants. `0164` was applied 2026-08-02 and is **purely additive — it revokes no table privilege**. It
adds ONE SECURITY DEFINER command with `search_path = ''`: **`create_laser_entry`**. It requires a
non-null `auth.uid()`, resolves `studio_id` and `client_id` from the trusted `sessions` row (never
from a parameter), requires the caller to be an **ACTIVE practitioner of that same studio** matched
by `auth.uid()`, and re-checks the asserted client against the session's real client. It takes no
studio, practitioner or actor parameter, so attribution is not expressible by the caller. Clinical
values pass through verbatim, so the existing CHECK constraints and the 0119/0159/0160 guard
triggers remain the only validation authority. EXECUTE is revoked from `PUBLIC` and `anon` and
granted to `authenticated` only; there is deliberately **no service-role command**.
**Scope — only `addLaserEntryAction` moved.** **All three `electrolysis_entries` writers are
block-coupled and are deferred** to the combined block/entry phase so both writes can become
genuinely atomic: `createTreatmentAreaWithEntryAction` and `updateTreatmentAreaWithEntryAction`
write a block then an entry (the first compensates with a soft delete, the second not at all), and
`addElectrolysisEntryAction` can create a default `session_blocks` row through `ensureBlockForSession` before creating the electrolysis entry; the two writes are not atomic today and must move together. They are the only three exceptions permitted by
`tests/security/entry-direct-dml-guard.test.ts`. **`electrolysis_entries` is NOT command-bound in
any respect, neither entry table is command-boundary complete, and L18 is NOT closed** — see
[known-limitations L18](./production/known-limitations.md) and
[l18-command-inventory.md](./production/l18-command-inventory.md).

**Intake INSERT boundary (0163 — APPLIED 2026-08-02, frozen).** 0162 closed the review *transition*,
but its guard is a BEFORE **UPDATE** trigger and so never fires on INSERT. Until 0163 an
authenticated studio member could skip the guarded transition entirely and **INSERT a brand-new
`client_intake_forms` row that was already `status = 'reviewed'`**, with a NULL `submitted_at`
and a forged historical `reviewed_at` — a clinical "this intake was reviewed" record for a form
the client never submitted. Two things made it reachable: `authenticated` held the `INSERT` table
privilege, and the `client_intake_forms_member_insert` policy's `WITH CHECK` was only
`is_studio_member(studio_id)` — it constrained *which studio* a row could be created in, never
*what state* it could be created in. `0163` removes **both**: it defensively drops any legacy
`FOR ALL` policy (which would silently re-grant INSERT), drops the dedicated INSERT policy, and
`REVOKE`s `INSERT` from `authenticated` **and** `anon`. It removes the capability rather than
policing the values because a caller audit found **zero** legitimate authenticated INSERT paths —
both runtime writers, `ensureIntakeForClient` and `createIntakeRequestForClient`
(`lib/intake/queries.ts`), use the service-role admin client. `authenticated` SELECT and UPDATE
are preserved, so reading an intake and the 0162-guarded review transition are unaffected, and
service-role INSERT is preserved, so both writers keep working. **Scope:** `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open.
`authenticated` still holds direct row DML on `sessions`, `session_blocks`,
`electrolysis_entries`, `laser_entries` and `treatment_images` — see
[known-limitations L18](./production/known-limitations.md). Behavioural proof:
`tests/db/intake-insert-boundary.db.test.ts`.

**Intake review transition integrity (0162 — APPLIED 2026-08-02, frozen).** Migration `0118` made
submitted/reviewed intake answers immutable, but every one of its review checks sits inside
`if old.status in ('submitted','reviewed')`, so an OLD row that is still `in_progress` never
enters the block and the **incoming** transition to `reviewed` was unguarded. An authenticated
direct PostgREST `PATCH` could therefore drive `in_progress -> reviewed` with `submitted_at`
still NULL (`UPDATE 1`), producing a clinical record marked reviewed for an intake the client
never submitted. PR #497 closed the application and UI half of this (deployed); `0162` closes the
database half by **replacing the `enforce_intake_terminal_immutability()` body** (same trigger
name, still `SECURITY INVOKER`, still `search_path = ''`). Any UPDATE where
`new.status = 'reviewed' AND old.status IS DISTINCT FROM 'reviewed'` must satisfy:
`old.status = 'submitted'`; `old.submitted_at IS NOT NULL`; `new.submitted_at` unchanged;
`new.reviewed_by` non-null AND an **active** practitioner whose `user_id = auth.uid()` **and**
whose `studio_id = old.studio_id` (0118 checked only `user_id`/`active`, which one user holding
practitioner rows in two studios could satisfy with the wrong studio's row). **`reviewed_at` is
now stamped by the database** (`transaction_timestamp()`), so a backdated or future value cannot
be forged — the DB, not the client, is authoritative for the review timestamp. Two further
hardenings: `reviewed` is terminal for end users (0118 blocked only the regression to
`in_progress`, leaving `reviewed -> submitted` open as a two-step attribution-laundering path),
and review metadata cannot be attached to a non-reviewed row. **A third hardening closes a
bypass adversarial review found in the first draft of 0162:** an authenticated member could
forge the client's own submission (`in_progress -> submitted`, setting `submitted_at`
themselves) and then perform a review that satisfied every section-1 predicate against the
evidence they had just manufactured — reaching `reviewed` from `in_progress` in two statements
instead of one. Reproduced end-to-end as `authenticated` on a CI-parity database. `0162`
therefore also refuses any authenticated transition **into** `submitted`: only the client
submits, through the public tokenized route, which runs as service role and is exempt.
**Not closed by 0162:** its guard is a BEFORE **UPDATE** trigger, so an authenticated member can
still `INSERT` a brand-new row already `reviewed` with a NULL `submitted_at` and a forged
`reviewed_at` (reproduced locally, rolled back). That is the broader `authenticated` direct-DML
limitation tracked as **L18**, out of this migration's scope. **Service role:** the blanket
`auth.uid() is null` exemption is deliberately NOT preserved for the review transition — a caller
audit found `status: "reviewed"` written in exactly one place in the repository, on the
authenticated path — so a service-role review fails closed, while the service-role client
submission (`in_progress -> submitted`), inserts and link-metadata writes are untouched. No
schema, data, grant or policy change; no backfill. Behaviour is proven by
`tests/db/intake-review-db-boundary.db.test.ts` (full adversarial matrix + a real two-connection
concurrency race) and pinned by `tests/migrations/0162-intake-review-transition-integrity.test.ts`.

**Tenant consistency constraints (0094, PR #278 — APPLIED to production 2026-07; the "not yet applied" note below is superseded).** Sensitive clinical/import child tables now prove their parent rows are same-studio via **composite foreign keys** (the same pattern the payment subsystem already used): `sessions`→clients`(studio_id,client_id)` + appointments`(studio_id,appointment_id)`, `session_blocks`→sessions`(studio_id,session_id)`, `client_intake_forms`/`treatment_plans`→clients`(studio_id,client_id)`, `imported_treatment_memories`→clients + import_batches`(studio_id,…)`, and `electrolysis_entries`→session_blocks`(session_id,block_id)` (its block must belong to its own session). New parent unique keys: `sessions(studio_id,id)`, `session_blocks(session_id,id)`, `import_batches(studio_id,id)`. **Composite FKs, not triggers** — PG17 column-list `ON DELETE SET NULL (col)` keeps SET-NULL parents from nulling the NOT-NULL `studio_id`. Each composite **replaces** the prior single-column FK (mirroring its ON DELETE; behavior-preserving) so each table pair keeps exactly **one** relationship — two FKs between a pair make PostgREST embedded selects ambiguous. (`electrolysis_entries_session_id_fkey` is kept — different pair.) No RLS weakened. `treatment_images` (0093 trigger) and the payment tables were already enforced and are untouched. **0094 is applied in production (2026-07); the earlier "must not be applied until approved" gating is historical.**

**Clinical lineage enforcement (PR #286, app-layer only — NO migration).** 0094 guarantees `session_blocks ∈ session` and `electrolysis_entries ∈ block ∈ session` are **same-studio**, but it does not constrain which **route client** a charting action targets — a same-studio wrong-client write (Client A route + Client B's session/block/entry id) was not blocked by the DB. PR #286 adds the missing app-level check: the charting actions (`app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts`) now call the shared `assertSessionForClient(studioId, clientId, sessionId)` (queries `sessions` by `id + studio_id + client_id + deleted_at null`) before any block/entry write, and every block/entry write remains scoped by the client-validated `session_id`. So the full `studio → client → session → block → entry` lineage is enforced: 0094 supplies the structural parent consistency, and this PR supplies the route-client check. No new column/constraint/trigger/RLS; the DB lane is unchanged.
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

The **common** pattern for a studio-scoped table is below. It is a default, **not a
universal invariant** — several tables deliberately deviate (see "Deliberate exceptions").

1. `alter table … enable row level security;`
2. `drop policy if exists "<name>_member_read" on …; create policy "<name>_member_read" on … for select using (public.is_studio_member(studio_id));`
3. Stricter policies for INSERT / UPDATE / DELETE based on the table's role:
   - **Owner-only ALL** for studio configuration tables (`studios`, `services`, `availability_defaults`, `blockouts`).
   - **Member INSERT** for tables practitioners write to in normal workflow (`appointments` indirectly via RPC; `studio_timed_blocks` directly via PR #140 policy).
   - **Service-role-only write** for tables the action layer or webhook layer manages (`client_payment_methods`, `manual_fee_charge_attempts`, `appointment_audit`, `stripe_events`, `client_consent_signatures`).
4. No DELETE policy unless deliberate. Soft-archive via `status` columns is the default retirement path.

`public.is_studio_member(studio_id uuid) returns boolean` is `SECURITY DEFINER` and looks at `public.practitioners` for an `active` row matching the calling auth user.

### Deliberate exceptions — do not claim one generic pattern covers everything

- **Default-deny, no policy at all.** `calendar_sync_outbox`, `calendar_connection_secrets`,
  `google_oauth_states`, `admin_action_events` (0113) have RLS enabled with **no browser
  policy** plus explicit `REVOKE` — service-role only. `admin_action_events` also has **no
  foreign keys**, deliberately, so an audit event survives deletion of the row it references.
- **Append-only.** `client_clinical_notes` (0126/0127), `client_portal_access_events` (0111) and
  the record-keeping audit tables are SELECT-only to members with writes via trusted paths;
  UPDATE/DELETE are blocked. `client_clinical_notes` is **live for every studio** and is
  unrelated to the retired signed-record system: a correction there is a **new row**
  ([clinical-notes-append-only-contract.md](./clinical-notes-append-only-contract.md)).
- **Fully immutable legacy evidence — no INSERT either.** `clinical_record_snapshots` (0119),
  `clinical_record_amendments` and `clinical_audit_events` (0120) belong to the **retired**
  signed-record system. 0119/0120 blocked UPDATE/DELETE **for all roles including
  service_role**; 0159 also blocks INSERT, so nothing can be added, changed or removed. They
  are retained, readable evidence of what was once built — not an active capability, and
  `clinical_audit_events` is **not** Hone's operational audit trail (that is `session_audit`,
  `record_keeping_audit_events`, `session_copy_operations`, `admin_action_events` and
  `client_portal_access_events`, all active). See
  [decisions/clinical-finalization-retired.md](./decisions/clinical-finalization-retired.md).
- **Owner-tier read.** `record_keeping_exposure_incidents` (0088) is owner-only to read and
  edit (it carries sensitive personal/health detail), while any active member may still file
  a new incident. The audit table carries a matching owner-only carve-out for exposure rows.
- **No DELETE policy, ever.** The 0087 clinical delete posture makes nine core
  clinical/client-history tables non-hard-deletable by normal authenticated members.
  0115 went further and *dropped* the residual entry DELETE policies and revoked
  `truncate, delete` from `anon, authenticated`.
- **SELECT-only with every other privilege revoked.** `session_copy_operations` (0157) — see
  the next section. Since 0159, `session_block_areas` (0128) is the same shape: browser roles
  hold studio-scoped SELECT and nothing else, its `FOR ALL` policy is narrowed to SELECT, and
  every write goes through `create_session_block_with_areas` /
  `update_session_block_with_areas` / `copy_session_setup`. The app contains **zero** direct
  writes to it, so the revocation is invisible to the deployed application. 0159 also removes
  every remaining `anon` write privilege and `TRUNCATE`/`REFERENCES`/`TRIGGER` from `anon` **and
  `authenticated`** on all six clinical tables (`sessions`, `session_blocks`,
  `session_block_areas`, `electrolysis_entries`, `laser_entries`, `treatment_images`).

### RLS is not the same thing as a table privilege

This distinction is load-bearing and easy to get wrong.

**Row Level Security filters rows for `SELECT`, `INSERT`, `UPDATE` and `DELETE`. It does not
govern `TRUNCATE`, `REFERENCES` or `TRIGGER`.** A role holding `TRUNCATE` on a table can empty
it regardless of how carefully its RLS policies are written, because `TRUNCATE` is not a
row-level operation and no policy is consulted. `REFERENCES` allows creating a foreign key
against the table; `TRIGGER` allows attaching a trigger to it.

Therefore an append-only or audit table needs **both** layers:

1. RLS enabled with the narrowest useful policy set, **and**
2. a table-privilege revocation that removes everything the browser roles must not hold.

The canonical example is the 0157 provenance ledger:

```sql
revoke all on public.session_copy_operations from public, anon, authenticated;
grant select on public.session_copy_operations to authenticated;
```

Verified in production (`has_table_privilege`, 2026-07-27):

| Role | SELECT | INSERT | UPDATE | DELETE | TRUNCATE | REFERENCES | TRIGGER |
|---|---|---|---|---|---|---|---|
| `anon` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `authenticated` | ✓ (RLS studio-scoped) | ✗ | ✗ | ✗ | **✗** | **✗** | **✗** |
| `service_role` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Without the `revoke all`, a Supabase default grant would have left `authenticated` holding
`TRUNCATE` — and **RLS would not have stopped it**. Apply the same reasoning to every new
audit, ledger or append-only table.

## SECURITY DEFINER RPC rules

| Rule | Why |
|---|---|
| Pin the search path in every RPC body — either `set search_path = pg_catalog, pg_temp` (the long-standing form) **or** `set search_path = ""` with every reference fully schema-qualified (the stricter form used by 0157's four functions) | Prevents search-path injection. **Pinning is mandatory; the exact form is not.** Verified 2026-07-27: all 139 `SECURITY DEFINER` functions in `public` have a pinned search path, 0 lack one. |
| Returns a typed `table(…)` or scalar; never raw row | Lets the caller branch on the result code without trusting the row shape. |
| `revoke execute … from public, anon, authenticated; grant execute … to service_role;` | Default surface is closed. |
| Argument list is fully typed; never `… variadic anyelement` or similar | Concrete signatures are auditable. |
| `for update` row lock before any conditional UPDATE | Concurrency safety for claim-then-act patterns. |
| Audit row insert in the same transaction as the status flip | A successful state change always has a matching audit record. |

### SECURITY DEFINER inventory — verified in production 2026-07-27

| Measure | Verified value |
|---|---|
| `SECURITY DEFINER` functions in `public` | **139** |
| …**without** a pinned `search_path` | **0** — every one is pinned |
| …executable by `authenticated` | 22 |
| …executable by `anon` | **7** |

The seven `anon`-executable ones are **not business RPCs**. They are RLS predicates and
trigger functions that must be callable inside the policy/trigger evaluation context:
`is_studio_member`, `is_studio_owner`, `session_is_visible`, `handle_new_user`,
`rls_auto_enable`, `enforce_appointment_buffer`, `guard_scoped_recurring_rule_capacity`.
**No business command RPC is `anon`-executable.** Migration 0130 exists specifically because
0129 had left a residual `anon` EXECUTE grant on two charting RPCs — Supabase's
`ALTER DEFAULT PRIVILEGES` grants `anon` EXECUTE at create time, so `revoke … from public`
alone is **not** sufficient. Always revoke from `anon` explicitly.

### Notable RPC families

- **Whole-session copy (0157)** — `copy_session_setup` is **service-role only** (revoked from
  both `anon` *and* `authenticated`), invoked solely by the authenticated server action with a
  server-derived practitioner id; because service_role bypasses RLS, the RPC itself
  re-verifies active studio membership. `whole_session_copy_source_descriptor` is
  authenticated + service_role. `_whole_session_copy_fingerprint` and
  `_whole_session_copy_source_id` are **private helpers** — service_role only. All four use
  `search_path = ""`.
  - **Source locking** — the commit carries an expected source session id; the source row is
    resolved and locked inside the transaction.
  - **Fingerprinting** — the caller supplies an expected source fingerprint; a source that
    changed underneath is rejected rather than silently copied. `galvanic_intensity_percent`
    is **excluded** from the fingerprint and written as a literal `NULL` at the destination.
  - **Target serialization + idempotency** — `(target_session_id, idempotency_key)` is UNIQUE
    on `session_copy_operations`, so a retry or double-submit is an at-most-once no-op.
- **Atomic charting writes (0129, hardened by 0130)** — `create_session_block_with_areas` /
  `update_session_block_with_areas`: `is_studio_member` gate, allow-listed
  `jsonb_populate_record`, `SELECT … FOR UPDATE` row lock, `stale_block_version` optimistic
  concurrency, delete+insert area replacement in one transaction.
- **Signed clinical finalization + signed corrections (0119/0120) — RETIRED, NOT CALLABLE.**
  `finalize_session`, `correct_finalized_session`, `amend_finalized_session`,
  `amend_finalized_session_with_image` and `build_session_snapshot` still exist so 0119/0120
  stay replayable, but 0159 **revoked `EXECUTE` from `public`, `anon`, `authenticated` and
  `service_role`**, so nothing that serves a request can invoke them. Signed / cryptographically
  finalized clinical records are not a Hone capability; treatment sessions are ordinary editable
  records. The correction path's narrow bypass — a transaction-local, session-scoped GUC
  (`hone.correction_session_id`) that the write-guard formerly honoured when it matched the row's
  own `session_id` — **is REMOVED by 0159 and is no longer honoured at all.** It had to go: once the
  correction RPCs were `EXECUTE`-revoked, the permit stopped being a guarded escape and became an
  open one, because `set_config` on a custom placeholder is available to **any** role — reproduced
  as plain `authenticated` rewriting the frozen legacy record. Verified in production after the
  0159 apply: `guard_finalized_clinical_write` no longer references the placeholder, or
  `current_setting` at all. There never was, and still is not, a service-role, `auth.uid()` or
  role-based bypass of the finalized-record guards. Those guards
  (`guard_finalized_clinical_write` + its five triggers, `guard_snapshot_append_only`,
  `guard_practitioner_finalized_refs`) are deliberately **kept** — their remaining job is to
  protect the one legacy finalized artifact. See the retirement posture below.
- **Capacity / booking commands (0142–0150)** — parameter-based authorization: the server
  action resolves actor and studio server-side and nothing is trusted from the browser.
  Duration is derived from the **locked, revalidated service row inside the transaction**
  (0146), never from a caller-supplied value. The canonical lock order is
  **studios row `FOR UPDATE` → capacity advisory lock** (0138).
- **Appointment move (0133, superseded internally by 0143–0148)** — optimistic concurrency on
  the expected `starts_at`/`ends_at`; does not catch `23P01`, so a booking conflict rolls the
  move back rather than committing a partial change.

Legacy inventory (pre-0075 payment/booking RPCs, retained for reference):

- `claim_stripe_event` (0032); webhook claim.
- `sync_studio_account_status` (0032); connected-account status sync.
- `create_or_claim_stripe_account_provisioning` / `complete_stripe_account_provisioning` / `mark_stripe_account_provisioning_failed` (0032).
- `create_or_claim_stripe_customer_provisioning` / `complete_stripe_customer_provisioning` / `mark_stripe_customer_provisioning_failed` (0032).
- `find_or_create_client_for_booking` / `find_or_create_client_for_booking_payment_strict` (0032).
- `start_card_required_booking_session` and friends (0032); dormant.
- `record_payment_consent_for_session` (0032); dormant.
- `finalize_card_required_public_booking` (0032) — **dropped by 0091** (PR #264).
- `public_cancel_appointment_with_token(text, text, text, text, boolean)` (0033 + 0063) — the legacy 2-arg overload was **dropped by 0091** (PR #264); only this 5-arg, hash-only overload remains.
- `claim_session_payment_charge_attempt` (0075; reasons widened in 0083) — canonical claim RPC for session-payment + fee charges.
- `practitioner_cancel_appointment` (0033).
- `mark_appointment_no_show` (0033).
- `claim_manual_fee_charge_attempt` (0065 / PR #146).

### Retired system — signed / finalized clinical records (0119/0120, retired by 0159)

**Signed and cryptographically finalized clinical records are RETIRED. They are not parked, not
dormant and not a later phase** — the product decision is
[decisions/clinical-finalization-retired.md](./decisions/clinical-finalization-retired.md), and
migration 0159 enforces it in the database. Treatment sessions are **ordinary editable
operational records**: a practitioner fixes a mis-charted session by editing it through the
normal charting commands. Nothing about ordinary audit is given up — `session_audit`,
`record_keeping_audit_events`, `session_copy_operations`, `admin_action_events` and
`client_portal_access_events` are all active, actor attribution and timestamps are unchanged,
whole-session-copy provenance is unchanged, and tenant isolation is unchanged.

The capability had to be closed in the **database**, not by deleting a button: `authenticated`
held `EXECUTE` on the four retired RPCs, and a studio owner could `PATCH`
`clinical_finalization_enabled = true` straight through PostgREST via the
`studios: owners update` policy.

| 0159 mechanism | Posture |
|---|---|
| CHECK `studios_clinical_finalization_retired` / `studios_clinical_corrections_retired` | `studios.clinical_finalization_enabled` and `studios.clinical_corrections_enabled` are pinned `false`. A CHECK is declarative and consults no policy, so **no role** can turn them on — not a studio owner through the owners-update policy, not `service_role`, not a future settings screen. Both columns are kept so 0119/0120 stay replayable. |
| `revoke all on function …` | `EXECUTE` on `finalize_session`, `correct_finalized_session`, `amend_finalized_session`, `amend_finalized_session_with_image` and `build_session_snapshot` is revoked from `public`, `anon`, `authenticated` **and `service_role`**. The owner keeps `build_session_snapshot` only so the legacy hash can be re-derived read-only. |
| Trigger `sessions_guard_retired_finalization` | Refuses any transition of `sessions.record_status` **into** `finalized`/`void`, and any INSERT that is not `draft`. It is a *transition* guard, so the one legacy row is untouched. |
| Triggers `*_retired_no_insert` on the three signed ledgers | INSERT refused on `clinical_record_snapshots`, `clinical_record_amendments` and `clinical_audit_events`. With the 0119/0120 append-only guards already blocking UPDATE/DELETE for every role, those tables are now **fully immutable legacy evidence**. |
| Clinical-table privilege hardening | Every remaining `anon` write privilege on the six clinical tables is removed, and `TRUNCATE`/`REFERENCES`/`TRIGGER` are removed from `anon` **and `authenticated`** on all six — `TRUNCATE` is statement-level, consults no policy and fires no row trigger, so a grant was the only thing standing between a browser role and an emptied clinical table. |
| `session_block_areas` read-only to browser roles | Studio-scoped SELECT only, `FOR ALL` policy narrowed to SELECT, and the 0128 studio-derive trigger widened to cover `studio_id` (an UPDATE touching only `studio_id` previously did not re-derive it, leaving a row readable by the wrong studio). Zero direct application writes exist, so this is invisible to the deployed app. |

**0159 drops nothing.** The 0119/0120 tables, columns, functions and triggers stay in place, and
the guards that *protect* the legacy artifact (`guard_finalized_clinical_write` + its five
triggers, `guard_snapshot_append_only`, `guard_practitioner_finalized_refs`) are deliberately
kept switched on. `sessions.record_status` is **kept** because two shipped features read it on
live paths: 0157's whole-session copy (source resolver excludes a `void` source; the commit
requires a `draft` target) and 0123's `soft_delete_session_area`. After 0159 every real session
is `draft` and stays `draft`.

**The one legacy artifact.** Production holds exactly one finalized session — in a **non-Willow
controlled-test studio**, finalized 2026-07-11 — with one `clinical_record_snapshots` row whose
`content_hash` still re-derives to a MATCH (re-verified read-only 2026-07-29). `clinical_record_amendments`
and `clinical_audit_events` hold **0 rows**; Willow has **0** non-draft sessions. That artifact is
retained, readable and unchanged: deleting it would destroy audit history and regenerating its
hash would fabricate one.

**Not done by 0159, and deliberately so.** Direct DML on `public.sessions`, `session_blocks`,
`electrolysis_entries`, `laser_entries` and `treatment_images` is **not** revoked — the deployed
application still writes all five directly, so revoking before those callers move onto narrow
reviewed commands would break live charting the moment the migration applied. That is staged
into the follow-up PR. There is **no** snapshot v2 and no structured-area signed-correction
framework; those are retired, not deferred. Reintroducing any of it would require a **new
product decision**, not a flag flip.

Behaviour is pinned by `tests/db/clinical-finalization-retired.db.test.ts` (DB lane) and the
documentation posture by `tests/docs/clinical-finalization-retired.test.ts` (unit lane).

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
| 0046 | Calendar feed token | `practitioners.calendar_feed_token`; hashed storage shipped in 0079 (PR #182) — `calendar_feed_token_hash` (SHA-256, backfilled), feed route looks up by hash only. |
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
- [ ] SECURITY DEFINER functions pin the search path — `set search_path = pg_catalog, pg_temp`, **or** `set search_path = ""` with every reference fully schema-qualified (as 0157 does). Never leave it unpinned.
- [ ] Grants minimal: `revoke execute … from public, anon, authenticated; grant execute … to service_role`.
- [ ] If the column will be referenced by app code, the migration is applied to prod BEFORE the code PR merges.
- [ ] TypeScript types updated in `lib/types/database.ts` for any added column the app reads.
- [ ] Rollback considered (`drop … if exists` shape).
- [ ] Updated this doc's migration table in the same PR.
- [ ] Audit table touched if the migration changes state-mutation behavior.

> **Clinical delete posture (PR #217, migration 0087):** core clinical/client-history tables (clients, sessions, session_blocks, photos, probe_lots, client_intake_forms, client_tags, treatment_goals, client_personal_notes) are no longer hard-deletable by normal authenticated studio members; the app archives or soft-deletes instead, and treatment memory is preserved because it is the product moat. DELETE remains, explicitly per-command, only where a reviewed UI affordance exists (electrolysis_entries, laser_entries, treatment_plan_stages, client_pricing). Record Keeping logbooks and audit events were already non-deletable (PR #205/#206). Future deletion needs should use archive/correction workflows. As of PR #220 this posture is verified by the DB/RLS integration harness below, not only by static SQL tests.

> **Exposure incident owner tier (PR #222, migration 0088):** `record_keeping_exposure_incidents` carries sensitive personal/health information (exposed person's name, address, phone, exposure details, action taken, staff involved), so reading the history and editing records is OWNER-ONLY (`is_studio_owner`); any active studio member can still FILE a new incident (`is_studio_member` INSERT), and there is still no DELETE policy. The audit table's SELECT policy gained a matching carve-out: exposure-incident audit rows (whose `changes` carry old/new field values) are owner-only to read, while all other record types stay member-readable; audit immutability (SELECT-only, trigger-written) is unchanged. This is privacy hardening ahead of any multi-practitioner studio; Willow today is solo (Chloe is the owner), so nothing changes for the pilot. Verified by the DB lane (tests/db/exposure-incident-owner-access.db.test.ts). *(Payment posture, current: supervised live owner-run session payments are live for approved studios — see [current-state](./production/current-state.md); the "live payments disabled" phrasing in older notes below is historical.)*

## DB/RLS integration test harness (PR #220)

`tests/db/` is a real-database lane that proves the security-critical DB behavior actually works, instead of inspecting migration SQL text:

- **What it does:** applies the FULL migration chain (0001-current) from scratch to a LOCAL Supabase Postgres (`supabase db start` + `supabase db reset --local`, db port 54322 from `supabase/config.toml`), then runs Vitest suites that connect with `pg` and exercise the migrated database directly.
- **How users are simulated:** each test runs statements inside a transaction with `set local role authenticated` and `request.jwt.claims` set to a fake user's `sub`, which is exactly how PostgREST presents a logged-in user, so `auth.uid()` and every RLS policy behave as in production. Seeded users are fake rows inserted into the LOCAL `auth.users` with random UUIDs and `@harness.local` emails. No real accounts, no production auth.
- **What it verifies (v1):** cross-studio isolation (clients, sessions, session_blocks, exposure incidents, audit events); record-keeping audit immutability (member INSERT throws RLS violation; UPDATE/DELETE affect zero rows) and trigger behavior (created/updated events, `changed_fields`, actor resolution via `auth.uid()`, no event on a no-op update); the migration 0087 clinical delete posture (nine protected tables: member DELETE affects zero rows; four intentionally deletable tables: member DELETE works, stranger DELETE does not); the double-booking exclusion constraint (overlap raises `23P01`, back-to-back allowed, cancelled rows do not block, the buffer trigger extends the blocked range); and the claim RPCs (`claim_email_send` wins exactly once; `claim_session_payment_charge_attempt` refuses non-ready rows and foreign practitioners, claims a ready row exactly once, second call sees `already_pending`).
- **How to run it locally:** `supabase db start && supabase db reset --local && npm run test:db` (needs Docker; the Supabase CLI is on brew). The unit lane (`npm test` / `npm run ci`) excludes `tests/db/` and never needs a database.
- **Safety:** the harness (`tests/db/helpers/harness.ts`) refuses any connection string whose host is not localhost and any URL matching hosted-database patterns (supabase.co/.com, pooler, amazonaws, ...). It reads no env var except `HONE_LOCAL_DB_URL` and never touches production. CI runs it as the separate `db-integration` job with no secrets and no `--linked` anywhere. Guardrails are pinned in the unit lane (`tests/scripts/db-harness-guardrails.test.ts`).
- **Still open after v1:** portal/anon token-route policies and storage policies. *(Corrected 2026-07-27: **browser E2E is no longer open** — `playwright.config.ts` plus 53 specs under `e2e/` run as the `browser-e2e` CI job. The DB lane itself has grown to 95 `.db.test.ts` suites.)* The generated-types drift check shipped in PR #221 (next section).

## Generated types drift check (PR #221)

`scripts/check-db-types.mjs` (`npm run check:db-types`) keeps the hand-rolled `lib/types/database.ts` honest against the migrated schema:

- **How it works:** runs `supabase gen types typescript --local` against the SAME local migrated database the tests/db/ lane uses, then compares COLUMN SETS exactly, both directions, for 15 curated tables (studios, practitioners, clients, appointments, sessions, session_blocks, electrolysis_entries, laser_entries, client_intake_forms, treatment_plans, treatment_plan_stages, and the four record_keeping tables). A column in the database but missing from the app type fails; a phantom column in the app type fails. Eleven recently added columns (probe_lot_number, default_machine_frequency, aftercare fields, tolerance/reaction/caution fields, next_session_note, calendar_feed_token_hash) are individually pinned.
- **Why curated, not a full-file diff:** `lib/types/database.ts` is deliberately hand-rolled with narrowed unions (e.g. `modality: "electrolysis" | "laser"`) that carry MORE information than generated `string` types, so a byte diff against generated output is structurally impossible. Column-set comparison catches the drift that matters (missing or phantom columns) without forcing the types file into the generated shape.
- **Payment/webhook tables:** payment_charge_attempts, manual_fee_charge_attempts, stripe_events, and ops_alerts have no central hand-rolled type (billing modules type their rows inline), so the check asserts the DATABASE side: the columns the executors, receipt/refund senders, and webhook reconciliation rely on must exist in the migrated schema.
- **First-run catch:** the check immediately found six live columns missing from the app types (practitioners.calendar_feed_token_hash + the four 0027 terms/privacy stamps, clients.normalized_email); PR #221 added the declarations (types-only, additive).
- **How to run locally:** `supabase db start && supabase db reset --local && npm run check:db-types`. CI runs it in the `db-integration` job after the DB/RLS tests.
- **Safety:** generation is hardcoded to `--local` (no project ref, no `--linked`, no access token); the script refuses hosted or non-localhost `SUPABASE_DB_URL`/`HONE_LOCAL_DB_URL` values and reads no production credentials. It never touches production. Pins live in `tests/scripts/db-types-drift.test.ts`.
- **Deferred:** nullability/type-level comparison (column presence only in v1) and tables outside the curated list.

---

## Recent tail (0093 → 0157)

The historical migration table above stops at ~0092. **Everything from 0093 through 0157 is
applied in production** (prod max = **0157**). Full per-migration purposes and applied status:
[docs/production/migration-ledger.md](./production/migration-ledger.md).

### Timeline summary 0113 → 0157

| Range | Theme | Posture today |
|---|---|---|
| 0114–0118 | Clinical delete/soft-delete hardening, calendar-feed credential hash-only, `session_audit` cross-tenant INSERT hardening, intake terminal-state immutability | Live |
| 0119–0120 | Signed clinical records — Phase 1 (finalization boundary) + Phase 2 (signed corrections & amendments backend) | **RETIRED by product decision (2026-07-29), enforced by 0159** — not a Hone capability. Flags pinned `false`, RPC `EXECUTE` revoked from every runtime role, no session may enter `finalized`/`void`, the three signed ledgers refuse INSERT. Nothing dropped: 0119/0120 stay replayable and the one legacy artifact stays readable and immutable. Read them as **history** |
| 0121–0122 | Google Calendar Phase A — connection & OAuth foundation | Deployed; connection flag ON for the controlled test studio only |
| 0123 | Atomic aggregate soft-delete of a wrongly-recorded treatment area | Live |
| 0124–0125 | Google Calendar B1 outbound schema/queue + B2.3-a intent-gated enqueue | Deployed; **1 outbox row + 1 event link** from a single controlled validation |
| 0126–0127 | Append-only `client_clinical_notes` + its RLS fix | **Live, all studios, no flag** |
| 0128–0130 | Session-block areas, atomic multi-area/laterality writes, revoke residual `anon` EXECUTE | Live |
| 0131–0132 | Google Calendar B2.4 dual-destination + B2.3-c1 event-link transitions | Deployed dormant |
| 0133 | Atomic same-record appointment move | Live |
| 0134–0139 | Practitioner-capacity foundation, per-practitioner availability, scoped blocks/breaks + lock hardening | Deployed; capacity flag ON for the controlled test studio only, **OFF at Willow**; the public booking flag is **OFF everywhere** |
| 0140–0141 | Studio onboarding v2 + invitation reconciliation / single authoritative consent | Deployed; onboarding flag ON for the test studio only |
| 0142–0150 | Atomic internal booking + move/reassign commands, authoritative in-DB duration, shared availability validator, locked schedule writers | Live (gated by the capacity flag) |
| 0151 | Appointment tenant-consistency composite FKs | Live — closed a real cross-studio reference gap |
| 0152 | Actual overlap HARD / configured buffer SOFT | Live |
| 0153–0156 | Per-service calendar colour, notification dedupe key, probe-inventory linkage, conditional numbing notes | Live |
| **0157** | **Whole-session copy — provenance ledger + 4 SECURITY DEFINER functions** | **Applied + deployed + enabled; 0 ledger rows — never production-exercised** |

**0158 is deliberately skipped** (the number is claimed so two artifacts can never share it —
DRAFT PR #481 carries a different, superseded 0158 on a branch retained for audit evidence), and
**both `0159` and `0160` were applied and verified in production on 2026-07-30** — the signed-record
retirement and the clinical-lineage protection are each **database-enforced**.

| # | Theme | Posture |
|---|---|---|
| ~~0158~~ | *(skipped — see above)* | Never written to this branch |
| **0159** | **Retire signed / finalized clinical records + safe clinical-privilege hardening** | **APPLIED to production 2026-07-30** (13:25:39Z–13:25:43Z), verified. Additive and non-destructive: zero data operations, nothing dropped. Flags pinned `false`, retired RPC `EXECUTE` revoked, `finalized`/`void` transitions refused, the three signed ledgers refuse INSERT, `anon` clinical write privileges and `anon`/`authenticated` `TRUNCATE`/`REFERENCES`/`TRIGGER` removed, `session_block_areas` read-only to browser roles. Direct DML on `sessions` / `session_blocks` / `electrolysis_entries` / `laser_entries` / `treatment_images` is **not** revoked — the deployed app still writes those directly; that is the follow-up PR |
| **0160** | **Immutable clinical lineage** | **APPLIED to production 2026-07-30** (17:52:48Z–17:52:51Z), verified; sha256 `e56a1ee7…6094d4`. Ran inside its own explicit `begin;`/`commit;` so the lock timeout armed — no 25P01, no 55P03. Pins the lineage columns immutable on UPDATE only — `sessions(client_id, studio_id)`, `session_blocks(session_id, studio_id)`, `electrolysis_entries(session_id)` strict and `block_id` clearable (its FK is `ON DELETE SET NULL`), `laser_entries(session_id)` — closing same-studio wrong-client / wrong-record re-parenting, which RLS permits because the member predicate still holds after the parent changes. `treatment_images` is deliberately left to 0093, which already does it correctly. Zero data operations, no grant, no policy, no clinical-content column pinned |

### One-line purposes, 0093–0112

- **0093** harden treatment-image storage (service-role-only + path/identity CHECKs + integrity trigger) — **applied**.
- **0094** tenant-consistency composite FKs (sessions/blocks/intake/imported same-studio) — **applied**.
- **0095** `session_blocks.numbing_status` + `probe_lot_confirmed` — **applied**.
- **0096** `record_keeping_disinfectants.discard_due_date` — **applied**.
- **0097** intake link columns · **0098** intake reminder columns/indexes/RPC · **0099** `treatment_images.practitioner_note` — **applied**.
- **0101 / 0103 / 0105** payment live-capability + mode-scoped settings + mode-scoped attempt uniqueness — **applied**. These underpin the now-live posture: supervised live owner-run **session** payments are live for approved studios, with live/test isolation for cards + attempts (public card collection, deposits/packages/partial, and live manual fees remain off/held — see [current-state](./production/current-state.md)).
- **0106** studio marketing tracking + booking consent · **0107** encrypted provider token + owner-only RLS — **applied**.
- **0108** electrolysis observation chips — **applied**.
- **0109** studio time-format preference (default 12h) — **applied**.
- **0110** studio postcare delivery mode (default `manual`; auto-send opt-in) — **applied**.
- **0111** client portal access events (append-only, SELECT-only RLS, service-role inserts, no token/PII columns) — **applied**.
- **0112** public booking horizon CHECK widened `(3,4,6)`→`(1..12)` — **applied**.

RLS posture for the new tables: `client_portal_access_events` (0111) has a single studio-member
SELECT policy and no INSERT/UPDATE/DELETE policy (service-role writes only) + a composite
same-studio FK; `treatment_images` storage (0092/0093) is service-role-only with an integrity
trigger. See the [migration ledger](./production/migration-ledger.md) +
[03_SECURITY_AND_PRIVACY.md](./03_SECURITY_AND_PRIVACY.md).

---

## Where to look next

1. [docs/production/current-state.md](./production/current-state.md) — canonical snapshot.
2. [docs/production/capability-register.md](./production/capability-register.md) — per-capability status + evidence.
3. [docs/production/known-limitations.md](./production/known-limitations.md) — verified residual gaps.
4. [docs/production/migration-ledger.md](./production/migration-ledger.md) — migration facts.
5. [docs/14_AI_HANDOFF.md](./14_AI_HANDOFF.md) — dated chronology, historical only.
