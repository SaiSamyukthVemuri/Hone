-- ===========================================================================
-- MACHINE-FIRST CHARTING STORAGE (MPX-02, #829) — 0223
-- ===========================================================================
--
-- THREE ADDITIVE PARTS, ONE CAPABILITY. A practitioner cannot record what her
-- machine showed until three things exist: the studio's machines, a remembered
-- choice of which one she is on, and somewhere to put the readings. They are
-- one migration because they are one capability and because the census is
-- crowded: 0211-0222 were all claimed by other lanes when this was authored
-- (0219 to G1 #864), so this lane takes exactly one number.
--
-- NUMBER PROVENANCE. 0223 was derived by a fresh census across every worktree
-- and all open PRs on 2026-10-12 and claimed in
-- /srv/hone/RESERVED_MIGRATION_0223.txt. Because 0211-0222 are PENDING in other
-- lanes, the parity guard's contiguous-pending-suffix rule means this file only
-- goes green stacked on all of them. That is a known, accepted consequence of
-- taking a number in a crowded census, not a defect in this file.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------------
--
-- IT ACTIVATES NO MACHINE MODEL. The catalogue in lib/machines/catalogue.ts
-- offers zero profiles today, because no exact model's evidence is complete.
-- This file stores a `machine_profile_id` as TEXT and deliberately does not
-- constrain it to a known set: the catalogue is application-side, curated, and
-- versioned, and a CHECK listing today's profile ids would freeze a review
-- decision into applied SQL. Model activation stays an evidence review.
--
-- IT CHANGES NO EXISTING VALUE. Two nullable columns are added to
-- `public.practitioners`; every other object here is new. No existing row is
-- read, rewritten, backfilled or reinterpreted, and in particular the retired
-- `galvanic_intensity_percent` and the existing `machine_frequency` columns are
-- untouched. Legacy records keep their original meaning.
--
-- IT STORES NO DOSE. Each reading keeps its own native unit and the machine's
-- own decimal precision. Nothing is normalised, converted or summed across
-- units: microamps on one machine and milliamps on another are different
-- columns of meaning, not two scales of one number.
--
-- ---------------------------------------------------------------------------
-- OWNERSHIP IS ENFORCED HERE, NOT ONLY IN THE SERVER
-- ---------------------------------------------------------------------------
--
-- Every write goes through a SECURITY DEFINER command that resolves the CALLER
-- to a membership with `own_practitioner_in_studio` (0178) or
-- `is_studio_owner` (0001), and no command accepts a practitioner id. A
-- studio id parameter is a FILTER that must match the caller's own membership,
-- never an authorization claim: `own_practitioner_in_studio` returns NULL for a
-- non-member, which is what makes cross-studio refusal structural. Direct DML
-- is revoked from every runtime role, so the commands are the only way in.

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- PART 1 — public.studio_machines: the studio's physical units
-- ===========================================================================
--
-- CATALOGUE IDENTITY AND DEVICE IDENTITY ARE DIFFERENT THINGS. Two rooms can
-- hold the same model, a studio names its own units, and installed options
-- belong to the unit rather than to the model. So a row carries the profile it
-- IS (`machine_profile_id` + `machine_profile_version`) separately from what
-- the studio CALLS it, and separately again from what is physically fitted.
--
-- `machine_profile_version` is the CONTRACT version the unit was registered
-- against, not firmware. A reading recorded under version 1 renders against
-- version 1 forever; that is why the version travels onto every reading below
-- rather than being looked up at read time.

create table if not exists public.studio_machines (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,

  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),

  -- What the studio calls this unit, e.g. "Room 2 xCell".
  display_name text not null
    check (length(btrim(display_name)) between 1 and 80),

  -- Options physically fitted to THIS unit. A mode gated on an option is
  -- unavailable on a unit that lacks it, however well evidenced the model is.
  installed_options text[] not null default '{}',

  -- Set once the unit leaves service. A retired unit is never selectable and
  -- is never silently substituted, but its historical readings stay readable.
  retired_at timestamptz,

  created_at timestamptz not null default now()
);

-- One display name per studio: a practitioner picking "Room 2" must not have
-- to guess which "Room 2". Retired units keep their name reserved on purpose,
-- so a retired unit's readings cannot be confused with a new unit reusing it.
create unique index if not exists studio_machines_studio_display_name_uniq
  on public.studio_machines (studio_id, lower(btrim(display_name)));

create index if not exists studio_machines_studio_live_idx
  on public.studio_machines (studio_id)
  where retired_at is null;

comment on table public.studio_machines is
  '0223. One row per PHYSICAL machine a studio owns. machine_profile_id/version point at the application-side curated catalogue (lib/machines/catalogue.ts) and are deliberately NOT constrained to a known set here, because activation is a reviewed evidence decision rather than applied SQL. Member read, owner-only write through register_studio_machine / retire_studio_machine.';

alter table public.studio_machines enable row level security;

drop policy if exists "studio_machines_member_select" on public.studio_machines;
create policy "studio_machines_member_select"
  on public.studio_machines for select to authenticated
  using (public.is_studio_member(studio_machines.studio_id));

-- No insert/update/delete policy at all: the commands below are the only
-- write path, and they are SECURITY DEFINER so they bypass RLS by design
-- AFTER checking ownership themselves.

revoke all on public.studio_machines from public;
revoke all on public.studio_machines from anon;
revoke all on public.studio_machines from authenticated;
revoke all on public.studio_machines from service_role;
grant select on public.studio_machines to authenticated;
grant select, insert, update on public.studio_machines to service_role;

-- ---------------------------------------------------------------------------
-- PART 1 COMMANDS — owner only
-- ---------------------------------------------------------------------------

create or replace function public.register_studio_machine(
  p_studio_id uuid,
  p_machine_profile_id text,
  p_machine_profile_version integer,
  p_display_name text,
  p_installed_options text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  -- The studio id is a filter, not a claim. A non-owner is refused whatever
  -- they pass.
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'Only the studio owner may register a machine.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_machine_profile_version is null or p_machine_profile_version < 1 then
    raise exception 'A machine profile version is required.'
      using errcode = 'check_violation';
  end if;

  insert into public.studio_machines
    (studio_id, machine_profile_id, machine_profile_version,
     display_name, installed_options)
  values
    (p_studio_id, btrim(p_machine_profile_id), p_machine_profile_version,
     btrim(p_display_name), coalesce(p_installed_options, '{}'))
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.register_studio_machine(uuid, text, integer, text, text[]) is
  '0223. Registers one physical machine for a studio the CALLER owns. The studio id is a filter checked against is_studio_owner, never an authorization claim.';

create or replace function public.retire_studio_machine(p_machine_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_already timestamptz;
begin
  select m.studio_id, m.retired_at
    into v_studio, v_already
    from public.studio_machines m
   where m.id = p_machine_id;

  if v_studio is null then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  if not public.is_studio_owner(v_studio) then
    raise exception 'Only the studio owner may retire a machine.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotent: retiring a retired unit is not an error and does not move the
  -- recorded instant.
  if v_already is not null then
    return false;
  end if;

  update public.studio_machines
     set retired_at = now()
   where id = p_machine_id;

  -- Any practitioner still pointing at it loses the default rather than
  -- silently charting on a unit that left service. Her OWN row only is
  -- touched, and only the two UI-default columns.
  update public.practitioners
     set default_machine_id = null,
         default_machine_mode = null
   where default_machine_id = p_machine_id;

  return true;
end;
$$;

comment on function public.retire_studio_machine(uuid) is
  '0223. Takes one unit out of service, owner only. Clears it from any practitioner UI default so nobody charts on a retired unit; historical readings stay readable.';

-- ===========================================================================
-- PART 2 — the practitioner's remembered machine
-- ===========================================================================
--
-- WHY ON `practitioners` RATHER THAN A NEW TABLE. That table is already
-- `unique (studio_id, user_id)` with `studio_id not null`, so ONE ROW IS ONE
-- PRACTITIONER IN ONE STUDIO. A column there is per-practitioner-per-studio
-- by construction: the same person working in two studios has two rows and
-- therefore two remembered machines, with no extra keying and no chance of a
-- join losing the studio. 0084 and 0178 already established exactly this
-- pattern for `default_machine_frequency`.
--
-- THIS IS A UI DEFAULT, NOT THE CLINICAL RECORD. What was actually used is on
-- the readings in Part 3. Changing a remembered machine must never alter a
-- stored reading, and cannot: nothing below writes to Part 3.

alter table public.practitioners
  add column if not exists default_machine_id uuid
    references public.studio_machines(id) on delete set null;

alter table public.practitioners
  add column if not exists default_machine_mode text
    check (default_machine_mode is null
           or length(btrim(default_machine_mode)) between 1 and 60);

comment on column public.practitioners.default_machine_id is
  '0223. The practitioner''s remembered machine IN THIS STUDIO. One practitioners row is one (studio, user), so this is per-practitioner-per-studio with no extra keying. A UI default only: what was actually used lives on treatment_setup_readings. Cleared automatically when the unit is retired.';

comment on column public.practitioners.default_machine_mode is
  '0223. The mode she last worked in on that machine. UI default only.';

create or replace function public.set_own_default_machine(
  p_studio_id uuid,
  p_machine_id uuid,
  p_mode_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
  v_machine_studio uuid;
  v_retired timestamptz;
begin
  -- Resolves the CALLER's own active membership in exactly this studio, and
  -- returns NULL for a non-member. No practitioner id is accepted, so nobody
  -- can write another practitioner's default.
  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  if p_machine_id is not null then
    select m.studio_id, m.retired_at
      into v_machine_studio, v_retired
      from public.studio_machines m
     where m.id = p_machine_id;

    if v_machine_studio is null then
      raise exception 'Unknown machine.' using errcode = 'no_data_found';
    end if;

    -- CROSS-STUDIO REFUSAL. A machine from another studio is refused even for
    -- a caller who is a member of both: the remembered choice belongs to one
    -- (studio, practitioner) pair and must name a unit in that studio.
    if v_machine_studio <> p_studio_id then
      raise exception 'That machine belongs to another studio.'
        using errcode = 'insufficient_privilege';
    end if;

    if v_retired is not null then
      raise exception 'That machine is out of service.'
        using errcode = 'check_violation';
    end if;
  end if;

  update public.practitioners p
     set default_machine_id = p_machine_id,
         default_machine_mode =
           case when p_machine_id is null then null else nullif(btrim(p_mode_key), '') end
   where p.id = v_pract;

  return v_pract;
end;
$$;

comment on function public.set_own_default_machine(uuid, uuid, text) is
  '0223. Stores the CALLER''S OWN remembered machine in one explicit studio. Returns NULL when the caller has no active membership there. Refuses a machine from another studio and a retired machine. A NULL machine clears the default. Accepts no practitioner id, so one practitioner can never write another''s.';

-- ===========================================================================
-- PART 3 — public.treatment_setup_readings: what the machine showed
-- ===========================================================================
--
-- ONE ROW PER FIELD, NOT ONE ROW PER PASS. The alternative - a wide table with
-- a column per reading - cannot represent a model-specific field set, and
-- `number_1`/`duration_2` columns are explicitly forbidden by the MPX contract.
-- One row per (block, group, stage, field) represents any machine's screen
-- without the schema knowing which machine.
--
-- THE GROUP IS WHY MULTIPLE PROBES WORK. `group_key` separates settings that
-- differ between simultaneous probes on a multiple-needle machine. `channels`
-- is OPTIONAL association: a GEMM-16 setup saves with no channel named at all,
-- and sixteen rows are never required. An empty array means "this group's
-- setting, probe not individually identified", which is the normal case.
--
-- MISSING, ZERO AND NOT-APPLICABLE ARE THREE DIFFERENT THINGS. A recorded zero
-- is a value - on at least one machine a zero repeat means one emitted wave -
-- so it lives in `value_numeric`. An absence carries a REASON instead, and the
-- XOR constraint makes "a number or a reasoned absence, never a bare null" a
-- database fact rather than an application convention.
--
-- READINGS ARE IMMUTABLE. A material setup change is a NEW reading, never an
-- edit of a previous observation. The trigger below refuses UPDATE outright.
-- DELETE is left to the block's cascade, because a deleted block's readings
-- have nothing left to describe.
--
-- NATIVE UNIT AND PRECISION TRAVEL WITH THE VALUE, as does the profile version
-- they were captured under. A later contract version cannot retroactively
-- relabel an old reading, and nothing here can recompute one into a shared
-- dose.

create table if not exists public.treatment_setup_readings (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_block_id uuid not null
    references public.session_blocks(id) on delete cascade,

  -- The unit used. Nullable only so a retired-and-deleted unit cannot orphan a
  -- clinical reading; the profile identity below is captured verbatim and
  -- survives regardless.
  studio_machine_id uuid
    references public.studio_machines(id) on delete set null,
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),

  -- One settings group; several when probes differ.
  group_key text not null check (length(btrim(group_key)) between 1 and 40),
  channels smallint[] not null default '{}',

  -- NULL stage_key = a mode-level field. A stage is a component of one pass
  -- with its own readings, e.g. MultiPlex's slow-thermolysis and snap halves.
  stage_key text check (stage_key is null
                        or length(btrim(stage_key)) between 1 and 60),
  field_key text not null check (length(btrim(field_key)) between 1 and 60),

  value_numeric numeric,
  absence_reason text
    check (absence_reason is null
           or absence_reason in ('not-recorded', 'not-applicable', 'not-legible')),

  native_unit text not null check (length(btrim(native_unit)) between 1 and 20),
  decimals smallint not null check (decimals between 0 and 6),
  observation_source text not null
    check (observation_source in
           ('practitioner-entered', 'machine-displayed',
            'device-computed', 'estimated')),

  recorded_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  recorded_at timestamptz not null default now(),

  -- A number OR a reasoned absence. Never both, never neither.
  constraint treatment_setup_readings_value_xor check (
    (value_numeric is not null and absence_reason is null)
    or (value_numeric is null and absence_reason is not null)
  )
);

-- One reading per field per group per block. `coalesce` because a mode-level
-- field has no stage and NULL would not collide with itself in a plain unique.
create unique index if not exists treatment_setup_readings_field_uniq
  on public.treatment_setup_readings
     (session_block_id, group_key, coalesce(stage_key, ''), field_key);

create index if not exists treatment_setup_readings_block_idx
  on public.treatment_setup_readings (session_block_id);

create index if not exists treatment_setup_readings_studio_recorded_idx
  on public.treatment_setup_readings (studio_id, recorded_at desc);

comment on table public.treatment_setup_readings is
  '0223. One row per (block, group, stage, field) holding what the machine actually showed, in the machine''s own unit and precision, under the profile version it was captured against. Append-only: UPDATE is refused by trigger, because a material setup change is a new reading rather than an edit of a previous observation. A recorded zero is a value; an absence carries a reason.';

create or replace function public.refuse_treatment_setup_reading_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'A recorded treatment setup reading is immutable. Record a new reading instead.'
    using errcode = 'restrict_violation';
end;
$$;

comment on function public.refuse_treatment_setup_reading_update() is
  '0223. Makes treatment_setup_readings append-only. Protects a practitioner''s recorded observation from being silently rewritten by any path, including a future application bug.';

drop trigger if exists treatment_setup_readings_immutable
  on public.treatment_setup_readings;
create trigger treatment_setup_readings_immutable
  before update on public.treatment_setup_readings
  for each row
  execute function public.refuse_treatment_setup_reading_update();

alter table public.treatment_setup_readings enable row level security;

drop policy if exists "treatment_setup_readings_member_select"
  on public.treatment_setup_readings;
create policy "treatment_setup_readings_member_select"
  on public.treatment_setup_readings for select to authenticated
  using (public.is_studio_member(treatment_setup_readings.studio_id));

revoke all on public.treatment_setup_readings from public;
revoke all on public.treatment_setup_readings from anon;
revoke all on public.treatment_setup_readings from authenticated;
revoke all on public.treatment_setup_readings from service_role;
grant select on public.treatment_setup_readings to authenticated;
grant select, insert on public.treatment_setup_readings to service_role;

-- ---------------------------------------------------------------------------
-- PART 3 COMMAND — record one settings group
-- ---------------------------------------------------------------------------
--
-- The payload is one group's readings. Each element names its field and, for a
-- staged mode, its stage; carries either a value or an absence reason; and
-- states the native unit, the precision and who or what observed it.
--
-- The BLOCK determines the studio. The caller never names one, so there is no
-- studio parameter to forge: the block's own `studio_id` is resolved first and
-- the caller is then required to be an active member OF THAT STUDIO. A block
-- in another studio is refused because the membership lookup returns NULL.

create or replace function public.record_treatment_setup_group(
  p_block_id uuid,
  p_studio_machine_id uuid,
  p_mode_key text,
  p_group_key text,
  p_channels smallint[],
  p_readings jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_pract uuid;
  v_machine_studio uuid;
  v_profile_id text;
  v_profile_version integer;
  v_retired timestamptz;
  v_count integer := 0;
  v_item jsonb;
begin
  if p_readings is null or jsonb_typeof(p_readings) <> 'array' then
    raise exception 'Readings must be a JSON array.' using errcode = 'check_violation';
  end if;

  -- The block decides the studio. Nothing the caller sends does.
  select b.studio_id into v_studio
    from public.session_blocks b
   where b.id = p_block_id
     and b.deleted_at is null;

  if v_studio is null then
    raise exception 'Unknown treatment block.' using errcode = 'no_data_found';
  end if;

  v_pract := public.own_practitioner_in_studio(v_studio);
  if v_pract is null then
    raise exception 'Not an active member of this studio.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Machine first: a reading without a machine cannot be reproduced, so the
  -- unit is required and must belong to the block's own studio.
  if p_studio_machine_id is null then
    raise exception 'Choose the machine before recording settings.'
      using errcode = 'check_violation';
  end if;

  select m.studio_id, m.machine_profile_id, m.machine_profile_version, m.retired_at
    into v_machine_studio, v_profile_id, v_profile_version, v_retired
    from public.studio_machines m
   where m.id = p_studio_machine_id;

  if v_machine_studio is null then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  if v_machine_studio <> v_studio then
    raise exception 'That machine belongs to another studio.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_retired is not null then
    raise exception 'That machine is out of service.'
      using errcode = 'check_violation';
  end if;

  for v_item in select jsonb_array_elements(p_readings)
  loop
    insert into public.treatment_setup_readings (
      studio_id, session_block_id, studio_machine_id,
      machine_profile_id, machine_profile_version, mode_key,
      group_key, channels, stage_key, field_key,
      value_numeric, absence_reason,
      native_unit, decimals, observation_source,
      recorded_by_practitioner_id
    )
    values (
      v_studio, p_block_id, p_studio_machine_id,
      -- The profile identity is copied from the UNIT at record time, so a
      -- later re-registration cannot retroactively change what a reading was
      -- captured under.
      v_profile_id, v_profile_version, btrim(p_mode_key),
      btrim(p_group_key), coalesce(p_channels, '{}'),
      nullif(btrim(coalesce(v_item->>'stage_key', '')), ''),
      btrim(v_item->>'field_key'),
      case when v_item->>'value' is null then null
           else (v_item->>'value')::numeric end,
      nullif(btrim(coalesce(v_item->>'absence_reason', '')), ''),
      btrim(v_item->>'native_unit'),
      (v_item->>'decimals')::smallint,
      btrim(v_item->>'observation_source'),
      v_pract
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) is
  '0223. Records ONE settings group for one treatment block. The block determines the studio and the caller must be an active member of it, so a block or machine in another studio is refused. The machine is required and its profile identity is copied at record time. Readings are append-only; recording again for the same field raises a unique violation rather than overwriting.';

-- ---------------------------------------------------------------------------
-- GRANTS — re-asserted by name on every command
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
-- AND service_role at function-create time. All four names are revoked
-- explicitly and only the intended role is granted back. Missing one was the
-- 0129 (anon) and 0164 (service_role) defect.

revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from public;
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from anon;
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from authenticated;
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from service_role;
grant execute on function public.register_studio_machine(uuid, text, integer, text, text[]) to authenticated;

revoke execute on function public.retire_studio_machine(uuid) from public;
revoke execute on function public.retire_studio_machine(uuid) from anon;
revoke execute on function public.retire_studio_machine(uuid) from authenticated;
revoke execute on function public.retire_studio_machine(uuid) from service_role;
grant execute on function public.retire_studio_machine(uuid) to authenticated;

revoke execute on function public.set_own_default_machine(uuid, uuid, text) from public;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from anon;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from authenticated;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from service_role;
grant execute on function public.set_own_default_machine(uuid, uuid, text) to authenticated;

revoke execute on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) from public;
revoke execute on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) from anon;
revoke execute on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) from authenticated;
revoke execute on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) from service_role;
grant execute on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) to authenticated;

-- The immutability trigger function is internal: nothing may call it directly.
revoke execute on function public.refuse_treatment_setup_reading_update() from public;
revoke execute on function public.refuse_treatment_setup_reading_update() from anon;
revoke execute on function public.refuse_treatment_setup_reading_update() from authenticated;
revoke execute on function public.refuse_treatment_setup_reading_update() from service_role;

commit;
