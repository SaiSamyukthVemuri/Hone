-- ---------------------------------------------------------------------------
-- 0163 — client_intake_forms: remove the authenticated INSERT capability
--
-- FINDING (the residual 0162 explicitly did NOT close)
-- ===========================================================================
-- 0162 closed the intake review transition, but its guard is a BEFORE **UPDATE**
-- trigger, so it never fires on INSERT. An authenticated studio member could
-- therefore skip the transition entirely and INSERT a brand-new
-- client_intake_forms row that is ALREADY `status = 'reviewed'`, with a NULL
-- `submitted_at` and a forged historical `reviewed_at` — manufacturing a
-- clinical "this intake was reviewed" record for a form the client never
-- submitted, and never touching the transition the 0162 trigger guards.
--
-- Two things made it reachable, and this migration removes BOTH:
--   1. `authenticated` holds the INSERT table privilege, and
--   2. the `client_intake_forms_member_insert` RLS policy's WITH CHECK is only
--      a studio-membership test — it constrains WHICH studio you may insert
--      into, not WHAT state the row may be created in.
--
-- WHY REVOKE RATHER THAN CONSTRAIN
-- ===========================================================================
-- A narrower fix (an INSERT guard trigger, or a WITH CHECK pinning
-- `status = 'in_progress'` with NULL review metadata) would leave a browser-role
-- write path on a clinical table that NOTHING legitimately uses. A caller audit
-- at baseline `b176f115d40f25ad0efb3fc02aa6bc4db61ebda0` found exactly TWO
-- runtime INSERT writers for this table, and BOTH are service role:
--
--   * lib/intake/queries.ts :: ensureIntakeForClient        -> createAdminClient()
--   * lib/intake/queries.ts :: createIntakeRequestForClient -> createAdminClient()
--
-- (`.insert(` appears against `client_intake_forms` in no other application
-- file; there is no upsert, no INSERT-performing RPC, and no raw INSERT.
-- Every other call site reads, or updates through the RLS-scoped client.)
-- Removing the capability is therefore strictly narrowing with no legitimate
-- caller to accommodate — the strongest available boundary, and it cannot be
-- defeated by a future column default or a forgotten trigger ordering.
--
-- SCOPE — DELIBERATELY NARROW
-- ===========================================================================
-- This closes ONE finding: the `client_intake_forms` authenticated INSERT
-- residual. It is NOT a general treatment of L18. `authenticated` retains
-- direct row DML on the other clinical tables (sessions, session_blocks,
-- electrolysis_entries, laser_entries, treatment_images) and this migration
-- does not touch them. Do not describe L18 as closed.
--
-- SAFETY
-- ===========================================================================
--   * NO schema change: no table, column, constraint, index or trigger.
--   * NO data change, NO backfill, NO deletion. Privileges and one policy only.
--   * `authenticated` SELECT and UPDATE are PRESERVED — the member_select and
--     member_update policies are untouched, so reading an intake and the
--     0162-guarded review transition both keep working exactly as today.
--   * service_role / postgres INSERT is PRESERVED — the two legitimate writers
--     above are unaffected. service_role bypasses RLS and holds its own grant;
--     dropping a policy that names only `authenticated` cannot reach it.
--   * 0162's trigger and function are NOT touched. Migration 0162 is APPLIED
--     and FROZEN and must never be edited.
--   * Idempotent: every statement is `if exists` / plain REVOKE, so it replays
--     cleanly on a fresh database and on one already at 0163.
--   * Lock footprint: DROP POLICY and REVOKE take ACCESS EXCLUSIVE on
--     public.client_intake_forms very briefly, which is why lock_timeout is
--     armed below.
--
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (0159/0160/0161/0162 precedent)
-- `supabase db push --linked` does NOT wrap a migration file in an explicit
-- transaction. A bare `SET LOCAL lock_timeout` therefore emits
-- `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
-- silently NEVER ARMS, and the file is not atomic. This file opens the
-- transaction itself so the timeout genuinely arms and the whole migration
-- commits or rolls back as one unit. If the lock cannot be taken within 5s the
-- statement fails with 55P03, COMMIT is never reached, and the PREVIOUS grants
-- and policies remain in place unchanged.
--
-- Migration max 0162 -> 0163.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Defensively drop any legacy BROAD policy.
--
-- A `FOR ALL` policy would silently re-grant INSERT through the back door even
-- after the dedicated INSERT policy is gone, because FOR ALL covers every
-- command. None is present at this baseline (the table carries exactly three
-- policies: member_select SELECT, member_insert INSERT, member_update UPDATE),
-- but dropping by every name this table has historically used makes the
-- migration safe to replay against an older database that still has one.
-- ---------------------------------------------------------------------------
drop policy if exists client_intake_forms_member_all on public.client_intake_forms;
drop policy if exists client_intake_forms_all on public.client_intake_forms;
drop policy if exists client_intake_forms_studio_member on public.client_intake_forms;
drop policy if exists client_intake_forms_member_access on public.client_intake_forms;

-- ---------------------------------------------------------------------------
-- 2. Drop the dedicated INSERT policy.
--
-- Its WITH CHECK was only `is_studio_member(studio_id)`: it decided which
-- studio a row could be created in, never what state it could be created in.
-- ---------------------------------------------------------------------------
drop policy if exists client_intake_forms_member_insert on public.client_intake_forms;

-- ---------------------------------------------------------------------------
-- 3. Remove the INSERT table privilege from both browser roles.
--
-- Dropping the policy alone is already sufficient under RLS (no policy for a
-- command = deny), but the grant is the load-bearing half: it is what a future
-- `create policy ... for all` or a re-added INSERT policy would silently
-- re-enable. Revoking BOTH means two independent things must be undone before
-- a browser role can insert again.
--
-- `anon` is revoked as well. It cannot satisfy a membership check today, so
-- this is defence in depth rather than a live hole — and it is the exact
-- lesson from 0129/0130, where `revoke ... from public` alone left `anon`
-- holding a privilege because Supabase's ALTER DEFAULT PRIVILEGES grants it at
-- create time. Revoke from the ROLE, explicitly, by name.
-- ---------------------------------------------------------------------------
revoke insert on public.client_intake_forms from authenticated;
revoke insert on public.client_intake_forms from anon;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION (run against production AFTER applying).
--
--   -- (a) no INSERT privilege remains for either browser role
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema='public' and table_name='client_intake_forms'
--      and grantee in ('anon','authenticated') and privilege_type='INSERT';
--   -- expect ZERO rows
--
--   -- (b) no INSERT-capable policy remains; SELECT and UPDATE survive
--   select policyname, cmd, roles::text
--     from pg_policies
--    where schemaname='public' and tablename='client_intake_forms'
--    order by cmd, policyname;
--   -- expect exactly: member_select (SELECT), member_update (UPDATE)
--   -- and NO policy whose cmd is INSERT or ALL
--
--   -- (c) the 0162 review guard is untouched
--   select t.tgname, t.tgenabled, p.proname, p.prosecdef,
--          md5(pg_get_functiondef(p.oid)) as fn_md5
--     from pg_trigger t
--     join pg_class c on c.oid = t.tgrelid
--     join pg_proc  p on p.oid = t.tgfoid
--    where not t.tgisinternal and c.relname='client_intake_forms';
--   -- expect client_intake_forms_terminal_immutability still 'O',
--   -- enforce_intake_terminal_immutability, prosecdef=false,
--   -- fn_md5 UNCHANGED from the 0162 apply (9e50a57a0781d5caa045224f2dd05970)
--
--   -- (d) zero rows touched
--   select count(*) from public.client_intake_forms;
--   -- expect the pre-apply count, unchanged
--
-- This migration rewrites no row, so it neither creates nor repairs any
-- inconsistent record. Any pre-existing forged row (none are known to exist —
-- the production inconsistency probes have read zero throughout) would need a
-- separate, explicitly authorized reconciliation with the practitioner.
-- ---------------------------------------------------------------------------
