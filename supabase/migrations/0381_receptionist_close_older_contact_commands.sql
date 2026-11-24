-- Close the two older receptionist commands that still return a client's FULL phone and email:
--   receptionist_client_directory (created by 0274, redefined by 0374 and 0380) and
--   receptionist_client_contacts_v2 (created by 0266, redefined by 0374 and 0380).
-- Neither has a caller in the app: the desk screens use the masked booking finder, the v3 schedule and the visit-contact
-- command. Left open, an active receptionist could read the whole contact book by calling them directly, so "full contact
-- only for an authorized visit" would hold for the screens but not for the database.
--
-- Privilege only, exactly as 0266 closed the 0216 finder: EXECUTE is revoked from PUBLIC, anon, authenticated and
-- service_role, each by name. The function BODIES are not touched (still 0380's, checked by md5): reopening later is a
-- grant, and starts from the reviewed name rule. receptionist_calendar_v2 stays open (names and ids only; v3 reads it).
--
-- Fails closed: the preamble refuses unless both bodies are exactly 0380's, so this cannot apply before 0380. The
-- after-check refuses to commit if any role, including PUBLIC, can still execute either function, or if any grantee other than the
-- owner remains. Rollback: supabase/rollbacks/0381_receptionist_close_older_contact_commands.down.sql (restores the 0380 ACL).
begin;

set local lock_timeout = '5s';

-- 0) Preamble: both bodies must be exactly the 0380 bodies.
do $pre$
declare
  r record;
  v_fn regprocedure;
begin
  for r in
    select * from (values
      ('receptionist_client_directory', 'public.receptionist_client_directory(uuid, text, text[], text, integer, integer)', '9356d1ca1f30005b09b5f6ba1765d59f'),
      ('receptionist_client_contacts_v2', 'public.receptionist_client_contacts_v2(uuid, text, integer)', '2c398e896eede58c9a09a11213b122a0')
    ) as t(fname, sig, body_md5)
  loop
    v_fn := to_regprocedure(r.sig);
    if v_fn is null then
      raise exception '0381 refuses to run: % is missing', r.fname using errcode = '55000';
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and pg_catalog.md5(p.prosrc) = r.body_md5) then
      raise exception '0381 refuses to run: % is not the reviewed 0380 body (apply 0380 first)', r.fname using errcode = '55000';
    end if;
  end loop;
end
$pre$;

-- 1) Close by privilege.
revoke all on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from public, anon, authenticated, service_role;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from public;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from anon;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from authenticated;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from service_role;
revoke all on function public.receptionist_client_contacts_v2(uuid, text, integer) from public, anon, authenticated, service_role;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from authenticated;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from service_role;

comment on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) is
  '0381 CLOSED. The desk client directory (a page of clients with full phone and email) is no longer callable by any role: it has no caller in the app, and the screens use the masked finder and the visit-contact command. The body is exactly the 0380 body and is kept so that reopening starts from the reviewed name rule. Callable by nobody but its owner.';

comment on function public.receptionist_client_contacts_v2(uuid, text, integer) is
  '0381 CLOSED. The receptionist client finder v2 (full phone and email) is no longer callable by any role: the screens use the masked finder and the visit-contact command. The body is exactly the 0380 body and is kept so that reopening starts from the reviewed name rule. Callable by nobody but its owner.';

-- 2) After-check.
do $check$
declare
  r record;
  v_fn regprocedure;
begin
  for r in
    select * from (values
      ('receptionist_client_directory', 'public.receptionist_client_directory(uuid, text, text[], text, integer, integer)', '9356d1ca1f30005b09b5f6ba1765d59f'),
      ('receptionist_client_contacts_v2', 'public.receptionist_client_contacts_v2(uuid, text, integer)', '2c398e896eede58c9a09a11213b122a0')
    ) as t(fname, sig, body_md5)
  loop
    v_fn := to_regprocedure(r.sig);
    if v_fn is null then
      raise exception '0381 check: % is missing', r.fname using errcode = '55000';
    end if;
    if pg_catalog.has_function_privilege('public', v_fn, 'execute')
       or pg_catalog.has_function_privilege('anon', v_fn, 'execute')
       or pg_catalog.has_function_privilege('authenticated', v_fn, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0381 check: a role can still execute %', r.fname using errcode = '55000';
    end if;
    -- No grantee at all besides the owner, and nobody holds a grant option.
    if exists (
      select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where p.oid = v_fn and a.grantee <> p.proowner
    ) then
      raise exception '0381 check: % still has a grantee besides its owner', r.fname using errcode = '55000';
    end if;
    -- The bodies are untouched: only the privilege changed.
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and pg_catalog.md5(p.prosrc) = r.body_md5) then
      raise exception '0381 check: % body changed', r.fname using errcode = '55000';
    end if;
  end loop;
end
$check$;

commit;
