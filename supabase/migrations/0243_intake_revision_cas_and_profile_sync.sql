-- CLN-001 / CLN-003. OPS allocation 2026-10-21: source only, not apply authority.
-- Legacy revision 0 is a concurrency baseline, NOT a historical edit count.
-- Existing 0015/0118/0162 triggers and terminal review rules remain intact.
-- ADDITIVE ONLY: apply this schema before deploying CAS callers. Do NOT apply
-- later0248 enforcement until callers/rollback artifacts and drain are verified.
-- Old/direct writers still work here; no direct-write closure claim.
begin;
set local lock_timeout = '5s';

alter table public.client_intake_forms
  add column revision bigint not null default 0 check (revision >= 0);

create function public.advance_intake_revision()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 0;
  else
    -- Additive compatibility stage: legacy writes remain authorized by the
    -- existing RLS/terminal guards and invalidate any earlier CAS revision.
    -- This stage does NOT close blind direct-DML overwrites;0248 does that
    -- only after serving/rollback CAS callers and old-writer drain are verified.
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

-- Existing questionnaire/terminal guards run first, preserving their exact
-- refusals and review authorization. Revision advances only for an allowed row.
create trigger client_intake_forms_zz_advance_revision
  before insert or update on public.client_intake_forms
  for each row execute function public.advance_intake_revision();

revoke execute on function public.advance_intake_revision() from public, anon, authenticated, service_role;

-- Called ONLY by existing server actions after token or active-practitioner
-- authorization and canonical answers/consent/provenance validation. IDs and
-- profile contributions are resolved/derived by that server, not a browser.
-- Both public and assisted editors must name the revision they actually saw.
create function public.write_intake_revision(
  p_intake_id uuid,
  p_studio_id uuid,
  p_client_id uuid,
  p_expected_revision bigint,
  p_responses jsonb,
  p_step integer,
  p_operation text,
  p_profile jsonb default '{}'::pg_catalog.jsonb
)
returns table (outcome text, new_revision text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_intake public.client_intake_forms%rowtype;
  v_revision pg_catalog.text;
  v_profile_key pg_catalog.text;
begin
  if p_expected_revision is null or p_expected_revision < 0
     or p_step is null or p_step not between 1 and 5
     or p_operation is null or p_operation not in ('save', 'submit', 'handoff')
     or p_responses is null or jsonb_typeof(p_responses) <> 'object'
     or p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    return query select 'invalid_request'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;
  for v_profile_key in select jsonb_object_keys(p_profile) loop
    if v_profile_key not in (
      'emergency_contact_name', 'emergency_contact_phone', 'date_of_birth',
      'pronouns', 'address', 'allergy_text'
    ) or jsonb_typeof(p_profile -> v_profile_key) not in ('string', 'null') then
      return query select 'invalid_request'::pg_catalog.text, null::pg_catalog.text;
      return;
    end if;
  end loop;
  if (p_operation <> 'submit' and p_profile <> '{}'::pg_catalog.jsonb)
     or (p_operation in ('submit', 'handoff') and p_step <> 5) then
    return query select 'invalid_request'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;

  -- Always intake first, client second: the same lock order on every path.
  select f.* into v_intake from public.client_intake_forms f
    where f.id = p_intake_id and f.studio_id = p_studio_id
      and f.client_id = p_client_id and f.deleted_at is null
    for update;
  if not found then
    -- Wrong scope never discloses existence, answers or another revision.
    return query select 'not_available'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;
  if v_intake.status <> 'in_progress' then
    -- A repeat can acknowledge terminal state, NEVER that new answers saved.
    return query select 'terminal'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;
  if v_intake.revision <> p_expected_revision then
    return query select 'conflict'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;

  if p_operation = 'submit' then
    perform 1 from public.clients c
      where c.id = p_client_id and c.studio_id = p_studio_id for update;
    if not found then
      return query select 'not_available'::pg_catalog.text, null::pg_catalog.text;
      return;
    end if;
  end if;

  update public.client_intake_forms f
    set responses = p_responses, current_step = p_step,
        status = case when p_operation = 'submit' then 'submitted' else f.status end,
        submitted_at = case when p_operation = 'submit' then transaction_timestamp() else f.submitted_at end
    where f.id = p_intake_id and f.studio_id = p_studio_id
      and f.client_id = p_client_id and f.deleted_at is null
      and f.status = 'in_progress' and f.revision = p_expected_revision
    returning f.revision::pg_catalog.text into v_revision;
  if not found then
    return query select 'conflict'::pg_catalog.text, null::pg_catalog.text;
    return;
  end if;

  if p_operation = 'submit' then
    -- Merge from the CURRENT locked client, never an application snapshot.
    -- Any error rolls back the submission too. Only the new submit winner
    -- reaches this append; terminal repeats cannot duplicate it.
    update public.clients c set
      emergency_contact_name = case when nullif(btrim(c.emergency_contact_name), '') is null
        then nullif(btrim(p_profile ->> 'emergency_contact_name'), '') else c.emergency_contact_name end,
      emergency_contact_phone = case when nullif(btrim(c.emergency_contact_phone), '') is null
        then nullif(btrim(p_profile ->> 'emergency_contact_phone'), '') else c.emergency_contact_phone end,
      date_of_birth = coalesce(c.date_of_birth, nullif(p_profile ->> 'date_of_birth', '')::pg_catalog.date),
      pronouns = case when nullif(btrim(c.pronouns), '') is null
        then nullif(btrim(p_profile ->> 'pronouns'), '') else c.pronouns end,
      address = case when nullif(btrim(c.address), '') is null
        then nullif(btrim(p_profile ->> 'address'), '') else c.address end,
      allergies = case when nullif(btrim(p_profile ->> 'allergy_text'), '') is null then c.allergies
        when nullif(btrim(c.allergies), '') is null then p_profile ->> 'allergy_text'
        else c.allergies || E'\n\nFrom client intake (' || current_date::pg_catalog.text || E'):\n' || (p_profile ->> 'allergy_text') end
      where c.id = p_client_id and c.studio_id = p_studio_id;
    if not found then
      raise exception 'Intake profile update unavailable' using errcode = 'check_violation';
    end if;
  end if;

  return query select case when p_operation = 'submit' then 'submitted' else 'saved' end, v_revision;
end;
$$;

revoke execute on function public.write_intake_revision(uuid, uuid, uuid, bigint, jsonb, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.write_intake_revision(uuid, uuid, uuid, bigint, jsonb, integer, text, jsonb) to service_role;

-- Refuse an unsafe execution context instead of granting or assuming one.
-- Both functions were created by this migration's existing trusted executor;
-- runtime roles must not own or transitively assume that owner.
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
