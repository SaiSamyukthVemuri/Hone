-- Studio data export: the audit command's file map gains treatment_setup_readings.csv.
--
-- record_studio_export_audit_governed keeps a hard-coded map of archive files and returns false for any file not in it, so the export of the
-- machine-native readings (for example xCell Pur MultiPlex) cannot be recorded until the map names the file. This body is 0325's, byte for byte,
-- plus exactly ONE map entry: "treatment_setup_readings":"treatment_setup_readings.csv". SECURITY DEFINER, search_path '' and lock_timeout 5s
-- are unchanged. The grants are restated by name for all four roles and CHECKED: service_role only.
--
-- This is a new export file: the export's file map gains one entry, treatment_setup_readings.csv, so any older wording that no new export file is added does not describe this change.
--
-- GUARDS: a preamble refuses to run unless the function is exactly the 0325 body (md5 d92af63f4e985360cc8fed6143b79988); an after-check records the md5 of the new body
-- (946486bece2e1f8a1ace09936f3a000f) and refuses if the entry is missing or the grants differ.
-- ORDER: apply this BEFORE the application change that writes the file ships; an app that exports the file against the old map fails at the audit step.
-- Rollback: supabase/rollbacks/0385_export_treatment_setup_readings.down.sql (restores the 0325 body).

begin;

set local lock_timeout = '5s';

do $guard$
begin
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = pg_catalog.to_regprocedure('public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb)')
                    and pg_catalog.md5(p.prosrc) = 'd92af63f4e985360cc8fed6143b79988' and p.prosecdef
                    and p.proconfig @> array['search_path=""', 'lock_timeout=5s']
                    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')) then
    raise exception '0385 refuses to run: the export audit command is not the 0325 body';
  end if;
end
$guard$;

create or replace function public.record_studio_export_audit_governed(
  p_actor_id uuid, p_user_id uuid, p_studio_id uuid,
  p_filename text, p_files text[], p_row_counts jsonb
) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '5s'
as $$
declare
  -- Generated from the exact dd68 existing export registry; no new resource
  -- disposition or export. Future approved registry promotions need a matching
  -- reviewed command update, never a permissive arbitrary-metadata fallback.
  v_files constant pg_catalog.jsonb := $registry${"clients":"clients.csv","sessions":"sessions.csv","electrolysis_entries":"electrolysis_entries.csv","laser_entries":"laser_entries.csv","practitioners":"practitioners.csv","client_pricing":"client_pricing.csv","appointments":"appointments.csv","treatment_plans":"treatment_plans.csv","treatment_plan_stages":"treatment_plan_stages.csv","record_keeping_sterile_items":"record_keeping_sterile_items.csv","record_keeping_disinfectants":"record_keeping_disinfectants.csv","record_keeping_exposure_incidents":"record_keeping_exposure_incidents.csv","record_keeping_audit_events":"record_keeping_audit_events.csv","client_clinical_notes":"client_clinical_notes.csv","client_budget_context":"client_budget_context.csv","services":"services.csv","client_consent_signatures":"client_consent_signatures.csv","treatment_goals":"treatment_goals.csv","probe_lots":"probe_lots.csv","service_practitioners":"service_practitioners.csv","waitlist_decline_answers":"waitlist-decline-answers.csv","treatment_setup_readings":"treatment_setup_readings.csv"}$registry$::pg_catalog.jsonb;
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

revoke all on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) from public, anon, authenticated, service_role;
grant execute on function public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb) to service_role;

do $after$
begin
  if not exists (select 1 from pg_catalog.pg_proc p
                  where p.oid = pg_catalog.to_regprocedure('public.record_studio_export_audit_governed(uuid,uuid,uuid,text,text[],jsonb)')
                    and pg_catalog.md5(p.prosrc) = '946486bece2e1f8a1ace09936f3a000f' and p.prosecdef
                    and p.proconfig @> array['search_path=""', 'lock_timeout=5s']
                    and position('"treatment_setup_readings":"treatment_setup_readings.csv"' in p.prosrc) > 0
                    and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    and not pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')) then
    raise exception '0385: the export audit command is not the 0325 body plus the treatment_setup_readings entry, service_role only';
  end if;
end
$after$;

commit;
