-- ===========================================================================
-- G12 (0248-ONLY STAGE): a read-only DRY RUN of the sealed 0248's own preflight, at hosted 0246
-- Derived for the 0248-only stage; replaces the 0212-era g12 (0243-intake-definers). That rule (no callable intake definer at all) is wrong at 0246:
-- the governed writer is callable by service_role by design and 0216's receptionist command is callable by authenticated, and 0248 exempts exactly those.
-- The offender count below is the sealed 0248's own predicate, copied verbatim (only its two variables are renamed); the other columns transcribe the
-- checks that run before it. One SELECT over pg_catalog and supabase_migrations; no table data.
--
-- RUN ONLY VIA: run-window-read-macos.sh g12-0243-intake-definers-0248.sql (window-s0a-0248.sh does this).
--
-- EXPECTED PASS (every column):
--   at_hosted_0246               = 1      (the chain guard: division by zero unless the hosted history max is 0246)
--   context_ok                   = true   (writer is a search_path-pinned definer, the revision guard is an invoker with the same owner)
--   owner_not_assumable          = true   (no runtime role is, or can SET as, the writer's owner)
--   writer_privileges_ok         = true   (service_role can execute the writer; anon and authenticated cannot; no other or grantable grantee)
--   owner_authority_ok           = true   (the owner can select and update client_intake_forms and clients)
--   unexpected_callable_definers = 0      (no other callable definer reads client_intake_forms, except the pinned receptionist command)
-- STOP CONDITION: any column differs. 0248 is predicted to refuse ("Unexpected callable intake definer requires review." or an unsafe-context error).
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
),
own as (
  select
    pg_catalog.to_regprocedure('public.write_intake_revision(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.int8,pg_catalog.jsonb,pg_catalog.int4,pg_catalog.text,pg_catalog.jsonb)') as v_writer,
    pg_catalog.to_regprocedure('public.advance_intake_revision()') as v_guard
),
own2 as (
  select o.v_writer, o.v_guard,
         (select p.proowner from pg_catalog.pg_proc p where p.oid = o.v_writer) as v_owner,
         (select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role') as v_service
  from own o
)
select
  g.at_hosted_0246,
  coalesce(o.v_owner is not null and o.v_service is not null
    and exists (select 1 from pg_catalog.pg_proc p where p.oid = o.v_writer and p.prosecdef and p.proconfig = array['search_path=""']::text[])
    and exists (select 1 from pg_catalog.pg_proc p where p.oid = o.v_guard and not p.prosecdef and p.proowner = o.v_owner and p.proconfig = array['search_path=""']::text[]),
    false) as context_ok,
  coalesce((select count(*) from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')) = 4
    and not exists (select 1 from pg_catalog.pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
      and (r.oid = o.v_owner or pg_catalog.pg_has_role(r.oid, o.v_owner, 'MEMBER') or pg_catalog.pg_has_role(r.oid, o.v_owner, 'SET'))),
    false) as owner_not_assumable,
  coalesce(pg_catalog.has_function_privilege('service_role', o.v_writer, 'EXECUTE')
    and not pg_catalog.has_function_privilege('anon', o.v_writer, 'EXECUTE')
    and not pg_catalog.has_function_privilege('authenticated', o.v_writer, 'EXECUTE')
    and not exists (
      select 1 from pg_catalog.pg_proc p,
        lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      where p.oid = o.v_writer and a.privilege_type = 'EXECUTE'
        and (a.grantee not in (o.v_owner, o.v_service)
           or (a.grantee <> o.v_owner and a.is_grantable))),
    false) as writer_privileges_ok,
  coalesce(pg_catalog.has_table_privilege(o.v_owner, 'public.client_intake_forms', 'SELECT')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.client_intake_forms', 'UPDATE')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.clients', 'SELECT')
    and pg_catalog.has_table_privilege(o.v_owner, 'public.clients', 'UPDATE'),
    false) as owner_authority_ok,
  (
    select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.oid <> o.v_writer
      and p.prosrc ~* '(^|[^a-z0-9_])client_intake_forms([^a-z0-9_]|$)'
      and (
        p.oid = pg_catalog.to_regprocedure('public.receptionist_client_contacts(pg_catalog.uuid,pg_catalog.text,pg_catalog.int4)')
        and p.proowner = o.v_owner and p.provolatile = 's' and p.prokind = 'f'
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
  ) as unexpected_callable_definers
from chain_guard g, own2 o
