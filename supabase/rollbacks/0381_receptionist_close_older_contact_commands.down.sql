-- DOWN for 0381. EMERGENCY ONLY: it REOPENS the two older receptionist commands that return full phone and email, by restoring exactly the
-- 0380 ACL (owner plus authenticated; PUBLIC, anon and service_role revoked by name) and the 0380 comments. The bodies were never changed.
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
      raise exception '0381 down refuses to run: % is missing', r.fname using errcode = '55000';
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and pg_catalog.md5(p.prosrc) = r.body_md5) then
      raise exception '0381 down refuses to run: % is not the reviewed 0380 body (apply 0380 first)', r.fname using errcode = '55000';
    end if;
  end loop;
end
$pre$;

revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from public;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from anon;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from service_role;
grant execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) to authenticated;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from service_role;
grant execute on function public.receptionist_client_contacts_v2(uuid, text, integer) to authenticated;

comment on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) is
  '0380 desk directory: ONE page of active clients. The display name is the preferred name, else the regular client name, else the fixed words Name on file (name_on_file true only when both are blank); the legal identity is never returned or searched. Search matches the displayed name, email and phone. Order is the displayed name, then id (next-appointment sort first when asked). Same signature, columns and guards as 0374.';

comment on function public.receptionist_client_contacts_v2(uuid, text, integer) is
  '0380 receptionist client finder: the display name is the preferred name, else the regular client name, else the fixed words Name on file; the legal identity is never returned or searched. Search matches the displayed name, email and phone. Order is the displayed name, then id. Same signature, columns and guards as 0374.';

-- 1) After-check: the 0380 ACL is back (authenticated only, no PUBLIC, no grant option) and the bodies are unchanged.
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
    if not pg_catalog.has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0381 down check: authenticated cannot execute %', r.fname using errcode = '55000';
    end if;
    if pg_catalog.has_function_privilege('public', v_fn, 'execute')
       or pg_catalog.has_function_privilege('anon', v_fn, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0381 down check: a role other than authenticated can execute %', r.fname using errcode = '55000';
    end if;
    if exists (
      select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where p.oid = v_fn and (a.grantee not in (p.proowner, (select o.oid from pg_catalog.pg_roles o where o.rolname = 'authenticated')) or (a.grantee <> p.proowner and a.is_grantable))
    ) then
      raise exception '0381 down check: % has an unexpected grantee or a grant option', r.fname using errcode = '55000';
    end if;
    if not exists (select 1 from pg_catalog.pg_proc p where p.oid = v_fn and pg_catalog.md5(p.prosrc) = r.body_md5) then
      raise exception '0381 down check: % body changed', r.fname using errcode = '55000';
    end if;
  end loop;
end
$check$;

commit;
