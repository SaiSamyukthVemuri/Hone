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

  -- CONSUME-ONLY, ENFORCED HERE AND NOT ONLY IN THE SERVER ACTION.
  --
  -- registerMachineAction checks this too, but an owner can call this RPC
  -- directly - it is granted to `authenticated` because it must resolve the
  -- caller's own ownership - and would then create a PERMANENT inventory row
  -- whose settings can never be recorded, because recording fails closed
  -- without a published contract. A boundary that only the application
  -- enforces is not a boundary.
  if not exists (
    select 1 from public.machine_profile_mode_contract c
     where c.machine_profile_id = btrim(p_machine_profile_id)
       and c.machine_profile_version = p_machine_profile_version
  ) then
    raise exception
      'No field contract is published for that machine profile version, so a unit cannot be registered against it.'
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
-- PART 3a — THE PUBLISHED CONTRACT, AND THE CAPTURE IDENTITY
-- ---------------------------------------------------------------------------
--
-- Two problems these tables exist to solve, both found by independent review of
-- the first attempt.
--
-- (1) THE CONTRACT IS A GLOBAL PRODUCT FACT, NOT STUDIO DATA. The first version
--     let any active studio owner replace the rows for a (profile, version,
--     mode) that EVERY studio records against - so one tenant's owner could
--     change the units and precision accepted everywhere, and retroactively
--     rewrite what an already-captured version meant. Publication is now
--     restricted to deployment authority, and a published version is
--     IMMUTABLE: re-publishing identical content is a no-op, different content
--     is refused. Studio owners CONSUME a contract; they never author one.
--
-- (2) A CAPTURE IS AN ATOMIC CLINICAL FACT. The first version allocated a
--     revision per FIELD, so fields of one block could sit at different
--     revisions, and retrieval took the latest of each field independently -
--     which can fabricate a composite that was never a real setting: a current
--     from one capture beside a duration from another, possibly a different
--     mode, machine or profile version. Readings now belong to a CAPTURE, one
--     revision is allocated per capture, and retrieval returns one coherent
--     capture or nothing.

-- The MODE-level half of the contract: facts that are true of a whole mode
-- rather than of one field. Separate table so a field cannot disagree with its
-- own mode about how many channels exist.
create table if not exists public.machine_profile_mode_contract (
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),

  -- How many independently controlled outputs the model has, where verified.
  -- NULL means the model does not offer channel association at all, in which
  -- case naming a channel on a reading is itself invalid.
  channels_max smallint check (channels_max is null or channels_max between 1 and 64),

  -- A mode the machine only offers when a physical option is fitted. NULL for
  -- an unconditional mode. The device's own installed_options decides.
  requires_installed_option text
    check (requires_installed_option is null
           or length(btrim(requires_installed_option)) between 1 and 60),

  published_at timestamptz not null default now(),

  constraint machine_profile_mode_contract_pkey primary key
    (machine_profile_id, machine_profile_version, mode_key)
);

comment on table public.machine_profile_mode_contract is
  '0223. The MODE-level half of the published field contract: channel count and any required installed option, for one (profile, version, mode). Separate from the field half so a field row cannot disagree with its mode about how many channels exist. Published by DEPLOYMENT authority only and immutable once published - see sync_machine_profile_contract.';

create table if not exists public.machine_profile_field_contract (
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),
  -- '' rather than NULL for a mode-level field, so the primary key works
  -- without a coalesce and a NULL cannot duplicate itself.
  stage_key text not null default '' check (length(stage_key) <= 60),
  field_key text not null check (length(btrim(field_key)) between 1 and 60),

  native_unit text not null check (length(btrim(native_unit)) between 1 and 20),
  decimals smallint not null check (decimals between 0 and 6),

  -- WHAT KIND OF QUANTITY THIS IS. The malformed-value rules are
  -- quantity-specific and live in the recording command, keyed on this - which
  -- is deliberately not a publisher-supplied "non_negative" flag, because a
  -- publisher could get that wrong and the rule would then be wrong per row
  -- rather than wrong in one reviewed place.
  quantity text not null check (quantity in (
    'current', 'duration', 'intensity', 'frequency',
    'count', 'percentage', 'energy-display', 'preset-identifier'
  )),

  published_at timestamptz not null default now(),

  constraint machine_profile_field_contract_pkey primary key
    (machine_profile_id, machine_profile_version, mode_key, stage_key, field_key),
  constraint machine_profile_field_contract_mode_fk foreign key
    (machine_profile_id, machine_profile_version, mode_key)
    references public.machine_profile_mode_contract
    (machine_profile_id, machine_profile_version, mode_key)
    on delete restrict
);

comment on table public.machine_profile_field_contract is
  '0223. The authoritative field contract: for one (profile, version, mode), which fields exist, in what native unit and precision, and what KIND of quantity each is. record_treatment_setup_group validates every reading against this and DERIVES unit and precision from it, so a direct RPC caller cannot invent a field or mislabel a unit. Created EMPTY and published by DEPLOYMENT authority; naming real models in a migration would turn model activation from an evidence review into a schema fact. Immutable once published. The FK to the mode contract means a field cannot exist without its mode.';

alter table public.machine_profile_mode_contract enable row level security;
alter table public.machine_profile_field_contract enable row level security;

-- Readable by any authenticated practitioner: it is a product contract, not
-- studio data, and the capture UI legitimately needs it. There is no studio_id
-- on either table for the same reason.
drop policy if exists "machine_profile_mode_contract_read" on public.machine_profile_mode_contract;
create policy "machine_profile_mode_contract_read"
  on public.machine_profile_mode_contract for select to authenticated
  using (true);

drop policy if exists "machine_profile_field_contract_read" on public.machine_profile_field_contract;
create policy "machine_profile_field_contract_read"
  on public.machine_profile_field_contract for select to authenticated
  using (true);

-- NO ROLE MAY WRITE EITHER TABLE DIRECTLY, including service_role. Publication
-- goes through the gated command below, which enforces immutability; a direct
-- grant would let a deployment path silently rewrite a published version and
-- defeat the point.
revoke all on public.machine_profile_mode_contract from public;
revoke all on public.machine_profile_mode_contract from anon;
revoke all on public.machine_profile_mode_contract from authenticated;
revoke all on public.machine_profile_mode_contract from service_role;
grant select on public.machine_profile_mode_contract to authenticated;
grant select on public.machine_profile_mode_contract to service_role;

revoke all on public.machine_profile_field_contract from public;
revoke all on public.machine_profile_field_contract from anon;
revoke all on public.machine_profile_field_contract from authenticated;
revoke all on public.machine_profile_field_contract from service_role;
grant select on public.machine_profile_field_contract to authenticated;
grant select on public.machine_profile_field_contract to service_role;

-- ---------------------------------------------------------------------------
-- The CAPTURE: one atomic act of recording a settings group.
-- ---------------------------------------------------------------------------
create table if not exists public.treatment_setup_captures (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_block_id uuid not null
    references public.session_blocks(id) on delete cascade,

  studio_machine_id uuid
    references public.studio_machines(id) on delete set null,
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),
  group_key text not null check (length(btrim(group_key)) between 1 and 40),
  channels smallint[] not null default '{}',

  -- 1 for the first capture of this group in this block, 2 for the next. The
  -- command allocates this under an advisory lock on (block, group), so two
  -- concurrent captures cannot collide or share a number.
  revision smallint not null check (revision >= 1),

  recorded_by_practitioner_id uuid,
  recorded_at timestamptz not null default now(),

  constraint treatment_setup_captures_revision_uniq
    unique (session_block_id, group_key, revision)
);

comment on table public.treatment_setup_captures is
  '0223. ONE ATOMIC CAPTURE of a settings group against a treatment block: which machine, which profile version, which mode, which channels, by whom, when, and which revision of that group it is. Readings hang off a capture, so a retrieved setup is always one real thing that was set at one moment rather than a per-field composite assembled from different captures. Revision is allocated per (block, group) under an advisory lock, so concurrent captures stay distinct and coherent.';

-- 0179's law: an ACTOR reference is composite and same-studio.
alter table public.treatment_setup_captures
  add constraint treatment_setup_captures_recorded_by_same_studio_fk
  foreign key (recorded_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict;

create index if not exists treatment_setup_captures_block_idx
  on public.treatment_setup_captures (session_block_id, group_key, revision desc);

create index if not exists treatment_setup_captures_studio_recorded_idx
  on public.treatment_setup_captures (studio_id, recorded_at desc);

alter table public.treatment_setup_captures enable row level security;

drop policy if exists "treatment_setup_captures_member_select" on public.treatment_setup_captures;
create policy "treatment_setup_captures_member_select"
  on public.treatment_setup_captures for select to authenticated
  using (public.is_studio_member(treatment_setup_captures.studio_id));

revoke all on public.treatment_setup_captures from public;
revoke all on public.treatment_setup_captures from anon;
revoke all on public.treatment_setup_captures from authenticated;
revoke all on public.treatment_setup_captures from service_role;
grant select on public.treatment_setup_captures to authenticated;
grant select on public.treatment_setup_captures to service_role;

-- A capture is as immutable as its readings. Changing which machine or mode a
-- recorded capture claims would rewrite the clinical meaning of every reading
-- under it.
create or replace function public.refuse_treatment_setup_capture_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'A recorded treatment setup capture is immutable. Record a new capture instead.'
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists treatment_setup_captures_immutable on public.treatment_setup_captures;
create trigger treatment_setup_captures_immutable
  before update on public.treatment_setup_captures
  for each row execute function public.refuse_treatment_setup_capture_update();

-- ---------------------------------------------------------------------------
-- Readings now belong to a capture.
-- ---------------------------------------------------------------------------
alter table public.treatment_setup_readings
  add column if not exists capture_id uuid;

-- NOT NULL, because "every reading belongs to exactly one capture" is the
-- whole point and a nullable column does not say it.
--
-- It WAS nullable, and that was a real gap rather than a style point. A direct
-- owner-level insert with no capture_id was accepted, producing an ORPHAN
-- reading that sits outside every capture's revision and outside the
-- (capture_id, stage, field) uniqueness - so it escaped both halves of the
-- coherence design at once. Not reachable from the application, because
-- `authenticated` and `service_role` hold SELECT only on this table, but an
-- invariant the schema does not enforce is an invariant the next migration can
-- quietly break. Found by the ops01 lane's gate-open run.
--
-- Asserted with a separate statement so a database that already applied the
-- nullable version is corrected rather than left alone by `if not exists`. On
-- a fresh chain the table is empty here, so there is nothing to backfill; on a
-- stack that already holds an orphan this fails LOUDLY, which is the right
-- outcome - it is telling you about a row that should not exist.
alter table public.treatment_setup_readings
  alter column capture_id set not null;

-- AND THE DENORMALISED COLUMNS MAY NOT DIVERGE FROM THEIR CAPTURE.
--
-- Readings carry studio_id, session_block_id, mode_key, group_key, channels and
-- revision for query convenience, all of which the capture also holds. The
-- deeper risk of that duplication is not an orphan but DISAGREEMENT: a reading
-- claiming a different block or revision from the capture it belongs to would
-- make "one coherent capture" false while every row looked individually valid.
--
-- A composite foreign key makes the four that matter agree BY CONSTRUCTION
-- rather than because the command happens to set them from the same variables.
-- The unique constraint exists to support it; `id` is already the primary key,
-- so it adds no new restriction, only the index the reference needs.
alter table public.treatment_setup_captures
  drop constraint if exists treatment_setup_captures_identity_uniq;
alter table public.treatment_setup_captures
  add constraint treatment_setup_captures_identity_uniq
  unique (id, session_block_id, studio_id, revision);

alter table public.treatment_setup_readings
  drop constraint if exists treatment_setup_readings_capture_fk;
alter table public.treatment_setup_readings
  add constraint treatment_setup_readings_capture_fk
  foreign key (capture_id, session_block_id, studio_id, revision)
  references public.treatment_setup_captures
    (id, session_block_id, studio_id, revision)
  on delete cascade;

comment on column public.treatment_setup_readings.capture_id is
  '0223. The atomic capture this reading belongs to. NOT NULL, and part of a composite foreign key with session_block_id, studio_id and revision - so a reading cannot be an orphan, and cannot disagree with its own capture about which block, studio or revision it belongs to. That is what makes a retrieved setup one coherent thing rather than a per-field composite.';

-- One row per field PER CAPTURE. This replaces keying by field coordinates
-- plus a per-field revision, which is what allowed fields of one block to sit
-- at different revisions.
drop index if exists public.treatment_setup_readings_field_revision_uniq;
drop index if exists public.treatment_setup_readings_latest_idx;

create unique index if not exists treatment_setup_readings_capture_field_uniq
  on public.treatment_setup_readings
     (capture_id, coalesce(stage_key, ''), field_key);

create index if not exists treatment_setup_readings_capture_idx
  on public.treatment_setup_readings (capture_id);

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
  v_installed text[];
  v_count integer := 0;
  v_item jsonb;
  -- Derived per reading from the published contract, never accepted from input.
  v_stage text;
  v_field text;
  v_unit text;
  v_decimals smallint;
  v_quantity text;
  v_value numeric;
  v_absence text;
  v_source text;
  -- Mode-level contract facts.
  v_channels_max smallint;
  v_requires_option text;
  -- The ONE capture this call creates.
  v_capture uuid;
  v_revision smallint;
  v_group text;
  v_mode text;
  v_channel smallint;
begin
  -- A NON-EMPTY array, and the emptiness check is not cosmetic.
  --
  -- An empty array previously allocated a capture with no readings and
  -- returned 0. Because `latest_setup_for_client` picks the NEWEST capture and
  -- then aggregates its rows, that empty capture became the newest and made
  -- valid prior guidance vanish as `[]` - a direct authenticated call could
  -- erase a client's next-visit setup without deleting anything. The server
  -- action already refused this; the command has to as well.
  if p_readings is null or jsonb_typeof(p_readings) <> 'array'
     or jsonb_array_length(p_readings) = 0 then
    raise exception 'At least one reading is required.'
      using errcode = 'check_violation';
  end if;

  -- The block decides the studio. Nothing the caller sends does.
  --
  -- RESOLVED THROUGH ITS SESSION, and both records must be live. Checking only
  -- `b.deleted_at` was not enough: `soft_delete_session` (0167) stamps
  -- `sessions.deleted_at` and leaves the child blocks alone, so a retired
  -- session keeps live-looking blocks. A stale page or a crafted call could
  -- then append an IMMUTABLE capture to a session that had been removed -
  -- unamendable by construction, and attached to a record nobody can see.
  select b.studio_id into v_studio
    from public.session_blocks b
    join public.sessions sn on sn.id = b.session_id
   where b.id = p_block_id
     and b.deleted_at is null
     and sn.deleted_at is null;

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

  select m.studio_id, m.machine_profile_id, m.machine_profile_version,
         m.retired_at, m.installed_options
    into v_machine_studio, v_profile_id, v_profile_version,
         v_retired, v_installed
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

  v_group := btrim(coalesce(p_group_key, ''));
  v_mode := btrim(coalesce(p_mode_key, ''));
  if v_group = '' or v_mode = '' then
    raise exception 'A mode and a settings group are required.'
      using errcode = 'check_violation';
  end if;

  -- THE CONTRACT MUST BE PUBLISHED, AND IT FAILS CLOSED.
  --
  -- A profile version with no published contract cannot be validated, so it
  -- cannot be recorded. Recording unvalidated whenever the contract happens to
  -- be missing would make the whole check decorative, because the bypass would
  -- be "do not publish".
  select c.channels_max, c.requires_installed_option
    into v_channels_max, v_requires_option
    from public.machine_profile_mode_contract c
   where c.machine_profile_id = v_profile_id
     and c.machine_profile_version = v_profile_version
     and c.mode_key = v_mode;

  if not found then
    raise exception
      'No field contract is published for this machine profile version and mode, so its settings cannot be recorded.'
      using errcode = 'check_violation';
  end if;

  -- THE MODE MAY REQUIRE A PHYSICAL OPTION THIS UNIT DOES NOT HAVE.
  -- The profile describes the model; the device records what is actually
  -- fitted, and the device wins.
  if v_requires_option is not null
     and not (v_requires_option = any (coalesce(v_installed, '{}'::text[]))) then
    raise exception
      'This machine does not have the % option fitted, so its % mode cannot be recorded.',
      v_requires_option, v_mode
      using errcode = 'check_violation';
  end if;

  -- CHANNELS MUST BE REAL CHANNELS OF THIS MODEL.
  -- NULL channels_max means the model offers no channel association at all, so
  -- naming one is itself invalid rather than merely out of range.
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
    -- A repeated channel would make the group's identity ambiguous.
    if (select count(distinct ch) from unnest(p_channels) ch)
       <> array_length(p_channels, 1) then
      raise exception 'A channel is named more than once.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ALLOCATE ONE CAPTURE FOR THIS WHOLE CALL, SAFELY UNDER CONCURRENCY.
  --
  -- The revision belongs to the CAPTURE, not to each field: allocating per
  -- field let one block's fields sit at different revisions, and a per-field
  -- "latest" could then assemble a composite that was never a real setting.
  --
  -- The advisory lock is transaction-scoped and keyed on (block, group), so two
  -- concurrent captures of the same group serialise here and get distinct
  -- consecutive revisions rather than colliding on the unique constraint or
  -- both reading the same max. It is released at commit or rollback.
  perform pg_advisory_xact_lock(
    hashtextextended(p_block_id::text || ':' || v_group, 0)
  );

  select coalesce(max(c.revision), 0) + 1
    into v_revision
    from public.treatment_setup_captures c
   where c.session_block_id = p_block_id
     and c.group_key = v_group;

  insert into public.treatment_setup_captures (
    studio_id, session_block_id, studio_machine_id,
    machine_profile_id, machine_profile_version, mode_key,
    group_key, channels, revision, recorded_by_practitioner_id
  )
  values (
    v_studio, p_block_id, p_studio_machine_id,
    -- The profile identity is copied from the UNIT at record time, so a later
    -- re-registration cannot retroactively change what a capture was made
    -- under.
    v_profile_id, v_profile_version, v_mode,
    v_group, coalesce(p_channels, '{}'), v_revision, v_pract
  )
  returning id into v_capture;

  for v_item in select jsonb_array_elements(p_readings)
  loop
    -- VALIDATE AND DERIVE. The caller says WHICH field and WHAT it read; the
    -- field's native unit, precision and quantity come from the published
    -- contract, never from the caller.
    v_stage := btrim(coalesce(v_item->>'stage_key', ''));
    v_field := btrim(coalesce(v_item->>'field_key', ''));

    select c.native_unit, c.decimals, c.quantity
      into v_unit, v_decimals, v_quantity
      from public.machine_profile_field_contract c
     where c.machine_profile_id = v_profile_id
       and c.machine_profile_version = v_profile_version
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

    -- THE OBSERVATION SOURCE IS A CLOSED SET, checked here rather than relying
    -- only on the column constraint, so a forged call fails with a sentence
    -- about the reading instead of a constraint name.
    v_source := btrim(coalesce(v_item->>'observation_source', ''));
    if v_source not in ('practitioner-entered', 'machine-displayed',
                        'device-computed', 'estimated') then
      raise exception '"%" is not a recognised way of observing a reading.',
        v_source
        using errcode = 'check_violation';
    end if;

    v_absence := nullif(btrim(coalesce(v_item->>'absence_reason', '')), '');
    v_value := case when v_item->>'value' is null then null
                    else (v_item->>'value')::numeric end;

    -- EXACTLY ONE OF value / absence_reason. The table's XOR constraint says
    -- this too; saying it here makes a forged call fail with a sentence.
    if (v_value is null) = (v_absence is null) then
      raise exception
        'Field "%" needs either a value or a reason it was not recorded, and not both.',
        v_field
        using errcode = 'check_violation';
    end if;

    if v_value is not null then
      -- A NaN numeric is storable and meaningless. There is no infinity in
      -- `numeric`, so NaN is the whole of the finiteness check.
      if v_value = 'NaN'::numeric then
        raise exception 'Field "%" was given a value that is not a number.',
          v_field using errcode = 'check_violation';
      end if;

      -- QUANTITY-SPECIFIC MALFORMED-VALUE RULES.
      --
      -- Deliberately NOT a blanket non-negativity rule, and deliberately NO
      -- upper bound: a manufacturer's advisory ceiling is advisory, and
      -- refusing a reading the machine actually displayed would destroy the
      -- record rather than protect it. These are definitional only.
      if v_quantity in ('current', 'duration', 'frequency', 'count',
                        'percentage', 'intensity', 'energy-display')
         and v_value < 0 then
        raise exception
          'Field "%" is a % and cannot be negative.', v_field, v_quantity
          using errcode = 'check_violation';
      end if;

      -- A count is a whole number by definition.
      if v_quantity = 'count' and v_value <> trunc(v_value) then
        raise exception 'Field "%" is a count and must be a whole number.',
          v_field using errcode = 'check_violation';
      end if;

      -- The value may not carry more precision than the machine can display.
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
      value_numeric, absence_reason,
      native_unit, decimals, observation_source,
      revision, recorded_by_practitioner_id
    )
    values (
      v_capture,
      v_studio, p_block_id, p_studio_machine_id,
      v_profile_id, v_profile_version, v_mode,
      v_group, coalesce(p_channels, '{}'),
      nullif(v_stage, ''),
      v_field,
      v_value,
      v_absence,
      -- DERIVED, all three.
      v_unit,
      v_decimals,
      v_source,
      -- The CAPTURE's revision, identical for every field in this call.
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
-- PART 3b — PUBLISHING A CONTRACT: deployment authority, and immutable
-- ---------------------------------------------------------------------------
--
-- WHO MAY PUBLISH, AND WHY NOT A STUDIO OWNER.
--
-- The first version of this granted EXECUTE to `authenticated` and checked
-- only that the caller was an active owner of SOME studio. The contract is
-- global, so that let one tenant's owner delete and replace the rows every
-- other tenant records against - changing the units and precision accepted
-- across the whole deployment, and rewriting the meaning of a version under
-- which readings had already been captured. A per-tenant actor had authority
-- over a cross-tenant fact.
--
-- So: EXECUTE is revoked from `authenticated` entirely and granted only to
-- `service_role`, which is deployment authority rather than any user. A studio
-- owner CONSUMES a published contract (registration refuses a profile version
-- that has none); she never authors one.
--
-- This is not a service-role clinical-writing bypass. service_role still holds
-- no EXECUTE on record_treatment_setup_group and only SELECT on every clinical
-- table, so it cannot write a reading, a capture or a machine. Publishing a
-- product contract is a different act from recording a treatment.
--
-- AND A PUBLISHED VERSION IS IMMUTABLE. Re-publishing byte-identical content
-- is a no-op so a deployment can run idempotently; publishing DIFFERENT content
-- for a version that already exists is refused. Correcting a contract means
-- publishing a NEW version, which is what keeps already-captured readings
-- interpretable under the contract they were captured against.
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

  -- NO FIELD MAY BE LISTED TWICE, on a FIRST publication or a republish.
  --
  -- Checked before the published/not-published split because it guards both.
  -- On a republish it is what broke the comparison that used to live below:
  -- that version counted matches and compared counts both ways, which a
  -- DUPLICATE element defeats - against published {A, B}, an incoming [A, A]
  -- gives matches = 2, incoming = 2 and published = 2, so dropping B was
  -- accepted as an idempotent no-op. Counting is not comparing.
  --
  -- On a FIRST publication the primary key would catch it anyway, but with a
  -- constraint name instead of a sentence, and only after the mode row had
  -- been inserted.
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
    -- ALREADY PUBLISHED. Identical content is a no-op; anything else refuses.
    if coalesce(v_existing_mode.channels_max, -1) <> coalesce(p_channels_max, -1)
       or coalesce(v_existing_mode.requires_installed_option, '')
          <> coalesce(v_option, '') then
      raise exception
        'This machine profile version and mode is already published with different mode facts. Publish a NEW version instead of changing a published one.'
        using errcode = 'restrict_violation';
    end if;

    -- EXACT SET EQUALITY, in both directions, on the FULL content of every
    -- field - not on counts. An extra field, a missing field or a changed unit
    -- or precision all land in one side of the symmetric difference.
    select count(*) into v_diff
      from (
        (select btrim(coalesce(f->>'stage_key', '')) as stage_key,
                btrim(coalesce(f->>'field_key', '')) as field_key,
                btrim(coalesce(f->>'native_unit', '')) as native_unit,
                (f->>'decimals')::smallint as decimals,
                btrim(coalesce(f->>'quantity', '')) as quantity
           from jsonb_array_elements(p_fields) as f)
        except
        (select c.stage_key, c.field_key, c.native_unit, c.decimals, c.quantity
           from public.machine_profile_field_contract c
          where c.machine_profile_id = v_profile
            and c.machine_profile_version = p_machine_profile_version
            and c.mode_key = v_mode)
      ) only_incoming;

    select v_diff + count(*) into v_diff
      from (
        (select c.stage_key, c.field_key, c.native_unit, c.decimals, c.quantity
           from public.machine_profile_field_contract c
          where c.machine_profile_id = v_profile
            and c.machine_profile_version = p_machine_profile_version
            and c.mode_key = v_mode)
        except
        (select btrim(coalesce(f->>'stage_key', '')) as stage_key,
                btrim(coalesce(f->>'field_key', '')) as field_key,
                btrim(coalesce(f->>'native_unit', '')) as native_unit,
                (f->>'decimals')::smallint as decimals,
                btrim(coalesce(f->>'quantity', '')) as quantity
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
    insert into public.machine_profile_field_contract (
      machine_profile_id, machine_profile_version, mode_key,
      stage_key, field_key, native_unit, decimals, quantity
    )
    values (
      v_profile,
      p_machine_profile_version,
      v_mode,
      btrim(coalesce(v_item->>'stage_key', '')),
      btrim(v_item->>'field_key'),
      btrim(v_item->>'native_unit'),
      (v_item->>'decimals')::smallint,
      btrim(v_item->>'quantity')
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) is
  '0223. Publishes the field contract for one (profile, version, mode) from the reviewed application catalogue. DEPLOYMENT AUTHORITY ONLY - EXECUTE is granted to service_role and revoked from authenticated, because the contract is a global product fact and a studio owner must not be able to change what other studios record against. IMMUTABLE once published: identical content is an idempotent no-op, different content is refused, and correcting a contract means publishing a NEW version so already-captured readings stay interpretable. Not a clinical-write bypass: service_role still holds no EXECUTE on record_treatment_setup_group and only SELECT on every clinical table.';

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
  -- ONE COHERENT CAPTURE, OR NOTHING.
  --
  -- The first version returned the latest revision of each FIELD independently,
  -- which can assemble a setup that never existed: a current from one capture
  -- beside a duration from another, possibly under a different mode, machine or
  -- profile version. Next-visit guidance has to be a real thing that was
  -- actually set at one moment, so this picks the newest CAPTURE and returns
  -- exactly its readings.
  --
  -- A field the practitioner did not record in that capture is therefore simply
  -- ABSENT from the result. It is never filled in from an older capture, which
  -- is the behaviour that would quietly invent a setting.
  with newest_capture as (
    select c.id, c.studio_machine_id, c.machine_profile_id,
           c.machine_profile_version, c.mode_key, c.group_key, c.channels,
           c.revision, c.recorded_by_practitioner_id, c.recorded_at
      from public.treatment_setup_captures c
      join public.session_blocks b on b.id = c.session_block_id
      join public.sessions sn on sn.id = b.session_id
     where c.studio_id = p_studio_id
       and sn.studio_id = p_studio_id
       and sn.client_id = p_client_id
       -- A RETIRED BLOCK OR A RETIRED SESSION IS NOT GUIDANCE.
       --
       -- soft_delete_session_block (0166) retires a treatment area and
       -- soft_delete_session (0167) retires a whole session; each leaves its
       -- rows and its children alone. Removing either is usually how a
       -- mis-entry is CORRECTED, so offering one back would ignore the
       -- correction and re-present the mistake as the thing to reproduce.
       --
       -- Filtering only the BLOCK was the gap: a removed session kept
       -- live-looking blocks, so its newest capture stayed eligible.
       and b.deleted_at is null
       and sn.deleted_at is null
       and public.is_studio_member(p_studio_id)
     order by c.recorded_at desc, c.revision desc
     limit 1
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
    from public.treatment_setup_readings r
   where r.capture_id = (select id from newest_capture);
$$;

comment on function public.latest_setup_for_client(uuid, uuid) is
  '0223. The readings of ONE COHERENT CAPTURE - the most recent capture in a NON-RETIRED block RECORDED FOR THIS CLIENT - as a jsonb array, for next-visit guidance. Deliberately NOT the latest revision of each field independently: that can assemble a setup that never existed, mixing fields from different capture times, modes, machines or profile versions. A field absent from that capture is absent from the result and is never filled in from an older one. Scoped through session_blocks -> sessions.client_id so a studio-mate''s newer capture can never be shown as this client''s setup. SECURITY INVOKER: RLS stays in force and is_studio_member is a fail-closed second lock. value_numeric is emitted as TEXT so a recorded zero and the machine''s own precision survive JSON.';

-- ---------------------------------------------------------------------------
-- CHRONOLOGICAL HISTORY — the captures themselves, not just the rows
-- ---------------------------------------------------------------------------
--
-- Append-only storage is not the same as an exposed history. This returns the
-- captures of one block oldest-first, each with what it was recorded under, so
-- a superseded setting is visible as a moment in the treatment rather than
-- merely present in the table.
create or replace function public.setup_capture_history_for_block(
  p_block_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'capture_id', c.id,
        'group_key', c.group_key,
        'revision', c.revision,
        'studio_machine_id', c.studio_machine_id,
        'machine_profile_id', c.machine_profile_id,
        'machine_profile_version', c.machine_profile_version,
        'mode_key', c.mode_key,
        'channels', c.channels,
        'recorded_by_practitioner_id', c.recorded_by_practitioner_id,
        'recorded_at', c.recorded_at,
        'field_count', (
          select count(*) from public.treatment_setup_readings r
           where r.capture_id = c.id
        )
      )
      order by c.recorded_at, c.group_key, c.revision
    ),
    '[]'::jsonb
  )
    from public.treatment_setup_captures c
    join public.session_blocks b on b.id = c.session_block_id
    join public.sessions sn on sn.id = b.session_id
   where c.session_block_id = p_block_id
     -- Same retirement rule as guidance, for the same reason and so the two
     -- cannot disagree about whether a block still exists.
     and b.deleted_at is null
     and sn.deleted_at is null
     and public.is_studio_member(c.studio_id);
$$;

comment on function public.setup_capture_history_for_block(uuid) is
  '0223. The captures of one treatment block, oldest first, each with the machine, profile version, mode, channels, recorder, instant and field count it was recorded under. Exposes the CHRONOLOGY of a treatment rather than only the storage rows: a setting changed mid-treatment appears as two captures in order. SECURITY INVOKER, with is_studio_member as a fail-closed second lock.';

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
-- PUBLICATION IS DEPLOYMENT AUTHORITY. `authenticated` is revoked and NOT
-- granted back: a studio owner consumes a contract, she does not author one.
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from public;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from anon;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from authenticated;
revoke execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) from service_role;
grant execute on function public.sync_machine_profile_contract(text, integer, text, smallint, text, jsonb) to service_role;

revoke execute on function public.setup_capture_history_for_block(uuid) from public;
revoke execute on function public.setup_capture_history_for_block(uuid) from anon;
revoke execute on function public.setup_capture_history_for_block(uuid) from authenticated;
revoke execute on function public.setup_capture_history_for_block(uuid) from service_role;
grant execute on function public.setup_capture_history_for_block(uuid) to authenticated;

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
