-- 0391 (DRAFT, Willow, 27 Nov 2026): retire the direct anonymous inserts into public.demo_requests and public.waitlist.
-- UNSEALED. Authorizes nothing. Number to be confirmed against the open PRs and migration:state at seal time (0387-0389 are #1783's, 0390 is sealed).
--
-- WHY. 0213 (hosted) added the service-role commands record_platform_demo_request(...) and record_platform_early_access_signup(text), which write the lead AND its alert in one
-- transaction. #1818 moves the two public forms to those commands. 0213 left the old direct-insert policies in place on purpose, "until no deployed application uses
-- them". After #1818 is deployed that is true, and the policies are an open, unauthenticated write door into two tables: this migration closes it.
--
-- WHAT IT DOES (and nothing else).
--   1. Drops the policies demo_requests_anonymous_insert (0006) and waitlist_anonymous_insert (0004).
--   2. Revokes every table privilege on both tables from PUBLIC, anon and authenticated, by name. Neither form needs ANY direct table access after #1818 (the app's own
--      admin reads use the service-role client); with no policy the other privileges were already inert under row-level security, so this removes them as defence in depth.
--      service_role is NOT touched. The two tables own no sequence (uuid defaults), asserted below. The 0213 commands are not touched (their bodies are asserted by md5).
--   3. Fails closed: every precondition below is checked before anything changes, and the migration refuses (changing nothing) when production is not exactly the shape this
--      was written against. It is idempotent: against the finished state it changes nothing.
--
-- DEPLOYMENT ORDER (CRITICAL). Apply ONLY AFTER #1818 is merged AND deployed. Until then the deployed forms still insert through the policies this drops, and every signup
-- and demo request would FAIL. The database cannot see which app version is deployed, so this migration checks the one thing it can: the RPC path has been in use and the
-- direct path no longer is (a lead created after the first alert row that has no alert row means a direct insert happened after the RPC path started: refuse). That guard is
-- evidence, not proof: the deployed-app check is also a MANUAL gate (see STEPS-FOR-SAM.md): Sam or OPS confirms the production deployment runs #1818 and that /demo and the
-- early-access form each saved a lead with an alert, BEFORE the apply.
--
-- DOWN. supabase/rollbacks/0391_retire_direct_public_lead_inserts.down.sql re-creates the two policies byte for byte and re-grants the privileges this removed (the pre-state
-- pinned here: anon and authenticated held all seven table privileges; the pre-seal read confirms it on production).
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions (read-only; the migration refuses before changing anything)
-- ---------------------------------------------------------------------------
do $$
declare
  v_tables text[] := array['demo_requests', 'waitlist'];
  v_t text;
  v_privs text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  v_anon int; v_auth int; v_svc int; v_pol int;
  v_demo_sig text := 'public.record_platform_demo_request(text,text,text,text,text,text,text,text)';
  v_early_sig text := 'public.record_platform_early_access_signup(text)';
  v_first timestamptz;
begin
  -- the two tables exist with row-level security on
  foreach v_t in array v_tables loop
    if to_regclass('public.' || v_t) is null then
      raise exception '0391: public.% does not exist', v_t using errcode = 'check_violation';
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_t)::regclass) then
      raise exception '0391: row-level security is not enabled on public.%', v_t using errcode = 'check_violation';
    end if;
  end loop;

  -- the 0213 commands exist with the bodies this was written against, SECURITY DEFINER, and service_role only
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(v_demo_sig)) is distinct from '788497271ba86e11c194a5cc5a5e97c1'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure(v_early_sig)) is distinct from '9a7f6d8135d1afda19f19eae28b5f258' then
    raise exception '0391: the 0213 lead commands are not the bodies this migration was written against; re-derive' using errcode = 'check_violation';
  end if;
  if not (select bool_and(p.prosecdef) from pg_proc p where p.oid in (to_regprocedure(v_demo_sig), to_regprocedure(v_early_sig)))
     or not has_function_privilege('service_role', v_demo_sig, 'execute') or not has_function_privilege('service_role', v_early_sig, 'execute')
     or has_function_privilege('anon', v_demo_sig, 'execute') or has_function_privilege('authenticated', v_demo_sig, 'execute')
     or has_function_privilege('anon', v_early_sig, 'execute') or has_function_privilege('authenticated', v_early_sig, 'execute') then
    raise exception '0391: the 0213 lead commands are not service_role only; refusing' using errcode = 'check_violation';
  end if;

  -- policies: exactly the one expected policy per table (an insert policy for anon and authenticated, with check true, no using), or none (already retired)
  foreach v_t in array v_tables loop
    select count(*) into v_pol from pg_policy p where p.polrelid = ('public.' || v_t)::regclass;
    if v_pol > 1 or (v_pol = 1 and not exists (
         select 1 from pg_policy p
          where p.polrelid = ('public.' || v_t)::regclass
            and p.polname = case v_t when 'demo_requests' then 'demo_requests_anonymous_insert' else 'waitlist_anonymous_insert' end
            and p.polcmd = 'a' and p.polpermissive
            and p.polqual is null and pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
            and (select array_agg(r.rolname::text order by r.rolname) from pg_roles r where r.oid = any (p.polroles)) = array['anon', 'authenticated'])) then
      raise exception '0391: public.% has policies other than the one expected; refusing', v_t using errcode = 'check_violation';
    end if;
  end loop;

  -- privileges: anon and authenticated hold either all seven table privileges (before) or none (already retired); the same on both tables; service_role holds all seven;
  -- no sequence is owned by either table (a column-level grant needs no precondition: REVOKE on the table removes the column privileges too, proven in the self-check)
  select count(*) into v_anon from (select distinct t.table_name, t.privilege_type from information_schema.role_table_grants t
     where t.table_schema = 'public' and t.table_name = any (v_tables) and t.grantee = 'anon' and t.privilege_type = any (v_privs)) x;
  select count(*) into v_auth from (select distinct t.table_name, t.privilege_type from information_schema.role_table_grants t
     where t.table_schema = 'public' and t.table_name = any (v_tables) and t.grantee = 'authenticated' and t.privilege_type = any (v_privs)) x;
  select count(*) into v_svc from (select distinct t.table_name, t.privilege_type from information_schema.role_table_grants t
     where t.table_schema = 'public' and t.table_name = any (v_tables) and t.grantee = 'service_role' and t.privilege_type = any (v_privs)) x;
  if v_anon not in (0, 14) or v_auth not in (0, 14) or v_svc <> 14 then
    raise exception '0391: anon/authenticated/service_role table privileges are not the shape this was written against (anon %, authenticated %, service_role % of 14); re-derive', v_anon, v_auth, v_svc using errcode = 'check_violation';
  end if;
  if exists (select 1 from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
              where d.refobjid in ('public.demo_requests'::regclass, 'public.waitlist'::regclass) and d.deptype in ('a', 'i')) then
    raise exception '0391: one of the tables owns a sequence this migration did not account for' using errcode = 'check_violation';
  end if;

  -- the RPC path is in use and the direct path no longer is (evidence; the deployed-app check is also a manual gate)
  select min(a.created_at) into v_first from public.platform_lead_alerts a;
  if v_first is null then
    raise exception '0391: no platform lead alert exists, so the RPC path has not been used in this database; deploy #1818 and confirm a lead saves with an alert first' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.demo_requests d where d.created_at > v_first and not exists (select 1 from public.platform_lead_alerts a where a.demo_request_id = d.id))
     or exists (select 1 from public.waitlist w where w.created_at > v_first and not exists (select 1 from public.platform_lead_alerts a where a.waitlist_id = w.id)) then
    raise exception '0391: a lead was created without an alert after the RPC path started, so a deployed app still inserts directly; refusing' using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Close the door
-- ---------------------------------------------------------------------------
drop policy if exists "demo_requests_anonymous_insert" on public.demo_requests;
drop policy if exists "waitlist_anonymous_insert" on public.waitlist;

revoke all privileges on table public.demo_requests from public;
revoke all privileges on table public.demo_requests from anon;
revoke all privileges on table public.demo_requests from authenticated;
revoke all privileges on table public.waitlist from public;
revoke all privileges on table public.waitlist from anon;
revoke all privileges on table public.waitlist from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Self-check (inside the transaction: any failure rolls everything back)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_policy p where p.polrelid in ('public.demo_requests'::regclass, 'public.waitlist'::regclass)) then
    raise exception '0391 self-check: a policy remains on a lead table' using errcode = 'check_violation';
  end if;
  if exists (select 1 from information_schema.role_table_grants t where t.table_schema = 'public' and t.table_name in ('demo_requests', 'waitlist') and t.grantee in ('anon', 'authenticated', 'PUBLIC')) then
    raise exception '0391 self-check: anon, authenticated or PUBLIC still hold a privilege on a lead table' using errcode = 'check_violation';
  end if;
  if exists (select 1 from information_schema.column_privileges c where c.table_schema = 'public' and c.table_name in ('demo_requests', 'waitlist') and c.grantee in ('anon', 'authenticated', 'PUBLIC')) then
    raise exception '0391 self-check: a column-level privilege remains for anon, authenticated or PUBLIC' using errcode = 'check_violation';
  end if;
  if (select count(*) from (select distinct t.table_name, t.privilege_type from information_schema.role_table_grants t where t.table_schema = 'public' and t.table_name in ('demo_requests', 'waitlist') and t.grantee = 'service_role') x) <> 14 then
    raise exception '0391 self-check: service_role lost a privilege on a lead table' using errcode = 'check_violation';
  end if;
  if not (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.demo_requests'::regclass, 'public.waitlist'::regclass)) then
    raise exception '0391 self-check: row-level security is off on a lead table' using errcode = 'check_violation';
  end if;
  if not has_function_privilege('service_role', 'public.record_platform_demo_request(text,text,text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.record_platform_early_access_signup(text)', 'execute') then
    raise exception '0391 self-check: service_role cannot execute a 0213 lead command' using errcode = 'check_violation';
  end if;
end;
$$;

commit;
