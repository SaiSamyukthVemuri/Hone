-- 0391 DOWN (DRAFT, Willow, 27 Nov 2026). EMERGENCY ONLY: it re-opens the unauthenticated write door on public.demo_requests and public.waitlist. UNSEALED.
-- Restores the pre-0391 state exactly: the two insert policies (byte for byte as in 0004 and 0006) and all seven table privileges for anon and authenticated.
-- REFUSES (changes nothing) unless the database is in the 0391 end state: no policy on either table, anon/authenticated/PUBLIC hold nothing on them, service_role holds all seven,
-- row-level security is on, and the 0213 commands are intact. Roll the application back to a version that inserts directly FIRST or the forms keep using the RPC path (both work).
-- `supabase migration repair --status reverted 0391` is a separate step.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from pg_policy p where p.polrelid in ('public.demo_requests'::regclass, 'public.waitlist'::regclass)) then
    raise exception '0391 down: a policy exists on a lead table; this is not the 0391 end state' using errcode = '55000';
  end if;
  if exists (select 1 from information_schema.role_table_grants t where t.table_schema = 'public' and t.table_name in ('demo_requests', 'waitlist') and t.grantee in ('anon', 'authenticated', 'PUBLIC')) then
    raise exception '0391 down: anon, authenticated or PUBLIC holds a privilege on a lead table; this is not the 0391 end state' using errcode = '55000';
  end if;
  if (select count(*) from (select distinct t.table_name, t.privilege_type from information_schema.role_table_grants t where t.table_schema = 'public' and t.table_name in ('demo_requests', 'waitlist') and t.grantee = 'service_role') x) <> 14 then
    raise exception '0391 down: service_role does not hold all privileges on the lead tables' using errcode = '55000';
  end if;
  if not (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.demo_requests'::regclass, 'public.waitlist'::regclass)) then
    raise exception '0391 down: row-level security is off on a lead table' using errcode = '55000';
  end if;
  if (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.record_platform_demo_request(text,text,text,text,text,text,text,text)')) is distinct from '788497271ba86e11c194a5cc5a5e97c1'
     or (select md5(p.prosrc) from pg_proc p where p.oid = to_regprocedure('public.record_platform_early_access_signup(text)')) is distinct from '9a7f6d8135d1afda19f19eae28b5f258' then
    raise exception '0391 down: the 0213 lead commands are not the expected bodies' using errcode = '55000';
  end if;
end;
$$;

create policy "demo_requests_anonymous_insert"
  on public.demo_requests
  for insert
  to anon, authenticated
  with check (true);

create policy "waitlist_anonymous_insert"
  on public.waitlist
  for insert
  to anon, authenticated
  with check (true);

grant all privileges on table public.demo_requests to anon;
grant all privileges on table public.demo_requests to authenticated;
grant all privileges on table public.waitlist to anon;
grant all privileges on table public.waitlist to authenticated;

commit;
