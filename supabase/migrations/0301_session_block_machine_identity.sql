-- 0301: the TREATMENT AREA'S MACHINE IDENTITY (HON-8 charting, Sam's preview feedback 4 Nov 2026).
--
-- HELD, ADDITIVE, NO BACKFILL. Never applied without Sam's per-change approval.
--
-- THE DEFECT. A treatment area recorded no machine identity of its own. The
-- machine and mode a practitioner chose were stored ONLY as treatment_setup_readings
-- rows, so choosing a machine and mode and entering no value wrote nothing and
-- the choice could not survive a refresh; and an xCell Pur (legacy) area has no
-- identity column at all. NULL here means "not recorded"; no machine is ever
-- inferred for an existing row.
--
-- WHY session_blocks. The treatment area (settings block) is the unit that
-- carries the machine settings, the readings reference it by session_block_id,
-- and different areas of one visit can use different machines. Per-session
-- would be wrong for that; per-reading is what already fails when nothing is
-- entered.
--
-- TRUTH VS PREFERENCE. These columns are the saved TREATMENT RECORD.
-- practitioners.default_machine_* stay a sticky suggestion and are not touched.
--
-- Existing rows are byte-identical: three nullable columns, no default, no
-- rewrite of any existing value.
begin;
set local lock_timeout = '5s';

alter table public.session_blocks
  add column if not exists machine_profile_id  text,
  add column if not exists studio_machine_id   uuid references public.studio_machines (id),
  add column if not exists machine_mode_key    text;

alter table public.session_blocks
  drop constraint if exists session_blocks_machine_identity_shape;
alter table public.session_blocks
  add constraint session_blocks_machine_identity_shape check (
    (machine_profile_id is null or length(btrim(machine_profile_id)) between 1 and 120)
    and (studio_machine_id is null or machine_profile_id is not null)
    and (machine_mode_key is null or machine_profile_id is not null)
    and (machine_mode_key is null or length(btrim(machine_mode_key)) between 1 and 120)
  ) not valid;
alter table public.session_blocks
  validate constraint session_blocks_machine_identity_shape;

-- ---------------------------------------------------------------------------
-- The one writer of the three columns. Not granted to any API role: only the
-- commands below call it, inside their own transaction.
--
-- A registered unit supplies its own profile id (a caller cannot name a
-- different one); without a unit, a profile id is required and no mode key is
-- accepted (a legacy xCell Pur area keeps its mode in the legacy columns).
-- The unit must belong to the block's studio and not be retired.
-- ---------------------------------------------------------------------------
create or replace function public.apply_block_machine_identity(
  p_block_id           uuid,
  p_studio_id          uuid,
  p_profile_id         text,
  p_studio_machine_id  uuid,
  p_mode_key           text,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_new timestamptz;
  v_current timestamptz;
  v_profile text := nullif(btrim(coalesce(p_profile_id, '')), '');
  v_mode text := nullif(btrim(coalesce(p_mode_key, '')), '');
  v_unit_profile text;
begin
  if p_studio_machine_id is not null then
    select m.machine_profile_id into v_unit_profile
      from public.studio_machines m
     where m.id = p_studio_machine_id
       and m.studio_id = p_studio_id
       and m.retired_at is null;
    if v_unit_profile is null then
      raise exception 'That machine is not available in this studio.'
        using errcode = 'check_violation';
    end if;
    if v_profile is not null and v_profile <> v_unit_profile then
      raise exception 'The machine does not match the selected model.'
        using errcode = 'check_violation';
    end if;
    v_profile := v_unit_profile;
  else
    if v_profile is null then
      raise exception 'A machine model is required.'
        using errcode = 'check_violation';
    end if;
    if v_mode is not null then
      raise exception 'A mode needs a registered machine.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- THE HELD VERSION IS CHECKED INSIDE THIS TRANSACTION, under the row lock
  -- (Codex 4476240827, decided by OPS). A caller that holds the block's
  -- updated_at passes it; a mismatch is the same refusal as the block commands'
  -- own stale check, so a write by another tab between the caller's read and
  -- this call is detected, never overwritten. The NEW updated_at comes back from
  -- the same UPDATE ... RETURNING, so the caller adopts exactly the version its
  -- own write produced and no separate read can race it.
  select b.updated_at into v_current
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = p_studio_id
     and b.deleted_at is null
     for update;
  if not found then
    raise exception 'Block not found.' using errcode = 'check_violation';
  end if;
  if p_expected_updated_at is not null and v_current <> p_expected_updated_at then
    raise exception 'stale_block_version: this settings block was changed elsewhere';
  end if;

  update public.session_blocks b
     set machine_profile_id = v_profile,
         studio_machine_id = p_studio_machine_id,
         machine_mode_key = v_mode
   where b.id = p_block_id
   returning b.updated_at into v_new;
  return v_new;
end;
$$;

revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz) from public;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz) from anon;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz) from authenticated;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz) from service_role;

-- ---------------------------------------------------------------------------
-- COMMAND 1: record the identity of an EXISTING area (machine and mode chosen,
-- possibly with no value yet). Studio and actor are derived, never supplied.
-- ---------------------------------------------------------------------------
create or replace function public.record_block_machine_identity(
  p_block_id           uuid,
  p_session_id         uuid,
  p_client_id          uuid,
  p_profile_id         text,
  p_studio_machine_id  uuid,
  p_mode_key           text,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
begin
  v_studio := public.assert_session_writable(p_session_id, p_client_id);
  perform public.assert_block_in_session(p_block_id, p_session_id, v_studio);
  -- Returns the block's new updated_at (from the UPDATE ... RETURNING).
  return public.apply_block_machine_identity(
    p_block_id, v_studio, p_profile_id, p_studio_machine_id, p_mode_key,
    p_expected_updated_at);
end;
$$;

revoke execute on function public.record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, timestamptz) from public;
revoke execute on function public.record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, timestamptz) from anon;
revoke execute on function public.record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, timestamptz) from authenticated;
revoke execute on function public.record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, timestamptz) from service_role;
grant execute on function public.record_block_machine_identity(uuid, uuid, uuid, text, uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- COMMAND 2: the initial save WITH identity, in ONE transaction.
-- Delegates to create_block_with_initial_setup (0223, frozen) BY NAME and then
-- stamps the identity on the block it created. The unit and mode already
-- arrive as p_studio_machine_id and p_setup_mode_key; p_machine_profile_id is
-- used only when there is no registered unit (the legacy xCell Pur choice).
-- A replayed call (reused = true) is answered with the original and does not
-- rewrite the identity.
-- ---------------------------------------------------------------------------
create or replace function public.create_block_with_initial_setup_and_identity(
  p_session_id                     uuid,
  p_client_id                      uuid,
  p_block                          jsonb,
  p_block_extra                    jsonb,
  p_areas                          jsonb,
  p_with_entry                     boolean,
  p_area                           text,
  p_areas_list                     text[],
  p_probe_size                     text,
  p_probe_lot_id                   uuid,
  p_mode                           text,
  p_pulse_count                    integer,
  p_pulse_delay_seconds            numeric,
  p_comments                       text,
  p_observation_chips              jsonb,
  p_apilus_modality                text,
  p_energy_level                   integer,
  p_minutes_performed              integer,
  p_probe_type                     text,
  p_machine_frequency              text,
  p_hairs_treated                  integer,
  p_galvanic_ma                    numeric,
  p_galvanic_duration_seconds      integer,
  p_thermolysis_intensity_percent  integer,
  p_thermolysis_duration_seconds   numeric,
  p_units_of_lye                   numeric,
  p_studio_machine_id              uuid,
  p_setup_mode_key                 text,
  p_setup_idempotency_key          text,
  p_setup_groups                   jsonb,
  p_machine_profile_id             text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result jsonb;
  v_studio uuid;
begin
  v_result := public.create_block_with_initial_setup(
      p_session_id => p_session_id,
      p_client_id => p_client_id,
      p_block => p_block,
      p_block_extra => p_block_extra,
      p_areas => p_areas,
      p_with_entry => p_with_entry,
      p_area => p_area,
      p_areas_list => p_areas_list,
      p_probe_size => p_probe_size,
      p_probe_lot_id => p_probe_lot_id,
      p_mode => p_mode,
      p_pulse_count => p_pulse_count,
      p_pulse_delay_seconds => p_pulse_delay_seconds,
      p_comments => p_comments,
      p_observation_chips => p_observation_chips,
      p_apilus_modality => p_apilus_modality,
      p_energy_level => p_energy_level,
      p_minutes_performed => p_minutes_performed,
      p_probe_type => p_probe_type,
      p_machine_frequency => p_machine_frequency,
      p_hairs_treated => p_hairs_treated,
      p_galvanic_ma => p_galvanic_ma,
      p_galvanic_duration_seconds => p_galvanic_duration_seconds,
      p_thermolysis_intensity_percent => p_thermolysis_intensity_percent,
      p_thermolysis_duration_seconds => p_thermolysis_duration_seconds,
      p_units_of_lye => p_units_of_lye,
      p_studio_machine_id => p_studio_machine_id,
      p_setup_mode_key => p_setup_mode_key,
      p_setup_idempotency_key => p_setup_idempotency_key,
      p_setup_groups => p_setup_groups
  );

  if coalesce((v_result->>'reused')::boolean, false) is not true
     and (p_studio_machine_id is not null
          or nullif(btrim(coalesce(p_machine_profile_id, '')), '') is not null) then
    v_studio := public.assert_session_writable(p_session_id, p_client_id);
    perform public.apply_block_machine_identity(
      (v_result->>'block_id')::uuid, v_studio,
      p_machine_profile_id, p_studio_machine_id, p_setup_mode_key);
  end if;

  return v_result;
end;
$$;

revoke execute on function public.create_block_with_initial_setup_and_identity(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb, text) from public;
revoke execute on function public.create_block_with_initial_setup_and_identity(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb, text) from anon;
revoke execute on function public.create_block_with_initial_setup_and_identity(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb, text) from authenticated;
revoke execute on function public.create_block_with_initial_setup_and_identity(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb, text) from service_role;
grant execute on function public.create_block_with_initial_setup_and_identity(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- COMMAND 3: record settings on an EXISTING area WITH identity, one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.record_setup_submission_with_identity(
  p_block_id uuid,
  p_studio_machine_id uuid,
  p_mode_key text,
  p_idempotency_key text,
  p_groups jsonb,
  p_session_id uuid,
  p_client_id uuid,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_result jsonb;
  v_studio uuid;
  v_new timestamptz;
begin
  -- THE BLOCK IS LOCKED FOR UPDATE FIRST, HERE, AND ONLY HERE (Insurance Z-1).
  -- record_treatment_setup_submission takes FOR SHARE on the block and
  -- apply_block_machine_identity takes FOR UPDATE later in the same transaction;
  -- two concurrent submissions on one block would each hold SHARE and wait on the
  -- other's UPGRADE, which is a deadlock. Taking the stronger lock before either
  -- makes the second submission wait for the first to finish instead. Scoped to
  -- the caller's own studio and session AFTER the writability check, so an id from
  -- another studio is never locked.
  v_studio := public.assert_session_writable(p_session_id, p_client_id);
  perform 1
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = v_studio
     and b.session_id = p_session_id
     for update;
  v_result := public.record_treatment_setup_submission(
    p_block_id => p_block_id,
    p_studio_machine_id => p_studio_machine_id,
    p_mode_key => p_mode_key,
    p_idempotency_key => p_idempotency_key,
    p_groups => p_groups,
    p_session_id => p_session_id,
    p_client_id => p_client_id
  );
  -- A REPLAY (same key, answered with the original) changes nothing: a late
  -- replay after the area moved to another unit must not put the earlier unit
  -- back (Privacy F-2). Same rule as the create wrapper above.
  if coalesce((v_result->>'reused')::boolean, false) is not true then
    -- The held version is checked here, in this transaction: a mismatch raises
    -- and rolls back the readings just written too. The new updated_at comes back
    -- in the result as block_updated_at. A REPLAY returns none and checks nothing
    -- (it writes nothing; decided by OPS, Insurance N-8).
    v_new := public.apply_block_machine_identity(
      p_block_id, v_studio, null, p_studio_machine_id, p_mode_key,
      p_expected_updated_at);
    v_result := v_result || jsonb_build_object('block_updated_at', v_new);
  end if;
  return v_result;
end;
$$;

revoke execute on function public.record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz) from public;
revoke execute on function public.record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz) from anon;
revoke execute on function public.record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz) from authenticated;
revoke execute on function public.record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz) from service_role;
grant execute on function public.record_setup_submission_with_identity(uuid, uuid, text, text, jsonb, uuid, uuid, timestamptz) to authenticated;

commit;
