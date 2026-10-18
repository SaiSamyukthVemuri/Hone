# D1 release packet: apply `0211` then `0212` (#824)

**Prepared:** 2026-10-12.

**Status (2026-10-12): EXECUTED. Both migrations are applied; neither PR is merged.**
- `0211` was applied at about 19:40Z from #827 `481e60c6` (DEC-1).
- `0212` was applied at about 22:00Z from #832 **`7116c668`**, not `ba8fc505`. Under DEC-2 it waited for a clean exact-head Codex review; two ledger-only findings moved the head, and the SQL is byte-identical.
- The authoritative apply records are `docs/production/migration-ledger.md` and `docs/production/migration-state.json`, now hosted max **0212**. This packet is kept as the pre-apply plan; its heads, CI and evidence below are as of preparation.
- Exceptions retained, none of them green: the shepherd is UNKNOWN (`read_failed`); the `verify-production` FAIL is the two accepted historical payment alerts; its INCOMPLETE is the missing Upstash env.
- One post-apply effect of `0211` is a rare public-booking consent-stamp race that skips one confirmation SMS. It is fixed app-side in #827 (`a4e6f017`), unmerged, and had 0 occurrences when this was written.
- Nothing was merged or configured, and no message was sent.

**Scope:** two migrations, applied one at a time, each from its own reviewed head. Both PRs stay **unmerged** through D1.

Process: [migration-first-process.md](./migration-first-process.md). Overall order: [delivery-monitoring-activation.md](./delivery-monitoring-activation.md) §1 and §5.

Two different changes:

| | `0211` (#827, G3) | `0212` (#832, DELIVERY-EVENTS-01) |
|---|---|---|
| What it is | A **guard on an existing live table** (`public.clients`) | **New, empty tables** and service-only commands |
| Live behaviour change at apply | **Yes, by design.** Raw API callers lose the ability to add, change or erase SMS consent, or to clear an opt-out | **None.** Nothing reads or writes the new objects until #832 is merged and deployed |
| Existing rows | Not read, rewritten or validated | Not touched |
| Rollback | A forward migration dropping the trigger and function restores today's behaviour exactly | A forward migration dropping the new objects, while they are still unused |

---

## 1. Reviewed heads and file identity

| | PR | Exact head | File | sha256 |
|---|---|---|---|---|
| `0211` | #827 `fix/g3-client-sms-field-guard` | `481e60c60ae8c873a2e1b6e2a0ccc5b9dc0b8c11` | `supabase/migrations/0211_client_sms_permission_guard.sql` | `33232496322727b2db67e33f15a38bd6281898d112d4d6b4d3b25534766578c3` |
| `0212` | #832 `feat/delivery-events-01-resend` | `ba8fc5057c1ab3c331caec4be64801f5e8d901b0` | `supabase/migrations/0212_email_delivery_events.sql` | `cc2abfa3059157b841c1c1c095a84045410121be13d96ff93e34f8332f81d6d1` |

#832 is based on #827 and carries `0211` **byte-identical** to #827's head. Under `supabase/`, #832 adds only `0212`.

**If either head moves, this packet is void for that migration.** Recompute the hash and re-collect the evidence in §2.

## 2. Evidence at those heads

| Evidence | `0211` | `0212` |
|---|---|---|
| PR CI at the exact head | #827 run `38164242975` at `481e60c6`: **success**. Validate, DB integration and core browser passed; the other lanes were skipped by classification. | #832 run `38261065367` at `ba8fc505`: **11/11 success**. See the note below. |
| Codex review | #827 and #832 are drafts and have no direct review. Both files were reviewed **byte-identical** inside #831, at `45a0fb8f` and `1d01521c`. Neither review opened a thread on `0211`. | Same reviews; no thread on `0212`'s SQL. The open #831 threads on `0212`'s *route* (4244387538, 4248920477) are fixed in #832 (`fd6f2f3d`, `ba8fc505`) and left open for the operator. |
| Real-role DB proof, isolated stack, **exactly 0001–0212 at `ba8fc505`** (fresh `db reset`, pinned CLI 2.102.0) | `tests/db/client-sms-permission-guard.db.test.ts` passes, within the 4-suite run of **137/137** | `tests/db/email-delivery-events.db.test.ts`, `export-resource-registry`, `welcome-email-delivery`, within the same **137/137** |
| Full DB suite on that same chain | **178/178 files pass** (one run): see the note below this table | same |
| Migration source contracts | `tests/migrations/0211-…` passes, within **36/36** | `tests/migrations/0212-…` passes, within **36/36** |
| Negative controls (recorded on the PRs) | #827: 10/10 mutations caught | #832: 6 SQL and 3 TypeScript mutants, each red then restored green |

**Full DB suite note:**
- The first unpinned run of 178 files showed 16 failing files: 84 tests, every one of them in 16 files that read through the HTTP API.
- Cause: `e2e/helpers/local-env.ts` hard-codes the API at `127.0.0.1:54321`, the shared default stack, while `HONE_LOCAL_DB_URL` pointed the seeding at this stack. None of the failures came from the `0211` guard: no `clients_sms_permission_guard` error, no `42501` or `23514`.
- Re-run with **both** routes pinned to this stack (the port-swap wrapper, `local-env.ts` restored clean):
  - those 16 files: **244/244**;
  - the other 4 API-routed files, which had passed unpinned and so may have run on the wrong stack: **38/38**;
  - the remaining 158 files use only `HONE_LOCAL_DB_URL` and passed in the first run.

**CI note for #832 `ba8fc505`:**
- the previous head, `fd6f2f3d`, was **11/11 green** (run `38206252401`);
- `ba8fc505` changes only the webhook route, its test and one doc line. The migration bytes are unchanged;
- **at this head, `ba8fc505`: run `38261065367`, 11/11 jobs green**, including validate, DB integration and browser.

## 3. Effects on existing permissions and behaviour

### `0211`: consent guard on `public.clients`

**Objects:**
- one `SECURITY INVOKER` function, `public.clients_sms_permission_guard()`. Execute is revoked from `public`, `anon`, `authenticated` and `service_role`; a trigger function needs no execute grant;
- one trigger: `BEFORE INSERT`, and `BEFORE UPDATE OF sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source`.

**Privileges:** no table grant, RLS policy or function grant changes. `authenticated` keeps its table-wide INSERT and UPDATE on `clients`. The guard sits **under** those grants and keys on the database role.

**Rules once applied:**
- **`anon` / `authenticated` (raw API, every studio member):**
  - may never add, change or erase consent; refused with `42501`;
  - may add an opt-out where none exists, only with source `practitioner`. The time is stamped by the database clock.
- **Every role:**
  - consent evidence is write-once; refused with `23514`;
  - an opt-out is terminal and immutable; refused with `23514`.

**Deployed code is unaffected** (census at `6c5eac80`, re-checked against the production branch today). The only writers of the four fields are:
- **W1**, `create_public_appointment_for_new_client`. A definer command that inserts a new client with consent.
- **W2**, `app/book/[slug]/actions.ts`, using `createAdminClient()` (service_role). It stamps consent only when the client has neither consent nor an opt-out, which is write-once compliant.
- **W3**, `app/api/twilio/inbound-sms/route.ts`, also service_role. It sets the opt-out only `where sms_opted_out_at is null`, which is terminal-compliant.

No member-session write touches the four fields: new client, quick-add, edit, archive, CSV import and intake were all checked. `app/(app)/calendar/actions.ts` only *reads* them to gate the confirmation text.

**Product rules decided by approving `0211`** (#827 "Remaining decisions"; recommendations shown):
1. Members may record a withdrawal directly (source `practitioner`, database clock): **allow**.
2. Trusted roles also obey write-once consent and terminal opt-out: **yes**. Any future START or re-subscribe flow needs its own migration.

Approving D1 means accepting these two as recommended. #827's questions 3, 4 and 6 (phone-change consent, the optional audit of the 54 existing consents, receptionist withdrawal) do not block this apply.

**Locking:**
- `create trigger` takes `SHARE ROW EXCLUSIVE` on `clients`, which briefly blocks concurrent client writes.
- The file sets `lock_timeout = '5s'` inside its own transaction. If the lock is not granted in time, the **whole migration rolls back** and nothing changes; retry at a quieter moment.

### `0212`: delivery tables

**Objects:**
- two new tables, `email_outbound_messages` and `email_provider_events`, with RLS enabled, no policy, and every table privilege revoked from `public`, `anon`, `authenticated` **and** `service_role`. They are reached only through definer commands;
- four guard/default triggers on those new tables only;
- five commands, executable by `service_role` only: `begin_appointment_email_message`, `settle_email_message`, `record_email_provider_event`, `claim_email_provider_events`, `process_email_provider_event`.

**Existing tables:** no column, trigger, constraint, policy or grant is added to or changed on any existing table.

**The new tables reference existing ones:**
- `studios(id)`, on delete cascade;
- `appointments (id, studio_id)`, on delete cascade, through the 0032 unique key `appointments_id_studio_id_unique`.

So a later studio or appointment hard delete also removes its ledger rows. Delete behaviour does not change while the tables are empty, which they are until #832 is merged.

**Locking:** creating those foreign keys takes `SHARE ROW EXCLUSIVE` on `studios` and `appointments` while the `create table` runs, released at commit. It is under the same `lock_timeout = '5s'`, with the same all-or-nothing rollback.

**Behaviour at apply:** none. The deployed code calls none of the commands and has no webhook route. The route ships with #832 and stays inert without `RESEND_WEBHOOK_SECRET`.

## 4. Ordered commands

Run by the operator, under the production-safety checks in CLAUDE.md §5. Each push runs from a **clean detached checkout of that PR's exact head**, so its dry-run can list only the one new file.

```bash
# 0. Once: the pinned CLI everywhere below.
SB="npx --yes supabase@2.102.0"

# ---- 0211 -------------------------------------------------------------
git -C /srv/hone/repo fetch origin
git -C /srv/hone/repo worktree add --detach /srv/hone/worktrees/d1-0211 481e60c60ae8c873a2e1b6e2a0ccc5b9dc0b8c11
cd /srv/hone/worktrees/d1-0211
test "$(git rev-parse HEAD)" = 481e60c60ae8c873a2e1b6e2a0ccc5b9dc0b8c11
sha256sum supabase/migrations/0211_client_sms_permission_guard.sql   # must equal §1
$SB link --project-ref <canonical Hone production ref>                # then:
cat supabase/.temp/project-ref                                        # must be the canonical ref
$SB migration list --linked              # remote max 0210; 0211 is the ONLY local-only row
$SB db push --linked --dry-run           # must print EXACTLY 0211_client_sms_permission_guard.sql
#   STOP if it lists anything else, or if the remote max is not 0210.
$SB db push --linked                     # never --include-all
#   then run §5 "after 0211". STOP on any mismatch.

# ---- 0212 -------------------------------------------------------------
git -C /srv/hone/repo worktree add --detach /srv/hone/worktrees/d1-0212 ba8fc5057c1ab3c331caec4be64801f5e8d901b0
cd /srv/hone/worktrees/d1-0212
test "$(git rev-parse HEAD)" = ba8fc5057c1ab3c331caec4be64801f5e8d901b0
sha256sum supabase/migrations/0211_client_sms_permission_guard.sql supabase/migrations/0212_email_delivery_events.sql  # both must equal §1
$SB link --project-ref <canonical Hone production ref>; cat supabase/.temp/project-ref
$SB migration list --linked              # remote max 0211; 0212 is the ONLY local-only row
$SB db push --linked --dry-run           # must print EXACTLY 0212_email_delivery_events.sql
$SB db push --linked
#   then run §5 "after 0212".
```

The two pushes are **separate approvals**. Stopping after `0211` is a valid end state.

After each apply, in the **same change** that records it:
- update `docs/production/migration-state.json` (`hosted_migration_max`);
- add the apply record to `docs/production/migration-ledger.md` (CLAUDE.md §2).

## 5. Verification (read-only, `$SB db query --linked "…"`)

**Before 0211:**

```sql
select max(version), count(*) from supabase_migrations.schema_migrations;          -- 0210, and the count recorded in migration-state
select tgname from pg_trigger where tgrelid = 'public.clients'::regclass and not tgisinternal;  -- expect 0 rows today
select count(*) filter (where sms_consent_at is not null) as consents,
       count(*) filter (where sms_opted_out_at is not null) as opt_outs from public.clients;    -- record both; must be unchanged after
```

**After 0211:**

```sql
select version from supabase_migrations.schema_migrations where version > '0210';  -- exactly 0211
select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.clients'::regclass and not tgisinternal;                  -- clients_sms_permission_guard, 'O', BEFORE INSERT OR UPDATE OF the four columns
select prosecdef, proconfig from pg_proc where proname = 'clients_sms_permission_guard';  -- false (invoker), search_path pinned
select r.rolname, has_function_privilege(r.oid, 'public.clients_sms_permission_guard()', 'execute')
  from pg_roles r where r.rolname in ('anon','authenticated','service_role');      -- all false
select has_table_privilege('authenticated','public.clients','update');             -- true: unchanged
-- the consent / opt-out counts from "before": identical
```

**After 0212:**

```sql
select version from supabase_migrations.schema_migrations where version > '0210' order by 1;  -- 0211, 0212
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
  from pg_class c where c.oid in ('public.email_outbound_messages'::regclass, 'public.email_provider_events'::regclass);  -- rls true, 0 policies
select c.relname, r.rolname, has_table_privilege(r.oid, c.oid, 'select,insert,update,delete')
  from pg_class c cross join pg_roles r
 where c.relname in ('email_outbound_messages','email_provider_events')
   and r.rolname in ('anon','authenticated','service_role');                      -- all false
select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'execute')
  from pg_proc p cross join pg_roles r
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('begin_appointment_email_message','settle_email_message','record_email_provider_event',
                     'claim_email_provider_events','process_email_provider_event')
   and r.rolname in ('anon','authenticated','service_role') order by 1, 2;        -- service_role true; anon and authenticated false
select (select count(*) from public.email_outbound_messages), (select count(*) from public.email_provider_events);  -- 0, 0
select conname from pg_constraint where conname = 'appointments_id_studio_id_unique';  -- present (0032)
```

**After either apply:**
- `node scripts/verify-production.mjs` reports **10 PASS, 1 FAIL, 1 INCOMPLETE**. That is **not a clean pass**, and it is the expected result — do not record this step as successful without saying so:
  - the **FAIL** is "Critical payment ops alerts": the two historical `session_payment_succeeded_write_zero_rows` alerts raised **2026-09-17** and **2026-09-27**, carried as a **pre-existing accepted exception** and verified identical **by id** before and after the apply (`docs/production/migration-ledger.md:67`). It is not a failure of this apply.
  - **TODO (Sam):** every record in this repository says these two alerts are *accepted*, but none names **who accepted them or when**. Record that here, so an auditor can tell an authorised exception from an unexamined one. Until then the acceptance is traceable only to the ledger entries above.
  - the **INCOMPLETE** is the scheduler heartbeat, with no Upstash env on the apply host.
  - **STOP conditions that distinguish this exception from a real failure:** a FAIL naming any OTHER event, a count other than two, or an id that differs from the two recorded in the ledger. Equally, a CLEAN PASS here means those two alerts have been resolved since — reconcile the record before continuing, rather than treating a better result as nothing to note;
- `node scripts/check-stripe-gates.mjs` gives 15 PASS;
- no new `ops_alerts` at critical or error in the last hour.

## 6. Recovery

Never edit an applied file. Every recovery below is a **new forward migration** under its own approval. Take the next free number from `npm run migration:state` and DB/WAIT at that moment.

**If a push fails:** the file's own `begin … commit` and `lock_timeout` roll it back whole. Re-run `migration list --linked` to confirm the max did not move, and retry later. Nothing to undo.

**`0211` misbehaves**, for example a legitimate path is refused:

```sql
begin; set local lock_timeout = '5s';
drop trigger if exists clients_sms_permission_guard on public.clients;
drop function if exists public.clients_sms_permission_guard();
commit;
```

This restores today's behaviour exactly. The guard never writes, so no data needs undoing.

**`0212` must come out before #832 is merged** (the tables are empty and unread):

```sql
begin; set local lock_timeout = '5s';
drop function if exists public.process_email_provider_event(uuid);
drop function if exists public.claim_email_provider_events(uuid, integer);
drop function if exists public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text);
drop function if exists public.settle_email_message(uuid, text, text, text, text);
drop function if exists public.begin_appointment_email_message(uuid, uuid, text);
drop table if exists public.email_provider_events;    -- drops its triggers; their functions follow below
drop table if exists public.email_outbound_messages;
drop function if exists public.email_provider_events_identity_guard();
drop function if exists public.email_provider_events_server_defaults();
drop function if exists public.email_outbound_messages_identity_guard();
drop function if exists public.email_outbound_messages_server_timestamps();
commit;
```

These signatures are the ones `0212` itself revokes; confirm them with `\df` on the linked project before writing the migration. After #832 is merged, revert the merge and redeploy **first**; only then drop.

**Merge order afterwards** is unchanged and not part of D1: #827, then #832 (inert on merge, §1 step 2 of the activation runbook).

## 7. What D1 does not do

- No merge, no deploy and no environment variable.
- No Resend webhook, no cron and no message.
- No emailed delivery alert (#828).
- No `0213` or later.
