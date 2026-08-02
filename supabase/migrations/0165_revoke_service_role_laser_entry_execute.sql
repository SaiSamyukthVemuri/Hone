-- ---------------------------------------------------------------------------
-- 0165 — revoke the unintended `service_role` EXECUTE on create_laser_entry
--
-- WHAT WENT WRONG IN 0164
-- ===========================================================================
-- 0164 created `public.create_laser_entry` and intended EXECUTE to reach
-- `authenticated` ONLY. Its own header says, verbatim, "There is deliberately
-- no service_role grant". That statement was FALSE as deployed.
--
-- Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`,
-- `authenticated` AND `service_role` at function-create time. 0164 revoked from
-- `public` and from `anon` — it did NOT revoke from `service_role`. The
-- deployed ACL after the 2026-08-02 apply was:
--
--   {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- This is the SAME defect as 0129, which revoked only `from public` and left
-- `anon` holding EXECUTE until 0130 cleaned it up. 0164 quoted that lesson in
-- its own comments and then reproduced it one role over. The generalised rule
-- is now pinned by tests/security/clinical-rpc-grant-guard.test.ts: an
-- authenticated-only clinical RPC migration must revoke EVERY role Supabase's
-- default privileges grant at create time — `public`, `anon` AND
-- `service_role` — explicitly, by name.
--
-- EXPOSURE: NONE FOUND, AND THIS IS WHY
-- ===========================================================================
-- `create_laser_entry`'s first statement is:
--
--   if auth.uid() is null then raise exception ... end if;
--
-- A `service_role` caller carries no JWT, so `auth.uid()` is NULL and the
-- command raises `check_violation` before touching a row. The grant was
-- therefore inert — a least-privilege deviation and a false comment, not a
-- reachable path. It is repaired here anyway: a privilege that the source says
-- does not exist is exactly the drift that later gets read as intentional.
--
-- SAFETY
-- ===========================================================================
--   * ONE statement: a single REVOKE on ONE exact function signature.
--   * 0164 is APPLIED and FROZEN at sha256
--     a1f3aa2754378ee5c171d62fa2a60b5c787801953f4a887b031db4ec439a3826 and is
--     NOT edited by this migration.
--   * The function is NOT recreated or replaced and its body is UNCHANGED —
--     no `create or replace`, so `prosecdef`, `search_path`, the parameter list
--     and the definition hash all stay exactly as applied.
--   * `authenticated` EXECUTE is PRESERVED. `anon` and PUBLIC already hold
--     none and are not touched.
--   * `postgres` retains ownership and its implicit access — ownership is not
--     an ACL entry that REVOKE from `service_role` can reach.
--   * NO table, column, constraint, index, policy or trigger change.
--   * NO data change, NO backfill, NO deletion. Direct table DML on
--     `laser_entries` and `electrolysis_entries` is UNCHANGED — L18 Phase 1A
--     remains additive and revokes no table privilege.
--   * NO change to global ALTER DEFAULT PRIVILEGES. That would alter grants
--     for every future object; this migration fixes exactly one function.
--   * Idempotent: REVOKE on an absent grant is a no-op, so this replays
--     cleanly on a fresh database and on one already at 0165.
--
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (0159–0164 precedent)
-- `supabase db push --linked` does NOT wrap a migration file in an explicit
-- transaction. A bare `SET LOCAL lock_timeout` therefore emits
-- `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
-- silently NEVER ARMS. This file opens the transaction itself so the timeout
-- genuinely arms and the migration commits or rolls back as one unit.
--
-- Migration max 0164 -> 0165.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

revoke execute on function public.create_laser_entry(
  uuid, uuid, text, integer, jsonb, text
) from service_role;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION (run against production AFTER applying).
--
--   select p.proname,
--          p.prosecdef,
--          array_to_string(p.proconfig, ',')                        as cfg,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
--          has_function_privilege('anon',          p.oid, 'execute') as anon_x,
--          has_function_privilege('service_role',  p.oid, 'execute') as svc_x,
--          (select count(*) from aclexplode(p.proacl) a where a.grantee = 0) as public_entries,
--          p.proacl::text                                            as acl
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'create_laser_entry';
--   -- expect: prosecdef = true, cfg = search_path="",
--   --         auth_x = true, anon_x = false, svc_x = FALSE,
--   --         public_entries = 0,
--   --         acl = {postgres=X/postgres,authenticated=X/postgres}
--
--   -- and the additive property of Phase 1A is untouched:
--   select has_table_privilege('authenticated','public.laser_entries','insert')        as l_ins,
--          has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins;
--   -- expect BOTH true
--
-- L18 REMAINS PARTIAL AND OPEN. This migration repairs one function grant. It
-- moves no writer, revokes no table privilege, and does not make either entry
-- table command-boundary complete.
-- ---------------------------------------------------------------------------
