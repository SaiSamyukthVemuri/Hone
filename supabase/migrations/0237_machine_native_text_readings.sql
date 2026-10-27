-- OPS allocation 0237: additive native text/choice readings. No model publication,
-- activation or historical observation rewrites. Frozen 0223/0235/0236 untouched.
begin;
set local lock_timeout = '5s';

alter table public.machine_profile_field_contract
  add column value_kind text not null default 'number'
    check (value_kind in ('number', 'text', 'choice')),
  add column choices jsonb not null default '[]'::jsonb;
alter table public.machine_profile_field_contract
  add constraint machine_field_text_metadata check (
    jsonb_typeof(choices) = 'array'
    and ((value_kind = 'choice' and jsonb_array_length(choices) > 0)
      or (value_kind <> 'choice' and choices = '[]'::jsonb))
    and (value_kind = 'number' or (native_unit = 'none' and decimals = 0))
  );
alter table public.treatment_setup_readings add column value_text text;
alter table public.treatment_setup_readings
  drop constraint treatment_setup_readings_value_xor,
  add constraint treatment_setup_readings_value_xor check (
    num_nonnulls(value_numeric, value_text, absence_reason) = 1
  ),
  add constraint treatment_setup_readings_text_shape check (
    value_text is null or (length(value_text) between 1 and 500
      and value_text !~ '^[[:space:]]*$' and native_unit = 'none' and decimals = 0)
  );
-- Existing ACLs, RLS, capture identity FKs, append-only triggers and 0235 finite
-- constraint remain in force. Governed writer derives the type from the contract.

alter table public.machine_profile_field_contract
  drop constraint machine_profile_field_contract_quantity_check,
  add constraint machine_profile_field_contract_quantity_check check (quantity in (
    'current','duration','intensity','frequency','count','percentage',
    'energy-display','preset-identifier','configuration'
  ));

create or replace function public.sync_machine_profile_contract(
  p_machine_profile_id text,
  p_machine_profile_version integer,
  p_mode_key text,
  p_channels_max smallint,
  p_requires_installed_option text,
  p_fields jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_profile text := btrim(coalesce(p_machine_profile_id, ''));
  v_mode text := btrim(coalesce(p_mode_key, ''));
  v_option text := nullif(btrim(coalesce(p_requires_installed_option, '')), '');
  v_item jsonb;
  v_count integer := 0;
  v_existing_mode record;
  v_incoming_count integer;
  v_incoming_distinct integer;
  v_diff integer;
begin
  if v_profile = '' then
    raise exception 'A profile id is required.' using errcode = 'check_violation';
  end if;
  if p_machine_profile_version is null or p_machine_profile_version < 1 then
    raise exception 'A profile version is required.'
      using errcode = 'check_violation';
  end if;
  if v_mode = '' then
    raise exception 'A mode key is required.' using errcode = 'check_violation';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'array'
     or jsonb_array_length(p_fields) = 0 then
    raise exception 'Fields must be a non-empty JSON array.'
      using errcode = 'check_violation';
  end if;
  select count(*),
         count(distinct (btrim(coalesce(f->>'stage_key', '')),
                         btrim(coalesce(f->>'field_key', ''))))
    into v_incoming_count, v_incoming_distinct
    from jsonb_array_elements(p_fields) as f;
  if v_incoming_count <> v_incoming_distinct then
    raise exception
      'The same field is listed more than once in this contract.'
      using errcode = 'check_violation';
  end if;
  select * into v_existing_mode
    from public.machine_profile_mode_contract c
   where c.machine_profile_id = v_profile
     and c.machine_profile_version = p_machine_profile_version
     and c.mode_key = v_mode;
  if found then
    if coalesce(v_existing_mode.channels_max, -1) <> coalesce(p_channels_max, -1)
       or coalesce(v_existing_mode.requires_installed_option, '')
          <> coalesce(v_option, '') then
      raise exception
        'This machine profile version and mode is already published with different mode facts. Publish a NEW version instead of changing a published one.'
        using errcode = 'restrict_violation';
    end if;
    select count(*) into v_diff
      from (
        (select btrim(coalesce(f->>'stage_key', '')) as stage_key,
                btrim(coalesce(f->>'field_key', '')) as field_key,
                btrim(coalesce(f->>'native_unit', '')) as native_unit,
                (f->>'decimals')::smallint as decimals,
                btrim(coalesce(f->>'quantity', '')) as quantity,
                coalesce((f->>'optional')::boolean, false) as optional,
                coalesce(f->>'value_kind', 'number') as value_kind, coalesce(f->'choices', '[]'::jsonb) as choices
           from jsonb_array_elements(p_fields) as f)
        except
        (select c.stage_key, c.field_key, c.native_unit, c.decimals,
                c.quantity, c.optional, c.value_kind, c.choices
           from public.machine_profile_field_contract c
          where c.machine_profile_id = v_profile
            and c.machine_profile_version = p_machine_profile_version
            and c.mode_key = v_mode)
      ) only_incoming;
    select v_diff + count(*) into v_diff
      from (
        (select c.stage_key, c.field_key, c.native_unit, c.decimals,
                c.quantity, c.optional, c.value_kind, c.choices
           from public.machine_profile_field_contract c
          where c.machine_profile_id = v_profile
            and c.machine_profile_version = p_machine_profile_version
            and c.mode_key = v_mode)
        except
        (select btrim(coalesce(f->>'stage_key', '')) as stage_key,
                btrim(coalesce(f->>'field_key', '')) as field_key,
                btrim(coalesce(f->>'native_unit', '')) as native_unit,
                (f->>'decimals')::smallint as decimals,
                btrim(coalesce(f->>'quantity', '')) as quantity,
                coalesce((f->>'optional')::boolean, false) as optional,
                coalesce(f->>'value_kind', 'number') as value_kind, coalesce(f->'choices', '[]'::jsonb) as choices
           from jsonb_array_elements(p_fields) as f)
      ) only_published;
    if v_diff <> 0 then
      raise exception
        'This machine profile version and mode is already published with different fields. Publish a NEW version instead of changing a published one.'
        using errcode = 'restrict_violation';
    end if;
    return 0;  -- idempotent no-op
  end if;
  insert into public.machine_profile_mode_contract (
    machine_profile_id, machine_profile_version, mode_key,
    channels_max, requires_installed_option
  )
  values (v_profile, p_machine_profile_version, v_mode, p_channels_max, v_option);
  for v_item in select jsonb_array_elements(p_fields)
  loop
    if jsonb_typeof(coalesce(v_item->'choices', '[]'::jsonb)) <> 'array' then
      raise exception 'Choices must be an array.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(v_item->'choices', '[]'::jsonb)) ch
       where jsonb_typeof(ch) <> 'string' or (ch #>> '{}') ~ '^[[:space:]]*$'
          or length(ch #>> '{}') > 500) or
       (select count(*) <> count(distinct ch) from jsonb_array_elements(coalesce(v_item->'choices', '[]'::jsonb)) ch) then
      raise exception 'Choices must be distinct nonblank strings.' using errcode = 'check_violation';
    end if;
    insert into public.machine_profile_field_contract (
      machine_profile_id, machine_profile_version, mode_key,
      stage_key, field_key, native_unit, decimals, quantity, optional, value_kind, choices
    )
    values (
      v_profile,
      p_machine_profile_version,
      v_mode,
      btrim(coalesce(v_item->>'stage_key', '')),
      btrim(v_item->>'field_key'),
      btrim(v_item->>'native_unit'),
      (v_item->>'decimals')::smallint,
      btrim(v_item->>'quantity'),
      coalesce((v_item->>'optional')::boolean, false),
      coalesce(v_item->>'value_kind', 'number'), coalesce(v_item->'choices', '[]'::jsonb)
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.record_setup_group_in_scope(
  p_block_id uuid,
  p_studio_machine_id uuid,
  p_studio uuid,
  p_practitioner uuid,
  p_profile_id text,
  p_profile_version integer,
  p_installed_options text[],
  p_mode_key text,
  p_group_key text,
  p_channels smallint[],
  p_readings jsonb,
  p_submission_id uuid,
  p_participating_groups text[],
  p_group_is_new boolean
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_count integer := 0;
  v_conflict_group text;
  v_conflict_channel smallint;
  v_item jsonb;
  v_stage text;
  v_field text;
  v_unit text;
  v_decimals smallint;
  v_quantity text;
  v_value numeric;
  v_text text;
  v_kind text;
  v_choices jsonb;
  v_absence text;
  v_source text;
  v_channels_max smallint;
  v_requires_option text;
  v_capture uuid;
  v_revision smallint;
  v_group text;
  v_mode text;
  v_channel smallint;
  v_group_exists boolean;
begin
  if p_readings is null or jsonb_typeof(p_readings) <> 'array'
     or jsonb_array_length(p_readings) = 0 then
    raise exception 'At least one reading is required.'
      using errcode = 'check_violation';
  end if;
  v_group := btrim(coalesce(p_group_key, ''));
  v_mode := btrim(coalesce(p_mode_key, ''));
  if v_group = '' or v_mode = '' then
    raise exception 'A mode and a settings group are required.'
      using errcode = 'check_violation';
  end if;
  select c.channels_max, c.requires_installed_option
    into v_channels_max, v_requires_option
    from public.machine_profile_mode_contract c
   where c.machine_profile_id = p_profile_id
     and c.machine_profile_version = p_profile_version
     and c.mode_key = v_mode;
  if not found then
    raise exception
      'No field contract is published for this machine profile version and mode, so its settings cannot be recorded.'
      using errcode = 'check_violation';
  end if;
  if v_requires_option is not null
     and not (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) then
    raise exception
      'This machine does not have the % option fitted, so its % mode cannot be recorded.',
      v_requires_option, v_mode
      using errcode = 'check_violation';
  end if;
  if coalesce(array_length(p_channels, 1), 0) > 0 then
    if v_channels_max is null then
      raise exception
        'This machine profile does not offer per-channel settings, so a channel cannot be named.'
        using errcode = 'check_violation';
    end if;
    foreach v_channel in array p_channels
    loop
      if v_channel is null or v_channel < 1 or v_channel > v_channels_max then
        raise exception
          'Channel % is not a channel of this machine (it has %).',
          v_channel, v_channels_max
          using errcode = 'check_violation';
      end if;
    end loop;
    if (select count(distinct ch) from unnest(p_channels) ch)
       <> array_length(p_channels, 1) then
      raise exception 'A channel is named more than once.'
        using errcode = 'check_violation';
    end if;
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      row(
        p_block_id,
        p_studio_machine_id,
        p_profile_id,
        p_profile_version,
        v_mode
      )::text,
      0
    )
  );
  select k.group_key,
         (select min(ch) from unnest(p_channels) ch where ch = any (k.channels))
    into v_conflict_group, v_conflict_channel
    from (
      select distinct on (c.group_key) c.group_key, c.channels
        from public.treatment_setup_captures c
       where c.session_block_id = p_block_id
         and c.studio_machine_id = p_studio_machine_id
         and c.machine_profile_id = p_profile_id
         and c.machine_profile_version = p_profile_version
         and c.mode_key = v_mode
         and not (btrim(c.group_key) = any (
           select btrim(g)
             from unnest(coalesce(p_participating_groups, '{}'::text[])) g
         ))
       order by c.group_key, c.revision desc
    ) k
   where k.channels && p_channels
   limit 1;
  if v_conflict_group is not null then
    raise exception
      'Channel % is still assigned to settings group "%" on this treatment. Record the change for that group too, or move it off the channel first - a probe can only be on one setting at a time.',
      v_conflict_channel, v_conflict_group
      using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(p_block_id::text || ':' || v_group, 0)
  );
  select exists (
    select 1
      from public.treatment_setup_captures c
     where c.session_block_id = p_block_id
       and btrim(c.group_key) = v_group
  ) into v_group_exists;
  if p_group_is_new and v_group_exists then
    raise exception
      'Issued settings group "%" already exists on this treatment.', v_group
      using errcode = 'internal_error';
  end if;
  if not p_group_is_new and not v_group_exists then
    raise exception
      'Settings group "%" is not on this treatment, so it cannot be revised. Add it as a new group instead.',
      v_group
      using errcode = 'check_violation';
  end if;
  select coalesce(max(c.revision), 0) + 1
    into v_revision
    from public.treatment_setup_captures c
   where c.session_block_id = p_block_id
     and c.group_key = v_group
     and c.studio_machine_id = p_studio_machine_id
     and c.machine_profile_id = p_profile_id
     and c.machine_profile_version = p_profile_version
     and c.mode_key = v_mode;
  insert into public.treatment_setup_captures (
    studio_id, session_block_id, studio_machine_id,
    machine_profile_id, machine_profile_version, mode_key,
    group_key, channels, revision, recorded_by_practitioner_id,
    setup_submission_id
  )
  values (
    p_studio, p_block_id, p_studio_machine_id,
    p_profile_id, p_profile_version, v_mode,
    v_group, coalesce(p_channels, '{}'), v_revision, p_practitioner,
    p_submission_id
  )
  returning id into v_capture;
  for v_item in select jsonb_array_elements(p_readings)
  loop
    v_stage := btrim(coalesce(v_item->>'stage_key', ''));
    v_field := btrim(coalesce(v_item->>'field_key', ''));
    select c.native_unit, c.decimals, c.quantity, c.value_kind, c.choices
      into v_unit, v_decimals, v_quantity, v_kind, v_choices
      from public.machine_profile_field_contract c
     where c.machine_profile_id = p_profile_id
       and c.machine_profile_version = p_profile_version
       and c.mode_key = v_mode
       and c.stage_key = v_stage
       and c.field_key = v_field;
    if v_unit is null then
      raise exception
        'This machine profile has no field "%" in mode "%"%, so it cannot be recorded.',
        v_field,
        v_mode,
        case when v_stage = '' then '' else format(' stage "%s"', v_stage) end
        using errcode = 'check_violation';
    end if;
    v_source := btrim(coalesce(v_item->>'observation_source', ''));
    if v_source not in ('practitioner-entered', 'machine-displayed',
                        'device-computed', 'estimated') then
      raise exception '"%" is not a recognised way of observing a reading.',
        v_source
        using errcode = 'check_violation';
    end if;
    v_absence := nullif(btrim(coalesce(v_item->>'absence_reason', '')), '');
    if v_item->>'value_text' is not null and jsonb_typeof(v_item->'value_text') <> 'string' then
      raise exception 'Text observations must be strings.' using errcode = 'check_violation';
    end if;
    v_text := v_item->>'value_text'; -- preserve exact spelling, never btrim/coerce
    v_value := case when v_item->>'value' is null then null
                    else (v_item->>'value')::numeric end;
    if num_nonnulls(v_value, v_text, v_absence) <> 1 then
      raise exception 'Field "%" needs exactly one number, text or reasoned absence.', v_field
        using errcode = 'check_violation';
    end if;
    if (v_kind = 'number' and v_text is not null)
       or (v_kind <> 'number' and v_value is not null) then
      raise exception 'Field "%" has the wrong observation type.', v_field using errcode = 'check_violation';
    end if;
    if v_text is not null and (length(v_text) not between 1 and 500
       or v_text ~ '^[[:space:]]*$'
       or (v_kind = 'choice' and not (v_choices @> jsonb_build_array(v_text)))) then
      raise exception 'Field "%" needs documented text or an allowed native choice.', v_field
        using errcode = 'check_violation';
    end if;
    if v_value is not null then
      if v_value in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
        raise exception 'Field "%" was given a value that is not a number.',
          v_field using errcode = 'check_violation';
      end if;
      if v_quantity in ('current', 'duration', 'frequency', 'count',
                        'percentage', 'intensity', 'energy-display')
         and v_value < 0 then
        raise exception
          'Field "%" is a % and cannot be negative.', v_field, v_quantity
          using errcode = 'check_violation';
      end if;
      if v_quantity = 'count' and v_value <> trunc(v_value) then
        raise exception 'Field "%" is a count and must be a whole number.',
          v_field using errcode = 'check_violation';
      end if;
      if scale(v_value) > v_decimals then
        raise exception
          'Field "%" was given % decimal places; this machine displays %.',
          v_field, scale(v_value), v_decimals
          using errcode = 'check_violation';
      end if;
    end if;
    insert into public.treatment_setup_readings (
      capture_id,
      studio_id, session_block_id, studio_machine_id,
      machine_profile_id, machine_profile_version, mode_key,
      group_key, channels, stage_key, field_key,
      value_numeric, value_text, absence_reason,
      native_unit, decimals, observation_source,
      revision, recorded_by_practitioner_id
    )
    values (
      v_capture,
      p_studio, p_block_id, p_studio_machine_id,
      p_profile_id, p_profile_version, v_mode,
      v_group, coalesce(p_channels, '{}'),
      nullif(v_stage, ''),
      v_field,
      v_value,
      v_text,
      v_absence,
      v_unit,
      v_decimals,
      v_source,
      v_revision,
      p_practitioner
    );
    v_count := v_count + 1;
  end loop;
  perform 1
     from public.machine_profile_field_contract f
    where f.machine_profile_id = p_profile_id
      and f.machine_profile_version = p_profile_version
      and f.mode_key = v_mode
      and not f.optional
      and not exists (
        select 1
          from public.treatment_setup_readings r
         where r.capture_id = v_capture
           and coalesce(r.stage_key, '') = f.stage_key
           and r.field_key = f.field_key
      );
  if found then
    raise exception
      'This capture is missing a required field for mode "%", so it cannot be recorded.',
      v_mode
      using errcode = 'check_violation';
  end if;
  return v_count;
end;
$$;

create or replace function public.setup_readings_for_block(
  p_block_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if not exists (
    select 1
      from public.session_blocks b
     where b.id = p_block_id
       and b.session_id = p_session_id
  ) then
    raise exception 'Unknown treatment block for this session.'
      using errcode = 'no_data_found';
  end if;
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'session_block_id',        r.session_block_id,
               'machine_profile_id',      r.machine_profile_id,
               'machine_profile_version', r.machine_profile_version,
               'mode_key',                r.mode_key,
               'group_key',               r.group_key,
               'channels',                r.channels,
               'stage_key',               r.stage_key,
               'field_key',               r.field_key,
               'value_text', r.value_text,
               'value_numeric',           r.value_numeric::text,
               'absence_reason',          r.absence_reason,
               'native_unit',             r.native_unit,
               'decimals',                r.decimals,
               'revision',                r.revision,
               'capture_id',              r.capture_id,
               'studio_machine_id',       r.studio_machine_id,
               'observation_source',      r.observation_source,
               'recorded_at',             r.recorded_at
             )
             order by r.field_key, r.group_key, r.revision, r.id
           ),
           '[]'::jsonb
         )
    into v_rows
    from public.treatment_setup_readings r
    join public.session_blocks b
      on b.id = r.session_block_id
     and b.session_id = p_session_id
   where r.session_block_id = p_block_id;
  return v_rows;
end;
$$;

create or replace function public.latest_setup_for_client(
  p_studio_id uuid,
  p_client_id uuid,
  p_exclude_session_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  with anchor as (
    select c.session_block_id, c.studio_machine_id, c.machine_profile_id,
           c.machine_profile_version, c.mode_key, c.recorded_at
      from public.treatment_setup_captures c
      join public.session_blocks b on b.id = c.session_block_id
      join public.sessions sn on sn.id = b.session_id
     where c.studio_id = p_studio_id
       and sn.studio_id = p_studio_id
       and sn.client_id = p_client_id
       and b.deleted_at is null
       and sn.deleted_at is null
       and sn.id is distinct from p_exclude_session_id
       and public.is_studio_member(p_studio_id)
     order by c.recorded_at desc, c.revision desc
     limit 1
  ),
  newest_per_group as (
    select distinct on (c.group_key) c.id
      from public.treatment_setup_captures c
      join anchor a
        on a.session_block_id = c.session_block_id
       and a.machine_profile_id = c.machine_profile_id
       and a.machine_profile_version = c.machine_profile_version
       and a.mode_key = c.mode_key
       and a.studio_machine_id is not distinct from c.studio_machine_id
     where c.studio_id = p_studio_id
     order by c.group_key, c.revision desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'capture_id', r.capture_id,
        'session_block_id', r.session_block_id,
        'studio_machine_id', r.studio_machine_id,
        'machine_profile_id', r.machine_profile_id,
        'machine_profile_version', r.machine_profile_version,
        'mode_key', r.mode_key,
        'group_key', r.group_key,
        'channels', r.channels,
        'stage_key', r.stage_key,
        'field_key', r.field_key,
        'value_text', r.value_text,
               'value_numeric', r.value_numeric::text,
        'absence_reason', r.absence_reason,
        'native_unit', r.native_unit,
        'decimals', r.decimals,
        'observation_source', r.observation_source,
        'revision', r.revision,
        'recorded_by_practitioner_id', r.recorded_by_practitioner_id,
        'recorded_at', r.recorded_at
      )
      order by r.group_key, r.field_key
    ),
    '[]'::jsonb
  )
    from public.treatment_setup_readings r
   where r.capture_id in (select id from newest_per_group);
$$;

revoke execute on function public.setup_readings_for_block(uuid, uuid) from public;
revoke execute on function public.setup_readings_for_block(uuid, uuid) from anon;
revoke execute on function public.setup_readings_for_block(uuid, uuid) from authenticated;
revoke execute on function public.setup_readings_for_block(uuid, uuid) from service_role;
grant execute on function public.setup_readings_for_block(uuid, uuid) to authenticated;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean) from public;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean) from anon;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean) from authenticated;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid, text[], boolean) from service_role;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from public;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from anon;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from authenticated;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from service_role;
grant execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) to service_role;
revoke execute on function public.latest_setup_for_client(uuid, uuid, uuid) from public;
revoke execute on function public.latest_setup_for_client(uuid, uuid, uuid) from anon;
revoke execute on function public.latest_setup_for_client(uuid, uuid, uuid) from authenticated;
revoke execute on function public.latest_setup_for_client(uuid, uuid, uuid) from service_role;
grant execute on function public.latest_setup_for_client(uuid, uuid, uuid) to authenticated;

commit;
