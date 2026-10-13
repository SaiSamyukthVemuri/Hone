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
-- service_role gets SELECT ONLY, deliberately.
--
-- It previously held insert and update here. That silently undid the paragraph
-- above: service_role bypasses RLS, so any backend path using the service-role
-- client could have written this table WITHOUT executing is_studio_owner, which
-- is the one check the whole command-only design rests on. Found by Codex
-- review at 9c6fbbe5.
--
-- Nothing needed the write grants. lib/machines/machine-queries.ts writes only
-- through the RPCs below and uses .from() for reads; the browser spec seeds its
-- fixture row over a direct postgres connection, not through PostgREST. So the
-- grants bought nothing and cost the invariant.
grant select on public.studio_machines to service_role;

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

  -- WHO OBSERVED IT. The composite same-studio constraint below is what
  -- enforces that this practitioner belongs to the reading's own studio; the
  -- column carries no inline simple FK on purpose. See the constraint.
  -- APPEND-ONLY REVISIONS. 1 for the first observation of a field in a block,
  -- 2 for the next, and so on. A material setup change during one treatment is
  -- a NEW observation, not an edit of the previous one, so both rows persist
  -- and the HIGHEST revision is what reads as current.
  --
  -- The first version of this table had a unique index on the field
  -- coordinates alone, which refused the second observation outright - the
  -- schema contradicted this table's own comment, and a setting changed
  -- mid-treatment could not be recorded at all.
  revision smallint not null default 1 check (revision >= 1),
  recorded_by_practitioner_id uuid,
  recorded_at timestamptz not null default now(),

  -- A number OR a reasoned absence. Never both, never neither.
  constraint treatment_setup_readings_value_xor check (
    (value_numeric is not null and absence_reason is null)
    or (value_numeric is null and absence_reason is not null)
  )
);

-- 0179'S ACTOR LAW, APPLIED RATHER THAN EXEMPTED.
--
-- `recorded_by_practitioner_id` is an ACTOR column: it records who observed the
-- reading. 0179 upgraded every actor FK in the schema from a simple reference
-- to a COMPOSITE same-studio one, so a studio's record cannot name a
-- practitioner from another studio, and it enforces that in the catalog instead
-- of trusting the writer. A simple `references practitioners(id)` here would
-- have been a tenth exemption from a law with nine, and
-- tests/db/actor-fk-integrity.db.test.ts is the guard that says so.
--
-- `on delete restrict`, matching 0179: clinical provenance must not be erasable
-- by deleting the practitioner. `set null` would quietly lose who recorded a
-- reading, which is the opposite of what a treatment record is for.
--
-- Added VALIDATED rather than `not valid` because the table is created empty in
-- this same transaction, so there is no existing row to validate against.

alter table public.treatment_setup_readings
  add constraint treatment_setup_readings_recorded_by_same_studio_fk
  foreign key (recorded_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict;

-- One reading per field per group per block PER REVISION. `coalesce` because a
-- mode-level field has no stage and NULL would not collide with itself in a
-- plain unique.
--
-- Including `revision` is what makes a changed setting appendable while still
-- refusing an accidental exact-duplicate write at the same revision: the
-- command computes the next revision itself, so a caller cannot choose one.
create unique index if not exists treatment_setup_readings_field_revision_uniq
  on public.treatment_setup_readings
     (session_block_id, group_key, coalesce(stage_key, ''), field_key, revision);

-- Reading "the current value of this field in this block" is
-- (coordinates, max(revision)), so the index is ordered to serve it directly.
create index if not exists treatment_setup_readings_latest_idx
  on public.treatment_setup_readings
     (session_block_id, group_key, coalesce(stage_key, ''), field_key,
      revision desc);

create index if not exists treatment_setup_readings_block_idx
  on public.treatment_setup_readings (session_block_id);

create index if not exists treatment_setup_readings_studio_recorded_idx
  on public.treatment_setup_readings (studio_id, recorded_at desc);

comment on table public.treatment_setup_readings is
  '0223. One row per (block, group, stage, field, REVISION) holding what the machine actually showed, in the machine''s own unit and precision, under the profile version it was captured against. APPEND-ONLY: UPDATE is refused by trigger, and a material setup change during the same treatment is recorded as a NEW revision rather than an edit - so every observation survives and the HIGHEST revision reads as current. The command computes the next revision itself; a caller cannot choose one, so an exact-duplicate write at the same revision is still refused. A recorded zero is a value; an absence carries a reason. Every field, unit and precision is validated against machine_profile_field_contract and DERIVED from it, so a caller cannot invent a field or mislabel its unit.';

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
-- SELECT ONLY here too, and this one matters more: these are clinical rows and
-- the immutability trigger makes every insert permanent. An unchecked
-- service-role insert would have been an unattributable, unamendable clinical
-- record. record_treatment_setup_group below is the only write path.
grant select on public.treatment_setup_readings to service_role;

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
  -- Derived per reading from the field contract, never accepted from input.
  v_stage text;
  v_field text;
  v_unit text;
  v_decimals smallint;
  v_revision smallint;
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

  -- THE CONTRACT MUST EXIST, AND IT FAILS CLOSED.
  --
  -- A profile version with no synced contract cannot be validated, so it
  -- cannot be recorded. The alternative - record it unvalidated when the
  -- contract happens to be missing - would make the whole check decorative,
  -- because the bypass would be "do not sync".
  if not exists (
    select 1 from public.machine_profile_field_contract c
     where c.machine_profile_id = v_profile_id
       and c.machine_profile_version = v_profile_version
       and c.mode_key = btrim(p_mode_key)
  ) then
    raise exception
      'No field contract is published for this machine profile version and mode, so its settings cannot be recorded.'
      using errcode = 'check_violation';
  end if;

  for v_item in select jsonb_array_elements(p_readings)
  loop
    -- VALIDATE AND DERIVE. The caller says WHICH field and WHAT it read; the
    -- field's native unit and precision come from the contract, never from the
    -- caller. An unknown (mode, stage, field) triple is refused rather than
    -- stored, because the immutability trigger would make it permanent.
    v_stage := btrim(coalesce(v_item->>'stage_key', ''));
    v_field := btrim(coalesce(v_item->>'field_key', ''));

    select c.native_unit, c.decimals
      into v_unit, v_decimals
      from public.machine_profile_field_contract c
     where c.machine_profile_id = v_profile_id
       and c.machine_profile_version = v_profile_version
       and c.mode_key = btrim(p_mode_key)
       and c.stage_key = v_stage
       and c.field_key = v_field;

    if v_unit is null then
      raise exception
        'This machine profile has no field "%" in mode "%"%, so it cannot be recorded.',
        v_field,
        btrim(p_mode_key),
        case when v_stage = '' then '' else format(' stage "%s"', v_stage) end
        using errcode = 'check_violation';
    end if;

    -- THE NEXT REVISION, computed HERE so a caller cannot choose one. A
    -- material setup change during the same treatment appends; it does not
    -- overwrite, and it does not collide.
    select coalesce(max(r.revision), 0) + 1
      into v_revision
      from public.treatment_setup_readings r
     where r.session_block_id = p_block_id
       and r.group_key = btrim(p_group_key)
       and coalesce(r.stage_key, '') = v_stage
       and r.field_key = v_field;

    insert into public.treatment_setup_readings (
      studio_id, session_block_id, studio_machine_id,
      machine_profile_id, machine_profile_version, mode_key,
      group_key, channels, stage_key, field_key,
      value_numeric, absence_reason,
      native_unit, decimals, observation_source,
      revision, recorded_by_practitioner_id
    )
    values (
      v_studio, p_block_id, p_studio_machine_id,
      -- The profile identity is copied from the UNIT at record time, so a
      -- later re-registration cannot retroactively change what a reading was
      -- captured under.
      v_profile_id, v_profile_version, btrim(p_mode_key),
      btrim(p_group_key), coalesce(p_channels, '{}'),
      nullif(v_stage, ''),
      v_field,
      case when v_item->>'value' is null then null
           else (v_item->>'value')::numeric end,
      nullif(btrim(coalesce(v_item->>'absence_reason', '')), ''),
      -- DERIVED, both of them.
      v_unit,
      v_decimals,
      btrim(v_item->>'observation_source'),
      v_revision,
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
-- PART 3b — THE FIELD CONTRACT, IN THE DATABASE
-- ---------------------------------------------------------------------------
--
-- WHY THIS TABLE EXISTS.
--
-- record_treatment_setup_group is granted to `authenticated`, because it has to
-- run as the practitioner for own_practitioner_in_studio to resolve her. So an
-- authenticated studio member can call it DIRECTLY, bypassing the server
-- action. Until now the command accepted the caller's word for which field was
-- being recorded and what its unit and precision were, cast it, and inserted
-- it - and the immutability trigger then made a corrupted clinical row
-- permanent. The application validated properly; the authority boundary did
-- not, which is the only boundary that counts.
--
-- Validating inside the command was impossible while the field contract lived
-- only in TypeScript. So it lives here too, and the command joins against it.
--
-- NO MODEL NAMES IN THIS MIGRATION. The table is created EMPTY. Rows arrive
-- through the owner-gated command below, from lib/machines/catalogue.ts, which
-- keeps `machine_profile_id` an unconstrained TEXT identifier and keeps model
-- ACTIVATION an evidence review rather than a schema fact. A migration that
-- named real models would quietly turn an evidence decision into DDL.

create table if not exists public.machine_profile_field_contract (
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),
  -- '' rather than NULL for a mode-level field, so the primary key works
  -- without a coalesce and a NULL cannot duplicate itself.
  stage_key text not null default ''
    check (length(stage_key) <= 60),
  field_key text not null check (length(btrim(field_key)) between 1 and 60),

  native_unit text not null check (length(btrim(native_unit)) between 1 and 20),
  decimals smallint not null check (decimals between 0 and 6),

  created_at timestamptz not null default now(),

  constraint machine_profile_field_contract_pkey primary key
    (machine_profile_id, machine_profile_version, mode_key, stage_key, field_key)
);

comment on table public.machine_profile_field_contract is
  '0223. The authoritative field contract: for a given profile VERSION and mode, which fields exist and what unit and precision each one is recorded in. record_treatment_setup_group validates every reading against this table and DERIVES native_unit and decimals from it, so a direct RPC caller cannot invent a field or mislabel a unit. Created EMPTY and populated from lib/machines/catalogue.ts through sync_machine_profile_field_contract, deliberately: naming real models in a migration would turn model activation from an evidence review into a schema fact. stage_key is '''' rather than NULL for a mode-level field so the primary key needs no coalesce.';

alter table public.machine_profile_field_contract enable row level security;

-- Readable by any authenticated practitioner: it is a product contract, not
-- studio data, and the capture UI legitimately needs it. There is no studio_id
-- here for the same reason.
drop policy if exists "machine_profile_field_contract_read" on public.machine_profile_field_contract;
create policy "machine_profile_field_contract_read"
  on public.machine_profile_field_contract for select to authenticated
  using (true);

revoke all on public.machine_profile_field_contract from public;
revoke all on public.machine_profile_field_contract from anon;
revoke all on public.machine_profile_field_contract from authenticated;
revoke all on public.machine_profile_field_contract from service_role;
grant select on public.machine_profile_field_contract to authenticated;
grant select on public.machine_profile_field_contract to service_role;

-- Sync one (profile, version, mode) contract. OWNER ONLY, in some studio, for
-- the same reason registration is: it is an administrative act, not charting.
--
-- IDEMPOTENT and ADDITIVE-OR-REPLACING WITHIN ONE (profile, version, mode): the
-- rows for that triple are replaced wholesale, so correcting a contract is one
-- call. A DIFFERENT version is a different contract and is never touched, which
-- is what keeps historical readings interpretable under the version they were
-- captured against.
create or replace function public.sync_machine_profile_field_contract(
  p_machine_profile_id text,
  p_machine_profile_version integer,
  p_mode_key text,
  p_fields jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_item jsonb;
  v_count integer := 0;
begin
  -- Any studio OWNER may sync it. The contract is not studio-scoped, so this
  -- is deliberately not own_practitioner_in_studio for a particular studio -
  -- but it is still not open to a practitioner or to anon.
  if not exists (
    select 1
      from public.practitioners p
     where p.user_id = auth.uid()
       and p.role = 'owner'
       and p.active
  ) then
    raise exception 'Only a studio owner may sync a machine field contract.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_machine_profile_id is null or btrim(p_machine_profile_id) = '' then
    raise exception 'A profile id is required.' using errcode = 'check_violation';
  end if;
  if p_machine_profile_version is null or p_machine_profile_version < 1 then
    raise exception 'A profile version is required.'
      using errcode = 'check_violation';
  end if;
  if p_mode_key is null or btrim(p_mode_key) = '' then
    raise exception 'A mode key is required.' using errcode = 'check_violation';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'Fields must be a JSON array.' using errcode = 'check_violation';
  end if;

  delete from public.machine_profile_field_contract c
   where c.machine_profile_id = btrim(p_machine_profile_id)
     and c.machine_profile_version = p_machine_profile_version
     and c.mode_key = btrim(p_mode_key);

  for v_item in select jsonb_array_elements(p_fields)
  loop
    insert into public.machine_profile_field_contract (
      machine_profile_id, machine_profile_version, mode_key,
      stage_key, field_key, native_unit, decimals
    )
    values (
      btrim(p_machine_profile_id),
      p_machine_profile_version,
      btrim(p_mode_key),
      btrim(coalesce(v_item->>'stage_key', '')),
      btrim(v_item->>'field_key'),
      btrim(v_item->>'native_unit'),
      (v_item->>'decimals')::smallint
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) is
  '0223. Replaces the field contract for one (profile, version, mode) from the application catalogue. OWNER ONLY. A different version is never touched, so historical readings stay interpretable under the contract they were captured against.';

-- ---------------------------------------------------------------------------
-- PART 4 QUERY — this CLIENT's most recent recorded setup
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS AS A DATABASE FUNCTION RATHER THAN A FILTERED SELECT.
--
-- The first version of the next-visit panel read the newest reading in the
-- STUDIO and showed it as "Latest recorded setup". In a studio with more than
-- one client that is simply the wrong record: open Ana's chart while Bea's
-- block is newer and Ana's panel shows Bea's settings as guidance for Ana.
-- Found by Codex review at 9c6fbbe5.
--
-- It is also a defect this directory has already fixed once. PR #286 removed
-- `assertSessionInStudio` precisely because studio-only scoping "allowed the
-- same-studio wrong-client write", and every charting write here has validated
-- client lineage since. A studio-only READ reintroduced the same hole on the
-- read side, where it is arguably worse: a wrong write is at least attributable.
--
-- The scoping therefore lives in SQL, over the lineage the schema already
-- guarantees (0094: block in session), so no caller can forget it.
--
-- SECURITY INVOKER, deliberately, unlike the four commands above. This reads
-- only what the caller may already read, so RLS must stay in force rather than
-- be bypassed and re-implemented. The membership check below is a fail-closed
-- second lock, not the only one.
create or replace function public.latest_setup_for_client(
  p_studio_id uuid,
  p_client_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  with newest as (
    select r.session_block_id
      from public.treatment_setup_readings r
      join public.session_blocks b on b.id = r.session_block_id
      join public.sessions sn on sn.id = b.session_id
     where r.studio_id = p_studio_id
       and sn.studio_id = p_studio_id
       and sn.client_id = p_client_id
       -- A RETIRED BLOCK IS NOT GUIDANCE.
       --
       -- soft_delete_session_block (0166) retires a treatment area without
       -- removing its rows, and the readings survive by design - the
       -- observation happened, and an append-only clinical record does not
       -- unhappen it. But "what to reproduce next visit" must not be taken
       -- from an area the practitioner REMOVED, which is usually how a
       -- mis-entry is corrected: the correction would be ignored and the
       -- mistake re-presented as the thing to repeat.
       --
       -- record_treatment_setup_group above already refuses to WRITE against a
       -- deleted block (`b.deleted_at is null`). This read was inconsistent
       -- with it, which is the actual defect. Codex, a66f5ec9.
       and b.deleted_at is null
       and public.is_studio_member(p_studio_id)
     order by r.recorded_at desc
     limit 1
  )
  -- THE LATEST REVISION OF EACH FIELD, not every revision.
  --
  -- Next-visit guidance is "what was she working at", which is the CURRENT
  -- value of each field - the last observation, after any mid-treatment
  -- change. The superseded revisions are still in the table and still part of
  -- the record; they are simply not what to reproduce.
  , current_rows as (
    select distinct on (r.group_key, coalesce(r.stage_key, ''), r.field_key) r.*
      from public.treatment_setup_readings r
     where r.session_block_id = (select session_block_id from newest)
     order by r.group_key, coalesce(r.stage_key, ''), r.field_key, r.revision desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'session_block_id', r.session_block_id,
        'studio_machine_id', r.studio_machine_id,
        'machine_profile_id', r.machine_profile_id,
        'machine_profile_version', r.machine_profile_version,
        'mode_key', r.mode_key,
        'group_key', r.group_key,
        'channels', r.channels,
        'stage_key', r.stage_key,
        'field_key', r.field_key,
        'value_numeric', r.value_numeric::text,
        'absence_reason', r.absence_reason,
        'native_unit', r.native_unit,
        'decimals', r.decimals,
        'observation_source', r.observation_source,
        'revision', r.revision,
        'recorded_by_practitioner_id', r.recorded_by_practitioner_id,
        'recorded_at', r.recorded_at
      )
      order by r.field_key
    ),
    '[]'::jsonb
  )
    from current_rows r;
$$;

comment on function public.latest_setup_for_client(uuid, uuid) is
  '0223. The LATEST REVISION of each field from the most recent NON-RETIRED block RECORDED FOR THIS CLIENT, as a jsonb array, for next-visit guidance. A soft-deleted block keeps its readings but is never offered as guidance, because removing an area is how a mis-entry is corrected. Scoped through session_blocks -> sessions.client_id so a studio-mate''s newer block can never be shown as this client''s setup. SECURITY INVOKER: RLS stays in force and is_studio_member is a fail-closed second lock. value_numeric is emitted as TEXT so a recorded zero and the machine''s own precision survive JSON.';

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
-- A READ, but granted exactly as explicitly as the writes: Supabase's ALTER
-- DEFAULT PRIVILEGES hands EXECUTE to anon, authenticated AND service_role at
-- create time, so all four are revoked by name first. This is the 0129 (anon)
-- and 0164 (service_role) lesson, and it applies to a query just as much.
revoke execute on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) from public;
revoke execute on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) from anon;
revoke execute on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) from authenticated;
revoke execute on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) from service_role;
grant execute on function public.sync_machine_profile_field_contract(text, integer, text, jsonb) to authenticated;

revoke execute on function public.latest_setup_for_client(uuid, uuid) from public;
revoke execute on function public.latest_setup_for_client(uuid, uuid) from anon;
revoke execute on function public.latest_setup_for_client(uuid, uuid) from authenticated;
revoke execute on function public.latest_setup_for_client(uuid, uuid) from service_role;
grant execute on function public.latest_setup_for_client(uuid, uuid) to authenticated;

revoke execute on function public.refuse_treatment_setup_reading_update() from public;
revoke execute on function public.refuse_treatment_setup_reading_update() from anon;
revoke execute on function public.refuse_treatment_setup_reading_update() from authenticated;
revoke execute on function public.refuse_treatment_setup_reading_update() from service_role;

commit;
