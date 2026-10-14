---
type: security model
title: RLS, grants and SECURITY DEFINER commands
description: Hone's database security model — row-level policies versus table privileges, Supabase's default grants and why every object must revoke by name, the shapes of SECURITY DEFINER commands, which tables are SELECT-only for browser roles, composite same-studio foreign keys, the static guards that pin all of this, where production ACL verifications are recorded, and the open privilege limitations with their recorded status.
tags: [rls, grants, security-definer, tenancy, postgres, security]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-eb10efb7264b39a67076cb7b
    resource: repo://docs/09_DATABASE_AND_RLS.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-0479c4d807cfcaf49b8df86a
    resource: repo://supabase/migrations/0001_init.sql
  - id: openwiki-source-4218e1fe2341edd723eeabb1
    resource: repo://supabase/migrations/0010_booking_v1.sql
  - id: openwiki-source-fbdf612f740cde56ea99d61c
    resource: repo://supabase/migrations/0094_tenant_consistency_constraints.sql
  - id: openwiki-source-b6377b8719c9069da67ab3a3
    resource: repo://supabase/migrations/0135_practitioner_availability.sql
  - id: openwiki-source-1ae43cbf61885ff5ff5d32ea
    resource: repo://supabase/migrations/0138_scoped_sources_lock_and_dormancy.sql
  - id: openwiki-source-ee6502faff602359a7f9a90d
    resource: repo://supabase/migrations/0150_single_row_schedule_writers_locked.sql
  - id: openwiki-source-9163c55499d798eca517a43b
    resource: repo://supabase/migrations/0151_appointment_tenant_consistency.sql
  - id: openwiki-source-8c3262662e762dc5ed158150
    resource: repo://supabase/migrations/0159_retire_signed_clinical_records.sql
  - id: openwiki-source-8bd6e27557ff3f9370c10d38
    resource: repo://supabase/migrations/0172_revoke_authenticated_appointment_dml.sql
  - id: openwiki-source-8b8be5b28e40991c64830be0
    resource: repo://supabase/migrations/0173_appointment_repair_commands.sql
  - id: openwiki-source-cf30cf78074c56edc357b806
    resource: repo://supabase/migrations/0178_practitioner_identity_boundary.sql
  - id: openwiki-source-211384cfd867882e2309d030
    resource: repo://supabase/migrations/0181_multi_studio_command_authority.sql
  - id: openwiki-source-d8b9ac1fc0e05cae084a4a6f
    resource: repo://supabase/migrations/0184_client_budget_context_least_privilege.sql
  - id: openwiki-source-a803385a9cc24ff3f9f2ff15
    resource: repo://tests/db/cross-studio-isolation.db.test.ts
  - id: openwiki-source-49bfbb92a97409e934b134ee
    resource: repo://tests/db/tenant-consistency.db.test.ts
  - id: openwiki-source-dfb951c77b8f835845bbc3a0
    resource: repo://tests/security/clinical-rpc-grant-guard.test.ts
  - id: openwiki-source-25c359515eaed4aba01f2d9c
    resource: repo://tests/security/helpers/supabase-write-census.ts
  - id: openwiki-source-21736b3c0410191d83269329
    resource: repo://tests/security/service-role-allowlist.test.ts
  - id: openwiki-source-833044c4d4591cb2eabb5a7e
    resource: repo://tests/security/service-role-allowlist.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# RLS, grants and SECURITY DEFINER commands

Three layers protect tenant data, and none of them substitutes for another:

1. **Table privileges** decide which verbs a role may use at all.
2. **RLS policies** decide which rows those verbs may touch.
3. **SECURITY DEFINER commands** run as the function owner and are the governed write path.

This page separates what the **migrations declare** from what **production verification recorded** (section 7). The
applied migration range is on [Migrations and hosted state](../operations/migrations-and-hosted-state.md).

## 1. RLS is not a table privilege

Row-level security filters rows for SELECT, INSERT, UPDATE and DELETE. It does **not** govern `TRUNCATE`,
`REFERENCES`, `TRIGGER` or PostgreSQL 17's `MAINTAIN`; a role holding `TRUNCATE` can empty a table whatever its policies
say ([`docs/09_DATABASE_AND_RLS.md` § RLS is not the same thing as a table privilege](../../docs/09_DATABASE_AND_RLS.md#rls-is-not-the-same-thing-as-a-table-privilege);
[`0184` L32-L50](../../supabase/migrations/0184_client_budget_context_least_privilege.sql#L32-L50)).

Supabase's `ALTER DEFAULT PRIVILEGES` gives `anon`, `authenticated` and `service_role` the full privilege set on new
tables, and gives `EXECUTE` on new functions to them and to `PUBLIC`. A posture therefore exists only where a migration
states it. The pattern the later migrations converge on is "revoke **all**, then grant back", because a by-name denylist
written before PostgreSQL 17 cannot contain `MAINTAIN`
([`0178` L505-L535](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L505-L535)).

There is no schema-wide sweep. No migration issues `on all tables in schema public` or changes the default privileges,
so a table no migration ever names keeps the Supabase defaults; known limitation L19 records two such tables
(section 8).

## 2. RLS predicates and representative policies

The tenant predicates are two `SECURITY DEFINER` SQL functions:

- `is_studio_member(studio_id)`: `auth.uid()` holds an **active** `practitioners` row in the studio;
- `is_studio_owner(studio_id)`: the same, with role `owner`.

They are defined once and granted to `authenticated` ([`0001` L151-L189](../../supabase/migrations/0001_init.sql#L151-L189)).
Policies differ table by table:

| Table | Policy shape (latest migration) |
|---|---|
| `practitioners` | members read; no write policy; table privileges SELECT-only for every runtime role (`0178`) |
| `appointments`, `appointment_audit` | `appointments_member_select` only; `anon` and `authenticated` hold SELECT and nothing else ([`0172` L264-L287](../../supabase/migrations/0172_revoke_authenticated_appointment_dml.sql#L264-L287)) |
| `studio_availability_default`, `studio_availability_overrides` | members read; **owners** `FOR ALL` ([`0135` L101-L124](../../supabase/migrations/0135_practitioner_availability.sql#L101-L124)) |
| `services` | members select, **insert and update**; DELETE privilege revoked and no DELETE policy ([`0173` L773-L801](../../supabase/migrations/0173_appointment_repair_commands.sql#L773-L801)) |
| `studio_blockouts` | `studio_blockouts_member_all`: any active member, `FOR ALL` ([`0010` L258-L263](../../supabase/migrations/0010_booking_v1.sql#L258-L263)) |
| clinical tables (`sessions`, blocks, block areas, entries, images) | SELECT for members. `anon` lost every write and maintenance verb, and `authenticated` lost `TRUNCATE`/`REFERENCES`/`TRIGGER` ([`0159` L474-L506](../../supabase/migrations/0159_retire_signed_clinical_records.sql#L474-L506)); `authenticated` row writes were revoked by `0169` (L18, closed) |

`docs/09` lists further deliberate exceptions: default-deny outbox and secret tables, append-only ledgers, retired
immutable evidence tables, and the owner-only waitlist
([§ Deliberate exceptions](../../docs/09_DATABASE_AND_RLS.md#deliberate-exceptions--do-not-claim-one-generic-pattern-covers-everything)).

## 3. Shapes of SECURITY DEFINER code

| Shape | `EXECUTE` held by | How the actor is established | Examples |
|---|---|---|---|
| **Service-role-only command** | `service_role` only | The server adapter resolves studio and actor through `getCurrentPractitionerWithStudio()` and passes them; the command re-derives membership and role from `(studio_id, user_id)` | `admin_accept_pending_invitation`, the appointment repair commands, waitlist owner commands |
| **Authenticated-callable command** | `authenticated` only | Bound to `auth.uid()` inside the function, so there is no supplied identity to forge | `start_session`, the own-preference commands, `reconcile_my_pending_invitation` |
| **Internal helper** | nobody | Called only from other definer functions | `own_practitioner_in_studio`, `link_invited_membership` |
| **Trigger function** | default grants left in place (inert) | PostgreSQL refuses to call a trigger function directly | guard and sync triggers |

**Authenticated-callable commands** must revoke from `public`, `anon` **and** `service_role` by name; granting to
`authenticated` does not remove the others. This was learned twice: `0129` left `anon` with `EXECUTE`, and `0164` left
`service_role` with `EXECUTE` (see [`clinical-rpc-grant-guard.test.ts` L5-L37](../../tests/security/clinical-rpc-grant-guard.test.ts#L5-L37)
and the explicit per-signature block in
[`0181` L316-L338](../../supabase/migrations/0181_multi_studio_command_authority.sql#L316-L338)). `0178` revokes from all
four roles, then grants back only what each function needs
([L546-L578](../../supabase/migrations/0178_practitioner_identity_boundary.sql#L546-L578)).

Other rules for definer functions
([`docs/09` § SECURITY DEFINER RPC rules](../../docs/09_DATABASE_AND_RLS.md#security-definer-rpc-rules)): pin
`search_path` (to `pg_catalog, pg_temp`, or to `''` with fully qualified names); use typed arguments and results; take a
`FOR UPDATE` lock before a conditional update; write the audit row in the same transaction as the state change.

How each command is used is on [Appointment write authority](../scheduling/appointment-write-authority.md) and
[Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md).

## 4. Tenant-consistency constraints

RLS scopes rows, but before `0094` a child row could still point at a parent in another studio.

- **`0094`** replaced the single-column foreign keys on the clinical and import child tables with **composite**
  `(parent_id, studio_id)` keys. Each pair keeps exactly one relationship so PostgREST embeds stay unambiguous, and each
  new key mirrors the old `ON DELETE` action
  ([`0094` L1-L45](../../supabase/migrations/0094_tenant_consistency_constraints.sql#L1-L45)).
- **`0151`** did the same for `appointments.client_id`, `service_id` and `practitioner_id`, after a member was found able
  to insert an own-studio appointment that referenced another studio's client. It runs under an exclusive lock, and a
  preflight raises a fixed message that contains no personal data
  ([`0151` L1-L34](../../supabase/migrations/0151_appointment_tenant_consistency.sql#L1-L34)).

Proofs: [`tenant-consistency.db.test.ts` L49-L263](../../tests/db/tenant-consistency.db.test.ts#L49-L263) (a
cross-studio parent is rejected even when RLS lets the insert through, cascades are preserved, and there is one foreign
key per pair) and the appointment cases in
[`cross-studio-isolation.db.test.ts` L268-L395](../../tests/db/cross-studio-isolation.db.test.ts#L268-L395) (three
distinct `23503` constraint failures, plus read isolation with ground-truth checks).

## 5. Static guards

| Guard | What it pins |
|---|---|
| [`service-role-allowlist.test.ts` L49-L117](../../tests/security/service-role-allowlist.test.ts#L49-L117) | The set of files under `app/` and `lib/` that call `createAdminClient()` must **equal** the allowlist. Every entry needs a purpose, a reason and a scope-guard string present in the file, and the justification-only escape hatch stays under 5%. It proves each site has a guard symbol, not that each query is perfectly scoped ([`service-role-allowlist.ts` L1-L11](../../tests/security/service-role-allowlist.ts#L1-L11)) |
| [`supabase-write-census.ts` L5-L46](../../tests/security/helpers/supabase-write-census.ts#L5-L46) | A TypeScript-compiler-based census of Supabase writes across `app`, `lib`, `components`, `scripts` and `middleware`. It **fails closed**: anything it cannot resolve is reported as unresolved, never skipped. The appointment and entry direct-DML guards use it |
| [`clinical-rpc-grant-guard.test.ts` L93-L229](../../tests/security/clinical-rpc-grant-guard.test.ts#L93-L229) | Every migration-created, directly callable function that requires `auth.uid()` revokes from `public`, `anon` and `service_role` and grants `authenticated`. Internal helpers are never granted back, the service-role exemption list is short and justified, and trigger functions are excluded on principle ([L26-L49](../../tests/security/clinical-rpc-grant-guard.test.ts#L26-L49)) |

More guards are on [Source, docs and security guards](../testing/source-docs-and-security-guards.md).

## 6. Migration-declared posture, by table

| Table | Declared by | Browser roles | `service_role` |
|---|---|---|---|
| `appointments`, `appointment_audit` | `0172`, `0174`, `0177` | SELECT only | SELECT only on `appointments` after `0177`; see [Appointment write authority](../scheduling/appointment-write-authority.md) |
| `practitioners` | `0178` | SELECT only | SELECT only |
| clinical tables | `0159`, `0169` | SELECT; no row writes | unchanged; still holds `TRIGGER` (L20) |
| `services` | `0173` | SELECT/INSERT/UPDATE for members; no DELETE | unchanged |
| `session_audit`, `record_keeping_audit_events` | never named in any grant or revoke | Supabase defaults, including `TRUNCATE` (L19) | defaults |

## 7. What production verification records

These are records of read-only verification at a stated time, not standing guarantees; the times and values are in the
cited documents, not repeated here:

| Recorded fact | Authority |
|---|---|
| `session_copy_operations`: `authenticated` SELECT only, `anon` nothing | [`docs/09` § RLS is not the same thing as a table privilege](../../docs/09_DATABASE_AND_RLS.md#rls-is-not-the-same-thing-as-a-table-privilege) |
| A production inventory of `SECURITY DEFINER` functions in `public` found none without a pinned `search_path`, and every function executable by `authenticated` or `anon` was an RLS predicate or a trigger function | the SECURITY DEFINER inventory section of [`docs/09_DATABASE_AND_RLS.md`](../../docs/09_DATABASE_AND_RLS.md) |
| After `0169`, `authenticated` holds no direct row writes on the clinical tables (L18, closed) | [`known-limitations.md`](../../docs/production/known-limitations.md), L18 |
| After `0172`, `anon` and `authenticated` hold SELECT only on both appointment tables | [`known-limitations.md` § L19](../../docs/production/known-limitations.md#l19--truncate-is-still-granted-broadly-outside-the-clinical-tables-and-two-session-links-are-not-same-client-validated) |
| `studios_admission_mode_guard()` holds `EXECUTE` for `anon`, `authenticated`, `service_role` and `PUBLIC` (L33) | [`known-limitations.md` § L33](../../docs/production/known-limitations.md#l33--0204s-admission-guard-trigger-holds-execute-for-every-application-role-including-public) |

## 8. Privilege limitations: status as recorded in `known-limitations.md`

| ID | Subject | Recorded status |
|---|---|---|
| L17 | The deep production, security and code audit has not been performed; passing tests are not evidence of security | open; blocks broader launch ([§ L17](../../docs/production/known-limitations.md#l17--the-deep-production--security--code-audit-has-not-been-performed)) |
| L18 | `authenticated` direct row writes on the clinical tables | **closed** (`0169`) |
| L19 | `TRUNCATE` still granted broadly; two session links not checked for same client | (a) **narrowed, not closed**: `session_audit` and `record_keeping_audit_events` still carry the default grant, and the repo-wide sweep is the stated fix. (b) untouched ([§ L19](../../docs/production/known-limitations.md#l19--truncate-is-still-granted-broadly-outside-the-clinical-tables-and-two-session-links-are-not-same-client-validated)) |
| L20 | `service_role` keeps `TRIGGER` on `sessions`, `session_blocks`, `electrolysis_entries` and `laser_entries`, so `0160`'s guards are not tamper-proof against it | **open**; defence in depth, not reachable from the application ([§ L20](../../docs/production/known-limitations.md#l20--service_role-retains-trigger-on-the-clinical-tables-so-0160s-guards-are-not-tamper-proof-against-it)) |
| L21 | Hard-deleting a session in the transaction that created a block-attached image fails | **open**; unreachable from the application ([§ L21](../../docs/production/known-limitations.md#l21--hard-deleting-a-session-in-the-same-transaction-that-created-a-block-attached-treatment-image-fails)) |
| L22 | `F-CLIN-004` intake review UPDATE and INSERT boundaries | heading: **both closed** (`0162`, `0163`); other cells still describe the INSERT path as open (section 9) ([§ L22](../../docs/production/known-limitations.md#l22--f-clin-004-the-intake-review-update-and-insert-boundaries-are-both-closed)) |
| L23 | Foreign-key referential actions writing `appointments` | **closed** (`0173`) |
| L33 | `0204`'s admission guard trigger holds `EXECUTE` for every role | **open, P3, not exploitable**; needs a new migration ([§ L33](../../docs/production/known-limitations.md#l33--0204s-admission-guard-trigger-holds-execute-for-every-application-role-including-public)). The migration ledger records that `0205`, earmarked for it, was used for another change and contains no grant statements, so the deviation is still open ([`migration-ledger.md`](../../docs/production/migration-ledger.md), current block) |

## 9. Contradictions and open questions

1. **`docs/09` still calls L23 open.** It says L23 "remains OPEN in production" and that `0173` GROUP 5 is "NOT merged
   and NOT applied" ([§ RLS principles](../../docs/09_DATABASE_AND_RLS.md#rls-principles)), while `known-limitations.md`
   records L23 closed by `0173`.
2. **`docs/09` overstates owner-only writes.** It lists "Owner-only ALL" for `studios`, `services`,
   `availability_defaults` and `blockouts` ([§ RLS principles](../../docs/09_DATABASE_AND_RLS.md#rls-principles)). The
   migrations say otherwise: `services` allows any active member to INSERT and UPDATE (`0173`); `studio_blockouts` still
   carries the `0010` member `FOR ALL` policy; only the two availability tables are owner-write (`0135`).
3. **Availability writes can bypass the lock order.** The app writes availability through the locked commands of
   `0149`/`0150`, but the `0135` owner `FOR ALL` policy remains, no migration revokes the default table privileges on the
   availability tables, and the `0138` lock trigger covers only timed blocks, break rules, break occurrences and
   blockouts ([`0138` L58-L72](../../supabase/migrations/0138_scoped_sources_lock_and_dormancy.sql#L58-L72)). An owner's
   direct PostgREST write to `studio_availability_default` or `_overrides` would therefore not take the studio lock. No
   document records whether that is accepted.
4. **L22 contradicts itself.** Its heading and status line say the INSERT boundary closed with `0163`; its "Next gate"
   still says to close the INSERT residual, and its "Blocks" cell says "the INSERT path is open".
5. **Trigger-function grants: the guard and the register disagree.** The grant guard excludes trigger functions as
   "theatre", because they cannot be called directly
   ([L26-L31](../../tests/security/clinical-rpc-grant-guard.test.ts#L26-L31)), while L33 treats the same condition on
   `0204`'s trigger as a defect and its next gate asks to extend that guard to trigger functions.
6. **The `docs/09` rule table shows one shape.** Its rule "revoke from public, anon, authenticated; grant to
   service_role" ([§ SECURITY DEFINER RPC rules](../../docs/09_DATABASE_AND_RLS.md#security-definer-rpc-rules))
   describes only service-role-only commands. The authenticated-callable commands follow the opposite grant, enforced
   by the grant guard.
7. **The `docs/09` definer inventory is historical.** It predates the later migrations, and the L33 record shows at
   least one later trigger function executable by `anon`, so its figures should not be read as current.
