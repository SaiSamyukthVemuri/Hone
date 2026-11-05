-- CLN-001/CLN-003 later enforcement. OPS allocated0248 source-only.
-- APPLY ORDER:0243 additive revision/CAS -> verified public+assisted CAS
-- callers and rollback artifacts -> drain old editors/processes/detached
-- profile callbacks -> separately approved0248. Never apply a full pending
-- chain before caller rollout. No local/hosted apply is authorized by source.
-- After enforcement, rolling application rollback must remain CAS-compatible;
-- there is no legacy protected-DML fallback or reverse schema rollback here.
begin;
set local lock_timeout = '5s';

create or replace function public.advance_intake_revision()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  v_writer_owner pg_catalog.oid;
begin
  if tg_op = 'UPDATE' and (
    new.responses is distinct from old.responses
    or new.current_step is distinct from old.current_step
    or new.submitted_at is distinct from old.submitted_at
    or (new.status is distinct from old.status
      and (old.status = 'submitted' and new.status = 'reviewed') is not true)
  ) then
    -- Invoker context is load-bearing: only the existing trusted CAS owner
    -- may perform protected writes. JWT claims, counters and caller settings
    -- cannot turn an ordinary runtime UPDATE into the governed transaction.
    select p.proowner into v_writer_owner
      from pg_catalog.pg_proc p
      where p.oid = pg_catalog.to_regprocedure(
        'public.write_intake_revision(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int8,pg_catalog.jsonb,pg_catalog.int4,pg_catalog.text,pg_catalog.jsonb)');
    if v_writer_owner is null
       or current_user is distinct from pg_catalog.pg_get_userbyid(v_writer_owner) then
      raise exception 'Protected intake changes require the governed revision command.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.revision := 0;
  else
    -- Ignore caller-supplied counters. This also invalidates stale editors on
    -- notes/review/link writes without exempting any existing terminal guard.
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;


-- Refuse an unsafe execution context instead of granting or assuming one.
-- Both functions must retain the same existing trusted owner; closure adds
-- no runtime owner authority or role assumption.
do $$
declare
  v_writer oid := pg_catalog.to_regprocedure(
    'public.write_intake_revision(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int8,pg_catalog.jsonb,pg_catalog.int4,pg_catalog.text,pg_catalog.jsonb)');
  v_guard oid := pg_catalog.to_regprocedure('public.advance_intake_revision()');
  v_owner oid;
  v_service oid;
  v_role record;
  v_runtime_count integer := 0;
begin
  select p.proowner into v_owner from pg_catalog.pg_proc p where p.oid = v_writer;
  select r.oid into v_service from pg_catalog.pg_roles r where r.rolname = 'service_role';
  if v_owner is null or v_service is null or not exists (
    select 1 from pg_catalog.pg_proc p
      where p.oid = v_writer and p.prosecdef
        and p.proconfig = array['search_path=""']::text[]
  ) or not exists (
    select 1 from pg_catalog.pg_proc p
      where p.oid = v_guard and not p.prosecdef and p.proowner = v_owner
        and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'Unsafe intake revision execution context.';
  end if;
  for v_role in select r.oid, r.rolname from pg_catalog.pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
  loop
    v_runtime_count := v_runtime_count + 1;
    if v_role.oid = v_owner
       or pg_catalog.pg_has_role(v_role.oid, v_owner, 'MEMBER')
       or pg_catalog.pg_has_role(v_role.oid, v_owner, 'SET') then
      raise exception 'Intake revision owner is assumable by a runtime role.';
    end if;
  end loop;
  if v_runtime_count <> 4
     or not pg_catalog.has_function_privilege('service_role', v_writer, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_writer, 'EXECUTE')
     or exists (
       select 1 from pg_catalog.pg_proc p,
         lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
       where p.oid = v_writer and a.privilege_type = 'EXECUTE'
         and (a.grantee not in (v_owner, v_service)
            or (a.grantee <> v_owner and a.is_grantable))
     ) then
    raise exception 'Unsafe intake revision command privileges.';
  end if;
  if not pg_catalog.has_table_privilege(v_owner, 'public.client_intake_forms', 'SELECT')
     or not pg_catalog.has_table_privilege(v_owner, 'public.client_intake_forms', 'UPDATE')
     or not pg_catalog.has_table_privilege(v_owner, 'public.clients', 'SELECT')
     or not pg_catalog.has_table_privilege(v_owner, 'public.clients', 'UPDATE') then
    raise exception 'Existing intake revision owner authority is unavailable.';
  end if;
  -- 0216's authenticated receptionist contacts command reads completion facts
  -- only. Pin its exact reviewed implementation/context, never its name alone.
  -- Unknown or changed callable delegates still require explicit review.
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.oid <> v_writer
      and p.prosrc ~* '(^|[^a-z0-9_])client_intake_forms([^a-z0-9_]|$)'
      and (
        p.oid = pg_catalog.to_regprocedure('public.receptionist_client_contacts(pg_catalog.uuid,pg_catalog.text,pg_catalog.int4)')
        and p.proowner = v_owner and p.provolatile = 's' and p.prokind = 'f'
        and p.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'plpgsql')
        and p.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
        and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = '4ad10247566c4186a5c03d12180c2946ae05919fcc75f4145e5a8566ada9ff6a'
        and exists (
          select 1 from pg_catalog.pg_proc helper
          where helper.oid = pg_catalog.to_regprocedure('public.receptionist_actor_id(pg_catalog.uuid)')
            and helper.proowner = p.proowner and helper.prosecdef
            and helper.provolatile = 's' and helper.prokind = 'f'
            and helper.prolang = (select l.oid from pg_catalog.pg_language l where l.lanname = 'sql')
            and helper.proconfig = array['search_path=pg_catalog, pg_temp']::text[]
            and pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(helper.prosrc, 'UTF8')), 'hex') = 'cf6256e2abdaaa6c319b17b26b22da159ab1017d5b2970676695961bdd9af7b4'
            and not pg_catalog.has_function_privilege('anon', helper.oid, 'EXECUTE')
            and not pg_catalog.has_function_privilege('authenticated', helper.oid, 'EXECUTE')
            and not pg_catalog.has_function_privilege('service_role', helper.oid, 'EXECUTE')
            and not exists (
              select 1 from pg_catalog.aclexplode(coalesce(helper.proacl, pg_catalog.acldefault('f', helper.proowner))) a
              where a.privilege_type = 'EXECUTE' and a.grantee <> helper.proowner
            )
        )
        and pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
        and not exists (
          select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.privilege_type = 'EXECUTE' and (a.grantee not in
            (p.proowner, (select r.oid from pg_catalog.pg_roles r where r.rolname = 'authenticated'))
            or (a.grantee <> p.proowner and a.is_grantable))
        )
      ) is not true
      and (pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE'))
  ) then
    raise exception 'Unexpected callable intake definer requires review.';
  end if;
end;
$$;

commit;
