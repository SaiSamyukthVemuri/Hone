-- 0244 / CLN-007: routine reading corrections, not retired signed records.
-- Additive AFTER UPDATE history only. No backfill, export or retention-policy
-- activation. Parent erasure requires separately authorized history disposition;
-- RESTRICT prevents accidental destruction, not an indefinite retention claim.
begin;
set local lock_timeout = '5s';

create table public.treatment_reading_change_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete restrict,
  session_id uuid not null,
  client_id uuid not null,
  source_table text not null check (source_table in ('session_blocks','electrolysis_entries','laser_entries')),
  source_id uuid not null,
  block_id uuid,
  actor_practitioner_id uuid not null,
  actor_user_id uuid not null,
  actor_display_name text not null,
  changed_fields text[] not null check (cardinality(changed_fields) > 0),
  changes jsonb not null check (jsonb_typeof(changes) = 'object'),
  occurred_at timestamptz not null default statement_timestamp(),
  foreign key (studio_id,session_id) references public.sessions(studio_id,id) on delete restrict,
  foreign key (client_id,studio_id) references public.clients(id,studio_id) on delete restrict
);
-- Source/actor identities are stable snapshots, never SET NULL/CASCADE.
create index treatment_reading_change_events_session_idx
  on public.treatment_reading_change_events(studio_id,session_id,occurred_at,id);
alter table public.treatment_reading_change_events enable row level security;
revoke all on public.treatment_reading_change_events from public, anon, authenticated, service_role;
grant select on public.treatment_reading_change_events to authenticated;
create policy treatment_reading_change_events_clinical_select
  on public.treatment_reading_change_events for select to authenticated
  using (exists (
    select 1 from public.sessions s
    join public.clients c on c.id=s.client_id and c.studio_id=s.studio_id
    join public.practitioners p on p.studio_id=s.studio_id and p.user_id=auth.uid() and p.active
    where s.id=treatment_reading_change_events.session_id
      and s.studio_id=treatment_reading_change_events.studio_id
      and c.id=treatment_reading_change_events.client_id
  ));

create or replace function public.capture_treatment_reading_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_fields text[];
  v_numeric constant text[] := array['intensity','duration_seconds','pulse_count','pulse_delay_seconds','energy_level','minutes_performed','hairs_treated','galvanic_ma','galvanic_duration_seconds','galvanic_intensity_percent','thermolysis_intensity_percent','thermolysis_duration_seconds','units_of_lye','session_number'];
  v_key text;
  v_path text[];
  v_before jsonb;
  v_after jsonb;
  v_value jsonb;
  v_changed text[] := '{}';
  v_changes jsonb := '{}';
  v_session uuid;
  v_studio uuid;
  v_client uuid;
  v_actor uuid;
  v_name text;
begin
  if tg_op <> 'UPDATE' or tg_table_schema <> 'public' then
    raise exception 'Unsupported reading history source.' using errcode='23514';
  end if;
  case tg_table_name
    when 'session_blocks' then v_fields := array['mode','apilus_modality','energy_level','minutes_performed','machine_frequency','probe_type','probe_size','probe_key','probe_brand','probe_material','probe_piece_type','probe_shank','probe_size_value','probe_length','probe_label','probe_lot_number','probe_lot_confirmed','probe_inventory_item_id'];
    when 'electrolysis_entries' then v_fields := array['mode','intensity','duration_seconds','pulse_count','pulse_delay_seconds','apilus_modality','energy_level','minutes_performed','probe_type','probe_size','probe_lot_id','machine_frequency','hairs_treated','galvanic_ma','galvanic_duration_seconds','galvanic_intensity_percent','thermolysis_intensity_percent','thermolysis_duration_seconds','units_of_lye'];
    when 'laser_entries' then v_fields := array['session_number','equipment_params.fluence','equipment_params.pulse_width','equipment_params.spot_size'];
    else raise exception 'Unsupported reading history source.' using errcode='23514';
  end case;
  -- Compare supported leaves only, including JSON absent versus explicit null.
  for v_key in select unnest(v_fields) order by 1 loop
    v_path := string_to_array(v_key,'.');
    v_before := v_old #> v_path;
    v_after := v_new #> v_path;
    if v_before is not distinct from v_after then continue; end if;
    foreach v_value in array array[v_before,v_after] loop
      if v_value is null or v_value = 'null'::jsonb then continue; end if;
      -- PostgreSQL serializes numeric NaN/Infinity as JSON strings. These
      -- exact sentinels from actual typed numeric columns must remain
      -- auditable when correcting legacy data; this is no new reading bound
      -- or admission path. Arbitrary strings/objects still cannot pass.
      if (v_key = any(v_numeric) and jsonb_typeof(v_value) <> 'number'
          and not (jsonb_typeof(v_value) = 'string'
                   and v_value #>> '{}' in ('NaN','Infinity','-Infinity')))
         or (v_key = 'probe_lot_confirmed' and jsonb_typeof(v_value) <> 'boolean')
         or (v_key <> all(v_numeric) and v_key <> 'probe_lot_confirmed' and jsonb_typeof(v_value) <> 'string') then
        raise exception 'Unsupported routine reading value.' using errcode='23514';
      end if;
    end loop;
    v_changed := array_append(v_changed,v_key);
    v_changes := v_changes || jsonb_build_object(v_key,jsonb_build_object(
      'old',jsonb_build_object('present',v_before is not null,'value',v_before),
      'new',jsonb_build_object('present',v_after is not null,'value',v_after)));
  end loop;
  if cardinality(v_changed) = 0 then return new; end if;
  -- Actual immutable lineage, never caller metadata. Fail the whole update if
  -- the parent or active attributed actor cannot be established.
  if (v_old->>'id') is distinct from (v_new->>'id')
     or (v_old->>'session_id') is distinct from (v_new->>'session_id') then
    raise exception 'Reading history lineage cannot change.' using errcode='23514';
  end if;
  v_session := (v_new->>'session_id')::uuid;
  select s.studio_id,s.client_id into v_studio,v_client
    from public.sessions s where s.id=v_session;
  if v_studio is null or (tg_table_name='session_blocks' and
      ((v_new->>'studio_id')::uuid is distinct from v_studio or v_old->>'studio_id' is distinct from v_new->>'studio_id')) then
    raise exception 'Reading history parent cannot be established.' using errcode='23514';
  end if;
  v_actor := public.session_actor_practitioner(v_studio);
  select coalesce(nullif(btrim(p.display_name),''),'Practitioner') into v_name
    from public.practitioners p where p.id=v_actor and p.studio_id=v_studio and p.user_id=auth.uid() and p.active;
  if v_name is null then raise exception 'An active practitioner is required.' using errcode='23514'; end if;
  insert into public.treatment_reading_change_events
    (studio_id,session_id,client_id,source_table,source_id,block_id,
     actor_practitioner_id,actor_user_id,actor_display_name,changed_fields,changes)
  values (v_studio,v_session,v_client,tg_table_name,(v_new->>'id')::uuid,
    case when tg_table_name='session_blocks' then (v_new->>'id')::uuid else coalesce((v_new->>'block_id')::uuid,(v_old->>'block_id')::uuid) end,
    v_actor,auth.uid(),v_name,v_changed,v_changes);
  return new;
end;
$$;
revoke execute on function public.capture_treatment_reading_change() from public;
revoke execute on function public.capture_treatment_reading_change() from anon;
revoke execute on function public.capture_treatment_reading_change() from authenticated;
revoke execute on function public.capture_treatment_reading_change() from service_role;
create trigger session_blocks_reading_history after update on public.session_blocks
  for each row execute function public.capture_treatment_reading_change();
create trigger electrolysis_entries_reading_history after update on public.electrolysis_entries
  for each row execute function public.capture_treatment_reading_change();
create trigger laser_entries_reading_history after update on public.laser_entries
  for each row execute function public.capture_treatment_reading_change();

create or replace function public.guard_treatment_reading_history_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Reading change history is immutable.' using errcode='55000';
end;
$$;
revoke execute on function public.guard_treatment_reading_history_immutable() from public;
revoke execute on function public.guard_treatment_reading_history_immutable() from anon;
revoke execute on function public.guard_treatment_reading_history_immutable() from authenticated;
revoke execute on function public.guard_treatment_reading_history_immutable() from service_role;
create trigger treatment_reading_history_append_only before update or delete
  on public.treatment_reading_change_events for each row
  execute function public.guard_treatment_reading_history_immutable();
create trigger treatment_reading_history_no_truncate before truncate
  on public.treatment_reading_change_events for each statement
  execute function public.guard_treatment_reading_history_immutable();
comment on table public.treatment_reading_change_events is
  '0244: attributable routine reading diffs, clinical data. No narrative/private payload or backfill. PENDING export field review, NOT EXPORTED. No retention duration or erasure exception established; parent erasure requires separately authorized explicit history disposition.';
commit;
