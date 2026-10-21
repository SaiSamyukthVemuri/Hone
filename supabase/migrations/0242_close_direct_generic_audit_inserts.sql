-- SEC-003. OPS source allocation only: no apply/release authority.
-- Atomic-command prerequisite: coordinated write hold/drain is required while
-- deploying these commands + matching app. Missing RPC must fail closed.
-- Earlier app-first preparation alone did not authorize atomic audit emission.
-- Historical generic rows remain unverified; none are rewritten or removed.
begin;
set local lock_timeout = '5s';

-- This is the permissive member INSERT policy in both0001 and pending0233.
-- Existing SELECT policies and the actor-bound clinical command stay intact.
drop policy if exists "audit_logs: members insert" on public.audit_logs;

-- ACL denial is independent of any other permissive RLS policy. PUBLIC must
-- be included, and column-level INSERT grants must not provide a back door.
revoke insert on table public.audit_logs from public, anon, authenticated;
do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = 'public.audit_logs'::regclass
        and a.attnum > 0 and not a.attisdropped
  loop
    execute format('revoke insert (%I) on table public.audit_logs from public, anon, authenticated', v_column);
  end loop;

  if has_table_privilege('anon', 'public.audit_logs', 'INSERT')
     or has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
     or has_any_column_privilege('anon', 'public.audit_logs', 'INSERT')
     or has_any_column_privilege('authenticated', 'public.audit_logs', 'INSERT') then
    raise exception 'Direct generic audit inserts remain permitted';
  end if;
  -- Preserve existing trusted authority; do NOT manufacture a new grant if
  -- this environment does not have the expected service writer privilege.
  if not has_table_privilege('service_role', 'public.audit_logs', 'INSERT') then
    raise exception 'Existing trusted audit writer privilege is unavailable';
  end if;
end;
$$;


-- Two narrow service EXECUTE capabilities require
-- explicit source/ACL review. Existing trusted function-owner authority is
-- checked below;0178 keeps runtime practitioners SELECT-only. No UPDATE grant
-- is manufactured for row locks. User roles get no command/table permission.
-- The verified-user argument comes ONLY from the internal session adapter;
-- service credentials are trusted server authority, not proof of user identity.
create function public.record_client_archive_audit_governed(
  p_actor_id uuid, p_user_id uuid, p_studio_id uuid, p_client_id uuid,
  p_archived boolean, p_archived_at text
) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '5s'
as $$
declare
  v_actor pg_catalog.uuid;
  v_client pg_catalog.uuid;
  v_time pg_catalog.timestamptz;
begin
  if p_actor_id is null or p_user_id is null or p_studio_id is null
     or p_client_id is null or p_archived is null then return false; end if;
  if p_archived then
    if p_archived_at is null then return false; end if;
    begin
      v_time := p_archived_at::pg_catalog.timestamptz;
      if pg_catalog.to_char(v_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         is distinct from p_archived_at then return false; end if;
    exception when invalid_datetime_format or datetime_field_overflow then
      return false;
    end;
  elsif p_archived_at is not null then return false;
  end if;

  -- This exact existing membership is held until audit INSERT commits. A
  -- concurrent non-key active/role/user/studio change cannot slip between them.
  select p.id into v_actor from public.practitioners p
    where p.id=p_actor_id and p.user_id=p_user_id
      and p.studio_id=p_studio_id and p.active is true
    for update;
  if not found then return false; end if;
  -- Same-client/studio entity lock, never a browser-supplied actor/metadata row.
  select c.id into v_client from public.clients c
    where c.id=p_client_id and c.studio_id=p_studio_id for update;
  if not found then return false; end if;

  insert into public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
    values (p_studio_id,v_actor,
      case when p_archived then 'client_archived' else 'client_unarchived' end,
      'client',v_client,
      case when p_archived then pg_catalog.jsonb_build_object('archived_at',p_archived_at)
        else '{}'::pg_catalog.jsonb end);
  return true;
end;
$$;

create function public.record_studio_export_audit_governed(
  p_actor_id uuid, p_user_id uuid, p_studio_id uuid,
  p_filename text, p_files text[], p_row_counts jsonb
) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '5s'
as $$
declare
  -- Generated from the exact dd68 existing export registry; no new resource
  -- disposition or export. Future approved registry promotions need a matching
  -- reviewed command update, never a permissive arbitrary-metadata fallback.
  v_files constant pg_catalog.jsonb := $registry${"clients":"clients.csv","sessions":"sessions.csv","electrolysis_entries":"electrolysis_entries.csv","laser_entries":"laser_entries.csv","practitioners":"practitioners.csv","client_pricing":"client_pricing.csv","appointments":"appointments.csv","treatment_plans":"treatment_plans.csv","treatment_plan_stages":"treatment_plan_stages.csv","record_keeping_sterile_items":"record_keeping_sterile_items.csv","record_keeping_disinfectants":"record_keeping_disinfectants.csv","record_keeping_exposure_incidents":"record_keeping_exposure_incidents.csv","record_keeping_audit_events":"record_keeping_audit_events.csv","client_clinical_notes":"client_clinical_notes.csv","client_budget_context":"client_budget_context.csv","services":"services.csv","client_consent_signatures":"client_consent_signatures.csv","treatment_goals":"treatment_goals.csv","probe_lots":"probe_lots.csv","service_practitioners":"service_practitioners.csv"}$registry$::pg_catalog.jsonb;
  v_actor pg_catalog.uuid;
  v_studio_name pg_catalog.text;
  v_slug pg_catalog.text;
  v_file pg_catalog.text;
  v_resource pg_catalog.text;
  v_count pg_catalog.jsonb;
  v_selected pg_catalog.text[] := array[]::pg_catalog.text[];
  v_seen pg_catalog.text[] := array[]::pg_catalog.text[];
begin
  if p_actor_id is null or p_user_id is null or p_studio_id is null
     or p_filename is null or p_files is null
     or pg_catalog.array_ndims(p_files) is distinct from 1
     or pg_catalog.cardinality(p_files) not between 2 and 100
     or pg_catalog.jsonb_typeof(p_row_counts) is distinct from 'object' then return false; end if;
  if not ('manifest.json'=any(p_files)) or not ('README.txt'=any(p_files)) then return false; end if;
  foreach v_file in array p_files loop
    if v_file is null or v_file=any(v_seen) then return false; end if;
    v_seen := pg_catalog.array_append(v_seen,v_file);
    if v_file not in ('manifest.json','README.txt') then
      select e.key into v_resource from pg_catalog.jsonb_each_text(v_files) e
        where e.value=v_file;
      if not found then return false; end if;
      v_selected := pg_catalog.array_append(v_selected,v_resource);
    end if;
  end loop;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_row_counts))
       <> pg_catalog.cardinality(v_selected) then return false; end if;
  for v_resource,v_count in select e.key,e.value from pg_catalog.jsonb_each(p_row_counts) e loop
    if not (v_resource=any(v_selected)) or pg_catalog.jsonb_typeof(v_count)<>'number'
       or v_count::pg_catalog.text !~ '^[0-9]{1,16}$' then return false; end if;
    if (v_count::pg_catalog.text)::pg_catalog.numeric>9007199254740991 then return false; end if;
  end loop;

  -- Bound this check and the INSERT in one transaction, not two app queries.
  -- Owner demotion/deactivation must serialize here, even after all ZIP reads.
  select p.id into v_actor from public.practitioners p
    where p.id=p_actor_id and p.user_id=p_user_id and p.studio_id=p_studio_id
      and p.active is true and p.role='owner' for update;
  if not found then return false; end if;
  select s.name into v_studio_name from public.studios s where s.id=p_studio_id;
  if not found then return false; end if;
  v_slug := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(v_studio_name),'[^a-z0-9]+','-','g'),'-');
  if v_slug='' then v_slug:='studio'; end if;
  if pg_catalog.left(p_filename,pg_catalog.length('hone-export-'||v_slug||'-'))
       is distinct from 'hone-export-'||v_slug||'-'
     or pg_catalog.substr(p_filename,pg_catalog.length('hone-export-'||v_slug||'-')+1)
       !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.zip$' then return false; end if;
  insert into public.audit_logs(studio_id,actor_id,action,entity_type,entity_id,metadata)
    values (p_studio_id,v_actor,'studio_export','studio',p_studio_id,
      pg_catalog.jsonb_build_object('filename',p_filename,'files',pg_catalog.to_jsonb(p_files),'row_counts',p_row_counts));
  return true;
end;
$$;

-- New narrow command execution is an EXPLICIT capability, not an inherited
-- default grant, new end-user permission, new role or broad table grant.
revoke all on function public.record_client_archive_audit_governed(uuid,uuid,uuid,uuid,boolean,text)
  from public,anon,authenticated,service_role;
revoke all on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.record_client_archive_audit_governed(uuid,uuid,uuid,uuid,boolean,text) to service_role;
grant execute on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) to service_role;

-- SECURITY DEFINER is deliberately narrow here:0178 forbids runtime UPDATE
-- on practitioner identity, including the privilege required by FOR UPDATE.
-- Refuse a wrong/missing/assumable owner or changed execution context; never
-- remediate it with runtime table/role grants or arbitrary audit authority.
do $$
declare
  v_signature pg_catalog.text;
  v_function pg_catalog.oid;
  v_owner pg_catalog.oid;
  v_expected_owner pg_catalog.oid;
  v_service pg_catalog.oid;
  v_role record;
  v_required record;
  v_runtime_count pg_catalog.int4;
begin
  select r.oid into v_service from pg_catalog.pg_roles r where r.rolname='service_role';
  if v_service is null then
    raise exception 'Existing governed audit service role unavailable';
  end if;
  foreach v_signature in array array[
    'public.record_client_archive_audit_governed(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.bool,pg_catalog.text)',
    'public.record_studio_export_audit_governed(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text[],pg_catalog.jsonb)'
  ] loop
    v_function := pg_catalog.to_regprocedure(v_signature);
    select p.proowner into v_owner from pg_catalog.pg_proc p where p.oid=v_function;
    -- Context must be checked independently of ACL expansion (including an
    -- empty ACL). Both exact commands retain the same trusted existing owner.
    if v_function is null or v_owner is null or not exists (
      select 1 from pg_catalog.pg_proc p where p.oid=v_function
        and p.prosecdef and p.prokind='f'
        and p.prolang=(select l.oid from pg_catalog.pg_language l where l.lanname='plpgsql')
        and p.proconfig=array['search_path=""','lock_timeout=5s']::pg_catalog.text[]
    ) then
      raise exception 'Unsafe governed audit command execution context';
    end if;
    if v_expected_owner is null then v_expected_owner:=v_owner;
    elsif v_owner<>v_expected_owner then
      raise exception 'Governed audit command owners differ';
    end if;
    v_runtime_count:=0;
    for v_role in select r.oid,r.rolname from pg_catalog.pg_roles r
      where r.rolname in ('anon','authenticated','service_role','authenticator')
    loop
      v_runtime_count:=v_runtime_count+1;
      if v_role.oid=v_owner
         or pg_catalog.pg_has_role(v_role.oid,v_owner,'MEMBER')
         or pg_catalog.pg_has_role(v_role.oid,v_owner,'SET') then
        raise exception 'Governed audit owner is assumable by a runtime role';
      end if;
    end loop;
    if v_runtime_count<>4 then
      raise exception 'Governed audit runtime role context unavailable';
    end if;
    if pg_catalog.has_function_privilege('anon',v_function,'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated',v_function,'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role',v_function,'EXECUTE')
       or exists (
         select 1 from pg_catalog.pg_proc p,
           lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
         where p.oid=v_function and a.privilege_type='EXECUTE' and
           (a.grantee not in (v_owner,v_service)
            or (a.grantee<>v_owner and a.is_grantable))
       ) then
      raise exception 'Unsafe governed audit command execution privileges';
    end if;
  end loop;
  -- Existing owner privileges permit the precise row locks and fixed INSERT;
  -- service_role never gains practitioner identity mutation authority.
  for v_required in select * from (values
    ('public.practitioners','SELECT'),('public.practitioners','UPDATE'),
    ('public.clients','SELECT'),('public.clients','UPDATE'),
    ('public.studios','SELECT'),('public.audit_logs','INSERT')
  ) as required(table_name,privilege_name)
  loop
    if not pg_catalog.has_table_privilege(v_expected_owner,v_required.table_name,v_required.privilege_name) then
      raise exception 'Existing governed audit owner authority unavailable: % %',v_required.table_name,v_required.privilege_name;
    end if;
  end loop;
  if pg_catalog.has_table_privilege('service_role','public.practitioners','UPDATE')
     or pg_catalog.has_any_column_privilege('service_role','public.practitioners','UPDATE') then
    raise exception 'Runtime practitioner identity boundary unexpectedly widened';
  end if;
end;
$$;

commit;
