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
  v_id     uuid;
begin
  select m.studio_id
    into v_studio
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
  -- CONDITIONAL, so two overlapping retirements cannot both claim the work.
  --
  -- This read `retired_at` with a plain select and then updated by id. Two
  -- requests could both observe NULL, both run their update, and the second
  -- would overwrite the first's recorded retirement INSTANT while also
  -- returning true - so the stamped time belonged to neither request and the
  -- documented idempotence ("returns false if it was already retired") was not
  -- true under concurrency (Codex, d3e8b17b).
  --
  -- The fix is the predicate, not another lock. The UPDATE's own row lock IS
  -- the serialisation point: under READ COMMITTED the loser blocks, then
  -- re-evaluates `retired_at is null` against the committed new version and
  -- matches nothing. The return value is then derived from the row actually
  -- affected rather than from a read that may already be stale. Adding FOR
  -- UPDATE above would serialise the same pair at more cost and still leave
  -- the return value derived from the earlier read.
  --
  -- studio_machines before practitioners, which is this migration's stated
  -- order - see record_treatment_setup_group.
  update public.studio_machines
     set retired_at = now()
   where id = p_machine_id
     and retired_at is null
  returning id into v_id;

  if v_id is null then
    -- Already out of service. Nothing changed, and nothing is cleared below:
    -- whichever request won did that, and re-running the cleanup could undo a
    -- default legitimately set against ANOTHER machine since.
    return false;
  end if;

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
    -- LOCKED BEFORE VALIDATED, and before the practitioners UPDATE below.
    --
    -- Unlocked, this command could observe the machine live, have
    -- `retire_studio_machine` commit - which retires the unit AND clears it
    -- from every practitioner default - and then write it back as a default.
    -- The retirement's own cleanup would be undone by a command that started
    -- earlier, leaving a remembered machine that is out of service.
    --
    -- MACHINE BEFORE PRACTITIONER is retirement's own order (it stamps
    -- `retired_at`, then clears the defaults), so the two serialise rather
    -- than cycle. FOR SHARE, not FOR KEY SHARE: `retired_at` is a non-key
    -- UPDATE taking FOR NO KEY UPDATE, which FOR KEY SHARE does not conflict
    -- with.
    perform 1 from public.studio_machines m where m.id = p_machine_id for share;

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

  -- REQUIRED, AND THE UNIT CANNOT BE ERASED WHILE IT IS CITED.
  --
  -- This was nullable with ON DELETE SET NULL, the stated reason being that
  -- hard-deleting a retired unit must not orphan a clinical reading. That
  -- never worked: the append-only trigger on treatment_setup_readings refuses
  -- EVERY update, including the system-driven one a SET NULL performs, so
  -- deleting a cited unit failed with "A recorded treatment setup reading is
  -- immutable" instead. Two guarantees written against each other, and the
  -- nullability was buying nothing.
  --
  -- RESTRICT states the real rule: a unit with recorded readings is part of
  -- the clinical record and is retired, never erased. `retire_studio_machine`
  -- is the supported path and is unaffected - it stamps `retired_at` and
  -- deletes nothing. A unit registered by mistake, with no readings, can still
  -- be deleted.
  --
  -- NOT NULL matches what the command already enforces ("Choose the machine
  -- before recording settings") and, because nothing here is nullable, lets
  -- the composite FK below be ONE constraint: a MATCH SIMPLE composite key
  -- skips its ENTIRE check when any referencing column is NULL, so a nullable
  -- member would have meant a null machine id switching off every other
  -- column's enforcement too.
  studio_machine_id uuid not null
    references public.studio_machines(id) on delete restrict,
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

  -- Required and non-erasable, for the reasons given on
  -- treatment_setup_readings.studio_machine_id above.
  studio_machine_id uuid not null
    references public.studio_machines(id) on delete restrict,
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
-- EVERY duplicated setup-identity column: ten, not the four I first guessed
-- at, and not the nine of the second attempt either - `studio_machine_id` was
-- the last one left free, so a reading could still name a different PHYSICAL
-- unit from its own capture while every other column agreed. The two read
-- paths disagree about which they report (`latest_setup_for_client` takes it
-- from the READING, `setup_capture_history_for_block` from the CAPTURE), which
-- is the same contradiction this constraint exists to prevent
-- (Codex, 87c88017).
--
-- It is ONE constraint rather than a nine-column one plus a machine one
-- because the column is now NOT NULL; see its definition for why that matters
-- to a MATCH SIMPLE composite key.
--
-- The first version of this covered (capture_id, session_block_id, studio_id,
-- revision) and left machine_profile_id, machine_profile_version, mode_key,
-- group_key and channels unconstrained. I flagged that choice as a judgement
-- in the review request, and it was the wrong one: with those free, a reading
-- could name a different machine, profile version, mode or channel set from
-- its own capture. That matters because the two read paths disagree about
-- where identity comes from - `latest_setup_for_client` emits it from the
-- READING, `setup_capture_history_for_block` from the CAPTURE - so one
-- supposedly coherent capture could be interpreted as two different machine
-- setups depending on which function you asked.
--
-- My own positive-control test demonstrated the hole: it inserted a reading
-- with profile 'x' against a real capture and the FK accepted it.
alter table public.treatment_setup_captures
  drop constraint if exists treatment_setup_captures_identity_uniq;
alter table public.treatment_setup_captures
  add constraint treatment_setup_captures_identity_uniq
  unique (id, session_block_id, studio_id, revision,
          studio_machine_id, machine_profile_id, machine_profile_version,
          mode_key, group_key, channels);

alter table public.treatment_setup_readings
  drop constraint if exists treatment_setup_readings_capture_fk;
alter table public.treatment_setup_readings
  add constraint treatment_setup_readings_capture_fk
  foreign key (capture_id, session_block_id, studio_id, revision,
               studio_machine_id, machine_profile_id, machine_profile_version,
               mode_key, group_key, channels)
  references public.treatment_setup_captures
    (id, session_block_id, studio_id, revision,
     studio_machine_id, machine_profile_id, machine_profile_version,
     mode_key, group_key, channels)
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
-- ===========================================================================
-- PART 6 - public.treatment_setup_submissions: ONE SAVE, as a fact
-- ===========================================================================
--
-- WHY THIS EXISTS. `record_treatment_setup_group` records ONE group per call,
-- which was right while a setup meant one group. Once the entry surface could
-- record several, a Save became several independent calls - and nothing in the
-- database tied them together. Three invariants were unreachable as a result
-- (Codex, #860 6157725545):
--
--   * ATOMICITY. Two calls can half-succeed, leaving a block with one group of
--     a two-group setup and no record that a second was ever intended.
--   * CROSS-GROUP CHANNEL EXCLUSIVITY. Each call carries its own
--     duplicate-free channel array, so two calls claiming probe 2 are two
--     individually VALID calls. The database cannot see them as related, so a
--     UI check was the only guard - and a UI check is bypassable by anything
--     that calls the RPC directly.
--   * IDEMPOTENCY AFTER A LOST RESPONSE. With no identity for the Save, a
--     retry cannot be distinguished from a genuine second capture, so the
--     honest UI behaviour was to refuse to retry at all.
--
-- A SUBMISSION IS NOT A NEW CLINICAL CONCEPT. It is the boundary that already
-- existed in the practitioner's action - she pressed Save once - and simply
-- had no representation. Each capture keeps its own revision, timestamp and
-- source exactly as before; this records which Save produced it.
--
-- A MACHINE OR MODE SWITCH IS A DIFFERENT SUBMISSION by construction: the
-- machine and mode are columns here, so a Save under a different one cannot
-- join an earlier submission. That is what stops a stale group reappearing
-- when she returns to a machine she had left.
create table if not exists public.treatment_setup_submissions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  session_block_id uuid not null
    references public.session_blocks(id) on delete cascade,

  -- The setup identity this Save was made under. Denormalised from the
  -- captures deliberately: it is what makes "a different machine is a
  -- different submission" a schema fact rather than a convention.
  studio_machine_id uuid not null
    references public.studio_machines(id) on delete restrict,
  machine_profile_id text not null
    check (length(btrim(machine_profile_id)) between 1 and 120),
  machine_profile_version integer not null check (machine_profile_version >= 1),
  mode_key text not null check (length(btrim(mode_key)) between 1 and 60),

  -- THE RETRY KEY, supplied by the caller.
  --
  -- A lost response leaves the caller unable to tell a committed write from a
  -- dropped one. With this, a repeat of the SAME Save returns the original
  -- submission instead of creating a second one - so a retry is safe without
  -- being a blind replay. It is scoped per block, because a key is only ever
  -- reused by the form that generated it.
  idempotency_key text not null
    check (length(btrim(idempotency_key)) between 8 and 100),

  recorded_by_practitioner_id uuid,
  recorded_at timestamptz not null default now(),

  constraint treatment_setup_submissions_idempotency_uniq
    unique (session_block_id, idempotency_key)
);

comment on table public.treatment_setup_submissions is
  '0223. ONE Save of machine settings, tying together the setting-group captures it produced. Records the setup identity the Save was made under (unit, profile version, mode), so a Save under a different machine or mode is necessarily a different submission and a stale group cannot reappear when a practitioner returns to a machine she had left. `idempotency_key` makes a retry after a LOST RESPONSE safe: repeating the same Save returns the original submission rather than appending a second capture. Each capture keeps its own revision, timestamp and observation source; this does not flatten them and must never be read as "all observed at one instant".';

create index if not exists treatment_setup_submissions_block_idx
  on public.treatment_setup_submissions (session_block_id, recorded_at desc);

-- Direct DML is revoked from every runtime role, as for every other clinical
-- table here: the command is the only writer.
alter table public.treatment_setup_submissions enable row level security;
revoke all on public.treatment_setup_submissions from public;
revoke all on public.treatment_setup_submissions from anon;
revoke all on public.treatment_setup_submissions from authenticated;
revoke all on public.treatment_setup_submissions from service_role;
grant select on public.treatment_setup_submissions to authenticated;
grant select on public.treatment_setup_submissions to service_role;

drop policy if exists treatment_setup_submissions_member_select
  on public.treatment_setup_submissions;
create policy treatment_setup_submissions_member_select
  on public.treatment_setup_submissions
  for select
  to authenticated
  using (public.is_studio_member(studio_id));

-- The capture's link to the Save that produced it.
--
-- NULLABLE, and this is the one place a null is meaningful: captures written
-- by `record_treatment_setup_group` before this extension existed have no
-- submission, and a historical row must not be invented one. A null means
-- "recorded as a single group, before submissions" - not "unknown".
alter table public.treatment_setup_captures
  add column if not exists setup_submission_id uuid
  references public.treatment_setup_submissions(id) on delete restrict;

create index if not exists treatment_setup_captures_submission_idx
  on public.treatment_setup_captures (setup_submission_id);

comment on column public.treatment_setup_captures.setup_submission_id is
  '0223. The Save that produced this capture, or NULL for a capture recorded as a single group before submissions existed. A null is a HISTORICAL FACT, not missing data, and must not be backfilled by guessing which captures were once saved together.';


-- ---------------------------------------------------------------------------
-- PART 3 SHARED SCOPE — the checks EVERY setup write makes, in one place
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS A FUNCTION AND NOT A SECOND COPY. Recording a settings group
-- and recording a whole submission need identical answers to identical
-- questions: which studio does this block belong to, is the session and the
-- block still live, is the caller a member, does this machine belong to that
-- studio, is it in service, and which profile version is it on. A second
-- implementation of those checks is a second place for them to drift, and a
-- validation rule that exists twice is one that will eventually disagree with
-- itself. One definition, two callers.
--
-- IT TAKES THE LOCKS, AND THEREFORE IT IS CALLED EXACTLY ONCE PER WRITE.
-- Calling it per group would retake the same three row locks for every group
-- in a submission - harmless but pointless - and, more importantly, would
-- re-read liveness between groups, so a session retired mid-submission could
-- leave the first group written and the second refused. Called once, every
-- group in a submission is written under one consistent, locked scope.
--
-- THE LOCK ORDER IS THE MIGRATION'S ORDER, unchanged:
--     sessions -> session_blocks -> studio_machines -> practitioners
-- Moving the locks here is what makes that order impossible to get wrong in a
-- new command: a caller cannot take them in a different sequence, because it
-- does not take them at all.
create or replace function public.assert_setup_scope(
  p_block_id uuid,
  p_studio_machine_id uuid,
  out o_studio uuid,
  out o_practitioner uuid,
  out o_profile_id text,
  out o_profile_version integer,
  out o_installed_options text[]
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_session_id uuid;
  v_machine_studio uuid;
  v_retired timestamptz;
begin
  -- The block decides the studio. Nothing the caller sends does.
  --
  -- RESOLVED THROUGH ITS SESSION, and both records must be live. Checking only
  -- `b.deleted_at` was not enough: `soft_delete_session` (0167) stamps
  -- `sessions.deleted_at` and leaves the child blocks alone, so a retired
  -- session keeps live-looking blocks. A stale page or a crafted call could
  -- then append an IMMUTABLE capture to a session that had been removed -
  -- unamendable by construction, and attached to a record nobody can see.
  -- LOCK BOTH PARENTS IN A FIXED ORDER, THEN RE-CHECK LIVENESS.
  --
  -- Reading that two rows are live is not the same as holding them that way. A
  -- plain lookup can observe both live and then have the retirement
  -- transaction commit before this capture inserts, leaving an IMMUTABLE
  -- capture attached to a record retired a millisecond later - the exact state
  -- the check exists to prevent. Small window, permanent consequence.
  --
  -- PARENT BEFORE CHILD: session, then block. Not a new convention - 0166's
  -- `assert_block_in_session` already states it in as many words ("Parent
  -- (session) is resolved first, then the block - a stable order, so two
  -- concurrent commands cannot deadlock against each other"), and this follows
  -- it rather than leaving the order to the planner.
  --
  -- The cycle cannot form against today's retirement commands either way:
  -- `soft_delete_session` (0167) updates only `sessions` and
  -- `soft_delete_session_block` (0166) only `session_blocks`, so neither holds
  -- one while waiting for the other. A future command touching both is the
  -- hazard the fixed order is for.
  --
  -- FOR SHARE, not FOR KEY SHARE. Retirement stamps `deleted_at`, a non-key
  -- UPDATE, which takes FOR NO KEY UPDATE on the row. FOR KEY SHARE does NOT
  -- conflict with that, so it would let retirement proceed underneath us - a
  -- lock that reads as protection without being one.
  select b.session_id into v_session_id
    from public.session_blocks b
   where b.id = p_block_id;

  if v_session_id is null then
    raise exception 'Unknown treatment block.' using errcode = 'no_data_found';
  end if;

  perform 1 from public.sessions s where s.id = v_session_id for share;
  perform 1 from public.session_blocks b where b.id = p_block_id for share;

  -- RE-CHECKED AFTER THE LOCKS ARE HELD, in its own statement, so the liveness
  -- this proceeds on is the state at lock time rather than at first read. A
  -- retirement that committed while we waited is seen here and refused.
  select b.studio_id into o_studio
    from public.session_blocks b
    join public.sessions sn on sn.id = b.session_id
   where b.id = p_block_id
     and b.deleted_at is null
     and sn.deleted_at is null;

  if o_studio is null then
    raise exception 'Unknown treatment block.' using errcode = 'no_data_found';
  end if;

  o_practitioner := public.own_practitioner_in_studio(o_studio);
  if o_practitioner is null then
    raise exception 'Not an active member of this studio.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Machine first: a reading without a machine cannot be reproduced, so the
  -- unit is required and must belong to the block's own studio.
  if p_studio_machine_id is null then
    raise exception 'Choose the machine before recording settings.'
      using errcode = 'check_violation';
  end if;

  -- THE MACHINE IS LOCKED TOO, for the same reason the parents are.
  --
  -- The first repair of this command locked the session and the block and
  -- stopped there, which left the identical hole one table over: unlocked,
  -- `retire_studio_machine` can commit between this lookup and the insert
  -- below, and the capture is IMMUTABLE, so a setup is permanently recorded
  -- against a unit that was out of service when it was written
  -- (Codex, 87c88017).
  perform 1 from public.studio_machines m
   where m.id = p_studio_machine_id for share;

  select m.studio_id, m.machine_profile_id, m.machine_profile_version,
         m.retired_at, m.installed_options
    into v_machine_studio, o_profile_id, o_profile_version,
         v_retired, o_installed_options
    from public.studio_machines m
   where m.id = p_studio_machine_id;

  if v_machine_studio is null then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  if v_machine_studio <> o_studio then
    raise exception 'That machine belongs to another studio.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_retired is not null then
    raise exception 'That machine is out of service.'
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function public.assert_setup_scope(uuid, uuid) is
  '0223. INTERNAL. Resolves and LOCKS the scope every machine-settings write shares: the block''s studio through its session (both must be live), the caller''s active membership of that studio, and the machine''s ownership, service state and profile version. Takes the migration''s row locks in their fixed order - sessions, session_blocks, studio_machines - so no caller can take them in a different sequence. Called ONCE per write, not once per group, so every group of one submission is written under one consistent locked scope. Not granted to any role: it is a building block of the commands, never an entry point.';

-- ---------------------------------------------------------------------------
-- PART 3 SHARED WRITER — one settings group, inside an asserted scope
-- ---------------------------------------------------------------------------
--
-- Everything that decides WHAT GETS STORED for one group lives here and
-- nowhere else: the mode contract lookup, the installed-option requirement,
-- the channel bounds, the per-field unit/precision/quantity derivation, the
-- value rules and the capture allocation. `record_treatment_setup_group` and
-- `record_treatment_setup_submission` both call it, so a clinical validation
-- rule cannot hold on one path and not the other.
--
-- IT IS SECURITY INVOKER, AND THAT IS THE SECURITY DESIGN. It TRUSTS its
-- scope arguments - studio, practitioner, profile version - because its
-- callers have just proved them. A SECURITY DEFINER function that trusts its
-- arguments is only as safe as its EXECUTE revoke: lose the revoke and any
-- authenticated caller forges a capture into another studio. As INVOKER it
-- runs with the privileges of whoever is executing, which inside a SECURITY
-- DEFINER command is the definer, and from outside is a role with NO insert
-- privilege on `treatment_setup_captures` or `treatment_setup_readings` - so
-- it fails closed at the privilege layer even if the revoke below is ever
-- lost. The revoke is still written, by name, for all four roles. Two locks,
-- not one.
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
  p_submission_id uuid
)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
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
  -- returned 0. Because `latest_setup_for_client` picks the newest setup and
  -- then aggregates its rows, that empty capture became the newest and made
  -- valid prior guidance vanish as `[]` - a direct authenticated call could
  -- erase a client's next-visit setup without deleting anything. The server
  -- action already refused this; the command has to as well.
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

  -- THE CONTRACT MUST BE PUBLISHED, AND IT FAILS CLOSED.
  --
  -- A profile version with no published contract cannot be validated, so it
  -- cannot be recorded. Recording unvalidated whenever the contract happens to
  -- be missing would make the whole check decorative, because the bypass would
  -- be "do not publish".
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

  -- THE MODE MAY REQUIRE A PHYSICAL OPTION THIS UNIT DOES NOT HAVE.
  -- The profile describes the model; the device records what is actually
  -- fitted, and the device wins.
  if v_requires_option is not null
     and not (v_requires_option = any (coalesce(p_installed_options, '{}'::text[]))) then
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

  -- ALLOCATE ONE CAPTURE FOR THIS WHOLE GROUP, SAFELY UNDER CONCURRENCY.
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
    group_key, channels, revision, recorded_by_practitioner_id,
    setup_submission_id
  )
  values (
    p_studio, p_block_id, p_studio_machine_id,
    -- The profile identity is copied from the UNIT at record time, so a later
    -- re-registration cannot retroactively change what a capture was made
    -- under.
    p_profile_id, p_profile_version, v_mode,
    v_group, coalesce(p_channels, '{}'), v_revision, p_practitioner,
    -- NULL when this group was recorded on its own, which is a fact about how
    -- it was recorded and not missing data. See the column's comment.
    p_submission_id
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
      p_studio, p_block_id, p_studio_machine_id,
      p_profile_id, p_profile_version, v_mode,
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
      p_practitioner
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid) is
  '0223. INTERNAL. Writes ONE settings group inside an already-asserted scope: validates the mode contract, the installed-option requirement, the channel bounds and every per-field value rule, derives unit, precision and quantity FROM THE PUBLISHED CONTRACT, allocates one capture at the next revision and inserts its readings. The single definition of what gets stored for a group, shared by record_treatment_setup_group and record_treatment_setup_submission so a clinical rule cannot hold on one path and not the other. SECURITY INVOKER ON PURPOSE: it trusts the scope its caller proved, so it must not carry the definer''s privileges - called directly by a runtime role it fails at the table privilege layer, independently of its EXECUTE revoke. Not granted to any role.';

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
  v_scope record;
begin
  -- THIS COMMAND'S BEHAVIOUR IS UNCHANGED. Every check it used to perform
  -- inline it still performs, in the same order, with the same messages and
  -- the same error codes - they moved into `assert_setup_scope` and
  -- `record_setup_group_in_scope`, which this calls and which
  -- `record_treatment_setup_submission` calls too. The extraction exists so
  -- that the two commands cannot drift apart, not to change this one.
  --
  -- THE SUBMISSION ID IS NULL HERE, DELIBERATELY. A group recorded through
  -- this command was recorded on its own, and that is a true fact about it
  -- rather than a gap to be filled in later. Making this a thin wrapper over
  -- the submission command instead would have stamped every such capture with
  -- a synthetic one-group submission, which would quietly destroy the
  -- distinction `treatment_setup_captures.setup_submission_id` exists to
  -- record.
  select * into v_scope
    from public.assert_setup_scope(p_block_id, p_studio_machine_id);

  return public.record_setup_group_in_scope(
    p_block_id,
    p_studio_machine_id,
    v_scope.o_studio,
    v_scope.o_practitioner,
    v_scope.o_profile_id,
    v_scope.o_profile_version,
    v_scope.o_installed_options,
    p_mode_key,
    p_group_key,
    p_channels,
    p_readings,
    null
  );
end;
$$;

comment on function public.record_treatment_setup_group(uuid, uuid, text, text, smallint[], jsonb) is
  '0223. Records ONE settings group for one treatment block. The block determines the studio and the caller must be an active member of it, so a block or machine in another studio is refused. The machine is required and its profile identity is copied at record time. Readings are append-only; recording again for the same field raises a unique violation rather than overwriting.';

-- ---------------------------------------------------------------------------
-- PART 6 COMMAND — record ONE SAVE: every settings group, atomically
-- ---------------------------------------------------------------------------
--
-- WHAT THIS ADDS OVER CALLING `record_treatment_setup_group` SEVERAL TIMES.
-- Three invariants that are unreachable from outside a single command, each
-- of which was a real hole while the entry surface could record more than one
-- group (Codex, #860 6157725545):
--
--   ATOMICITY. One call, one statement, one transaction: either the
--   submission and every one of its groups is recorded, or none of it is. A
--   failure on the third group does not leave the first two behind as a setup
--   nobody chose. This is not achieved by catching anything - it is achieved
--   by NOT catching anything, so an exception in the loop aborts the whole
--   call and the submission row inserted above it rolls back with the rest.
--
--   CROSS-GROUP CHANNEL EXCLUSIVITY. Each separate call carried its own
--   duplicate-free channel array, so two calls both claiming probe 2 were two
--   individually VALID calls - the conflict was invisible to the database and
--   a UI check was the only guard, which anything calling the RPC directly
--   bypassed. A probe cannot be on two settings at once, and that is now
--   enforced where it cannot be skipped.
--
--   IDEMPOTENCY AFTER A LOST RESPONSE. A caller that never learns the outcome
--   of its Save could not retry: a retry was indistinguishable from a
--   deliberate second capture, so the honest UI behaviour was to refuse to
--   retry at all. With a caller-supplied key, repeating the SAME Save returns
--   the original submission instead of appending a second one.
--
-- WHAT IT IS DELIBERATELY NOT. It does not interpret the settings, pair
-- groups with areas, copy one group's values into another, or assert that an
-- unassigned group applies to every probe. It records what the practitioner
-- entered, grouped the way she grouped it.
create or replace function public.record_treatment_setup_submission(
  p_block_id uuid,
  p_studio_machine_id uuid,
  p_mode_key text,
  p_idempotency_key text,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_scope record;
  v_mode text;
  v_key text;
  v_submission uuid;
  v_existing record;
  v_count integer := 0;
  v_groups integer := 0;
  v_group_item jsonb;
  v_channels smallint[];
  v_dup_channel smallint;
  v_dup_group text;
begin
  -- PAYLOAD SHAPE FIRST, because it costs no I/O and a malformed call should
  -- not take locks on its way to being refused.
  if p_groups is null or jsonb_typeof(p_groups) <> 'array'
     or jsonb_array_length(p_groups) = 0 then
    raise exception 'At least one settings group is required.'
      using errcode = 'check_violation';
  end if;

  v_mode := btrim(coalesce(p_mode_key, ''));
  if v_mode = '' then
    raise exception 'A mode is required.' using errcode = 'check_violation';
  end if;

  -- THE RETRY KEY IS THE CALLER'S, AND IT MUST BE SUBSTANTIAL. A short key
  -- collides, and a colliding key makes a DIFFERENT Save look like a retry of
  -- this one - which is the one failure mode worse than not retrying at all.
  -- The table's own check says the same; saying it here fails with a sentence
  -- rather than a constraint name.
  v_key := btrim(coalesce(p_idempotency_key, ''));
  if length(v_key) < 8 or length(v_key) > 100 then
    raise exception
      'A save needs its own retry key of at least 8 characters.'
      using errcode = 'check_violation';
  end if;

  -- SERIALISE THIS SAVE AGAINST ITS OWN RETRIES.
  --
  -- Without this, two concurrent retries of the same lost Save both find no
  -- submission, both insert, and the second fails on the unique constraint -
  -- a 23505 the caller cannot distinguish from a genuine conflict. Keyed on
  -- (block, retry key), so unrelated saves never wait on each other. Taken
  -- BEFORE the lookup, which is the whole point: the check and the insert have
  -- to be one indivisible step.
  perform pg_advisory_xact_lock(
    hashtextextended(p_block_id::text || ':submission:' || v_key, 0)
  );

  -- SCOPE BEFORE IDEMPOTENCY, deliberately. The scope assertion is also the
  -- authorization check, so answering "does this key already exist" first
  -- would tell a caller with no membership of this studio something about its
  -- records. Nothing is disclosed before the caller is known to belong here.
  select * into v_scope
    from public.assert_setup_scope(p_block_id, p_studio_machine_id);

  -- ALREADY RECORDED? Then this is a retry, and the answer is the ORIGINAL.
  select sub.id, sub.studio_machine_id, sub.machine_profile_id,
         sub.machine_profile_version, sub.mode_key
    into v_existing
    from public.treatment_setup_submissions sub
   where sub.session_block_id = p_block_id
     and sub.idempotency_key = v_key;

  if found then
    -- A KEY REUSED FOR A DIFFERENT SAVE IS A BUG, NOT A RETRY, and returning
    -- the old submission would tell the caller its new groups were stored
    -- when nothing was written. Refused loudly instead.
    --
    -- A re-registered machine lands here too, and correctly: if the unit is
    -- now on a different profile version, the Save being retried is no longer
    -- the Save that was made.
    if v_existing.studio_machine_id <> p_studio_machine_id
       or v_existing.machine_profile_id <> v_scope.o_profile_id
       or v_existing.machine_profile_version <> v_scope.o_profile_version
       or v_existing.mode_key <> v_mode then
      raise exception
        'That retry key already belongs to a different save on this treatment.'
        using errcode = 'unique_violation';
    end if;

    select count(*)::integer into v_count
      from public.treatment_setup_readings r
      join public.treatment_setup_captures c on c.id = r.capture_id
     where c.setup_submission_id = v_existing.id;

    select count(*)::integer into v_groups
      from public.treatment_setup_captures c
     where c.setup_submission_id = v_existing.id;

    return jsonb_build_object(
      'submission_id', v_existing.id,
      'groups', v_groups,
      'readings', v_count,
      -- The caller needs to know its retry was ABSORBED rather than written,
      -- or a "saved" confirmation is indistinguishable from a duplicate.
      'reused', true
    );
  end if;

  -- GROUP IDENTITY MUST BE UNAMBIGUOUS WITHIN ONE SAVE. Two groups under one
  -- key are not two groups; they are a caller that has lost track of which is
  -- which, and each would silently become a separate revision of the other.
  select btrim(coalesce(g.value->>'group_key', '')) into v_dup_group
    from jsonb_array_elements(p_groups) g
   group by btrim(coalesce(g.value->>'group_key', ''))
  having count(*) > 1
   limit 1;

  if v_dup_group is not null then
    raise exception 'Settings group "%" is given more than once in this save.',
      v_dup_group using errcode = 'check_violation';
  end if;

  -- A CHANNEL LIST MUST BE A LIST OF NUMBERS, checked before it is cast, so a
  -- malformed payload fails with a sentence instead of an
  -- invalid_text_representation from a cast nobody can see.
  if exists (
    select 1 from jsonb_array_elements(p_groups) g
     where g.value ? 'channels'
       and jsonb_typeof(g.value->'channels') not in ('array', 'null')
  ) then
    raise exception 'A settings group''s channels must be given as a list.'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_groups) g
      cross join lateral
        jsonb_array_elements(
          case when jsonb_typeof(g.value->'channels') = 'array'
               then g.value->'channels' else '[]'::jsonb end
        ) ch
     where jsonb_typeof(ch.value) <> 'number'
  ) then
    raise exception 'A channel must be named by its number.'
      using errcode = 'check_violation';
  end if;

  -- CROSS-GROUP EXCLUSIVITY — the invariant that only a whole-save command
  -- can see. Per-channel bounds and WITHIN-group duplicates are the shared
  -- writer's job and are checked there for both callers; this is the claim
  -- that spans groups, so it belongs to the save.
  select t.ch into v_dup_channel
    from (
      select (ch.value)::text::smallint as ch
        from jsonb_array_elements(p_groups) g
        cross join lateral
          jsonb_array_elements(
            case when jsonb_typeof(g.value->'channels') = 'array'
                 then g.value->'channels' else '[]'::jsonb end
          ) ch
    ) t
   group by t.ch
  having count(*) > 1
   limit 1;

  if v_dup_channel is not null then
    raise exception
      'Channel % is claimed by more than one settings group in this save; a probe can only be on one setting at a time.',
      v_dup_channel
      using errcode = 'check_violation';
  end if;

  -- THE SAVE ITSELF. Its machine, profile version and mode are recorded, so a
  -- Save made under a different one is necessarily a different submission and
  -- a stale group cannot rejoin this one.
  insert into public.treatment_setup_submissions (
    studio_id, session_block_id, studio_machine_id,
    machine_profile_id, machine_profile_version, mode_key,
    idempotency_key, recorded_by_practitioner_id
  )
  values (
    v_scope.o_studio, p_block_id, p_studio_machine_id,
    v_scope.o_profile_id, v_scope.o_profile_version, v_mode,
    v_key, v_scope.o_practitioner
  )
  returning id into v_submission;

  -- IN SORTED GROUP ORDER, AND THAT IS A DEADLOCK FIX, NOT TIDINESS.
  --
  -- The shared writer takes `pg_advisory_xact_lock` on (block, group) to
  -- allocate a revision. Two concurrent saves on the same block naming the
  -- same groups in OPPOSITE input order would each hold the lock the other
  -- wants - a genuine deadlock, detected and aborted by Postgres, surfacing
  -- as a failed save with no cause a practitioner could act on. Sorting by
  -- group key gives every caller the same total order, so they queue instead.
  for v_group_item in
    select g.value
      from jsonb_array_elements(p_groups) g
     order by btrim(coalesce(g.value->>'group_key', ''))
  loop
    -- INPUT ORDER IS PRESERVED INSIDE a group's channel list. The array is
    -- part of the capture's identity, so re-ordering it here would make the
    -- same save store a different identity depending on how it was sorted.
    select coalesce(
             array_agg((ch.value)::text::smallint order by ch.ord),
             '{}'::smallint[]
           )
      into v_channels
      from jsonb_array_elements(
             case when jsonb_typeof(v_group_item->'channels') = 'array'
                  then v_group_item->'channels' else '[]'::jsonb end
           ) with ordinality as ch(value, ord);

    v_count := v_count + public.record_setup_group_in_scope(
      p_block_id,
      p_studio_machine_id,
      v_scope.o_studio,
      v_scope.o_practitioner,
      v_scope.o_profile_id,
      v_scope.o_profile_version,
      v_scope.o_installed_options,
      v_mode,
      v_group_item->>'group_key',
      v_channels,
      v_group_item->'readings',
      v_submission
    );
    v_groups := v_groups + 1;
  end loop;

  return jsonb_build_object(
    'submission_id', v_submission,
    'groups', v_groups,
    'readings', v_count,
    'reused', false
  );
end;
$$;

comment on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) is
  '0223. Records ONE SAVE of machine settings - every settings group the practitioner entered - as a single atomic unit. Adds the three invariants that several separate record_treatment_setup_group calls cannot have: ATOMICITY (one call, so a failure on a later group rolls back the submission and every group already written), CROSS-GROUP CHANNEL EXCLUSIVITY (a probe cannot be claimed by two groups of one save, enforced in the database rather than only in the UI), and IDEMPOTENCY (a caller-supplied retry key, so a save repeated after a LOST RESPONSE returns the original submission with reused=true instead of appending a second one; a key reused for a DIFFERENT save is refused). Shares every scope and per-group validation rule with record_treatment_setup_group through assert_setup_scope and record_setup_group_in_scope - there is one definition of each rule, not two. Groups are written in sorted group-key order so two concurrent saves cannot deadlock on the per-group revision locks. Returns {submission_id, groups, readings, reused}. Interprets nothing clinical: no pairing of groups to areas, no copying between groups, and no assertion that an unassigned group applies to every probe.';

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
  -- EVERY SETTING GROUP OF THE LATEST SETUP, not one capture of it.
  --
  -- This selected a SINGLE capture: `order by recorded_at desc, revision desc
  -- limit 1`. Correct while one setup meant one group, and wrong the moment
  -- the entry surface could record several - a practitioner with probes at
  -- different settings saves two groups, both sets of rows persist, and
  -- next-visit guidance showed only the last one and SILENTLY OMITTED the
  -- other probes' settings. Hiding recorded clinical settings is a worse
  -- outcome than the composite this limit was protecting against
  -- (Codex, f175e732).
  --
  -- THE NO-COMPOSITE INVARIANT STILL HOLDS, and the anchor's shape is why.
  -- The danger was assembling a setup that never existed - a current from one
  -- capture beside a duration from another. Returning several captures is not
  -- that, PROVIDED each is intact and they all belong to one recorded setup.
  -- So the anchor pins the identity: same block, same physical unit, same
  -- profile version, same mode. One visit, one machine, one mode - and within
  -- it the LATEST REVISION of each group, so a superseded value is never
  -- offered back as guidance.
  --
  -- TIMING IS PER GROUP, AND IS REPORTED THAT WAY. Each group's rows carry
  -- their own `recorded_at`, and two groups of one setup are genuinely
  -- recorded at different instants - a practitioner sets one probe, then the
  -- next. Nothing here collapses them to a single moment, and no consumer may
  -- present them as observed together: that is why the Previous treatment
  -- panel shows a DATE and no clock time.
  --
  -- WHAT THIS IS NOT, now that submissions exist. `treatment_setup_captures`
  -- may carry a `setup_submission_id` - the one Save that produced it - and a
  -- submission is a STRONGER coherence claim than this anchor makes: those
  -- groups were entered together, in one action, deliberately. The anchor
  -- below reconstructs "the latest setup" from IDENTITY (block, unit, profile
  -- version, mode) because it must still work for every capture recorded
  -- before submissions existed, where that id is NULL. So this returns the
  -- LATEST OBSERVED GROUPS of one setup identity, which is not the same thing
  -- as one submission, and the difference is worth naming rather than
  -- blurring. Preferring a submission when one is present is a separate
  -- increment with its own proof.
  --
  -- 0223 was editable for this: the declared hosted maximum is 0210, so this
  -- migration is PENDING and not frozen. The defect is a read contract that
  -- cannot express what the write path already stores correctly.
  with anchor as (
    select c.session_block_id, c.studio_machine_id, c.machine_profile_id,
           c.machine_profile_version, c.mode_key, c.recorded_at
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
  ),
  -- Each group of that same setup, at its own highest revision.
  newest_per_group as (
    select distinct on (c.group_key) c.id
      from public.treatment_setup_captures c
      join anchor a
        on a.session_block_id = c.session_block_id
       and a.machine_profile_id = c.machine_profile_id
       and a.machine_profile_version = c.machine_profile_version
       and a.mode_key = c.mode_key
       -- `is not distinct from`, because the column is nullable in principle;
       -- an equality test would drop a group whose unit had been erased.
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
        'value_numeric', r.value_numeric::text,
        'absence_reason', r.absence_reason,
        'native_unit', r.native_unit,
        'decimals', r.decimals,
        'observation_source', r.observation_source,
        'revision', r.revision,
        'recorded_by_practitioner_id', r.recorded_by_practitioner_id,
        'recorded_at', r.recorded_at
      )
      -- GROUP FIRST, then field. With several groups a field-only ordering
      -- interleaves them, so a consumer walking the array in order sees one
      -- group's current beside another's duration. Every consumer groups by
      -- `group_key` anyway, but an array whose order implies a pairing that
      -- does not exist is a trap worth not setting.
      order by r.group_key, r.field_key
    ),
    '[]'::jsonb
  )
    from public.treatment_setup_readings r
   where r.capture_id in (select id from newest_per_group);
$$;

comment on function public.latest_setup_for_client(uuid, uuid) is
  '0223. EVERY SETTING GROUP of this client''s most recent recorded setup, each at its own highest revision, as a jsonb array for next-visit guidance. The setup is identified by (block, physical unit, profile version, mode) and must be in a NON-RETIRED block and session. Deliberately NOT the latest revision of each FIELD independently: that can assemble a setup that never existed, mixing fields from different capture times, modes, machines or profile versions. A field absent from a group is absent from the result and is never filled in from an older capture. Equally NOT one capture: a practitioner with probes at different settings records several groups, and returning only the newest silently omitted the others. TIMING IS PER GROUP - each row carries its own recorded_at and the groups are genuinely recorded at different instants, so no consumer may present them as observed together. This is LATEST-OBSERVED GROUPS of one setup identity, which is weaker than one submission (treatment_setup_captures.setup_submission_id): submissions did not exist for historical captures, so identity is what every row can be matched on. Scoped through session_blocks -> sessions.client_id so a studio-mate''s newer capture can never be shown as this client''s setup. SECURITY INVOKER: RLS stays in force and is_studio_member is a fail-closed second lock. value_numeric is emitted as TEXT so a recorded zero and the machine''s own precision survive JSON.';

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
-- PART 6 COMMAND — THE INITIAL SAVE: create the area AND record the settings
-- ---------------------------------------------------------------------------
--
-- WHY THIS EXISTS. Creating the treatment area and recording the machine
-- settings are two commands, so they are two transactions, so the first can
-- commit and the second fail. The result is an area that silently has NO
-- machine settings recorded while the practitioner believes she entered them.
-- `lib/machines/create-and-record.ts` reports that state honestly and keeps
-- the save retryable, and `MachineRecordedSetups` now shows her what IS
-- recorded, so the window is visible rather than silent - but visible is not
-- the same as impossible, and for the INITIAL save it does not have to be
-- either (Codex, #860 6174886692).
--
-- WHAT IS *NOT* THE REASON, because the record should not carry a claim I do
-- not believe: this is NOT about a phantom or partial submission. Since the
-- submissions table landed, `record_treatment_setup_submission` inserts the
-- submission row and every group's captures in ONE transaction with no
-- exception handler, so a submission with no captures, or with some groups
-- and not others, is already unreachable. The residual is block-versus-
-- submission, and that is what this closes.
--
-- IT DELEGATES, AND THAT IS THE WHOLE DESIGN. It calls
-- `create_block_with_entry` (0166) rather than inserting a block itself, so
-- `session_blocks` keeps a SINGLE write path. A command that wrote the block
-- directly would be a second one, and the two would drift - 0166's own body
-- resolves the studio through `assert_session_writable`, reuses 0128/0129's
-- area boundary, and writes the legacy projection. None of that is
-- reimplemented here.
--
-- THE COST, STATED RATHER THAN HIDDEN. Delegating means forwarding
-- twenty-six parameters, and a forwarding wrapper of that size is exactly the
-- class of SQL that cannot be trusted unexecuted: one wrong parameter name
-- fails only at runtime. 0204 shipped a command writing to a column that did
-- not exist, applied clean, and had never once succeeded.
--
-- Two things reduce that risk and neither replaces a DB run:
--   1. THIS DECLARATION AND ITS FORWARDING WERE GENERATED from
--      `create_block_with_entry`'s own declaration in 0166, not typed;
--   2. a source-contract test re-derives the same list and asserts this
--      function declares and forwards exactly those names, in that order, so
--      a later redefinition of 0166's command fails the guard instead of
--      silently diverging from it.
--
-- EVERY ARGUMENT IS PASSED BY NAME. Positional forwarding of twenty-six
-- arguments would make a transposition silent and permanent; named forwarding
-- makes an order mistake impossible and leaves only a name mistake, which the
-- guard above catches.
--
-- THE SETTINGS ARE OPTIONAL. With no groups this is exactly
-- `create_block_with_entry` plus a row count of zero: an area saved with no
-- machine settings is an ordinary state, and this command must not invent a
-- reason to refuse it.
create or replace function public.create_block_with_initial_setup(
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
  -- The machine settings half. Null/empty means "no settings to record",
  -- which is a valid save.
  p_studio_machine_id              uuid,
  p_setup_mode_key                 text,
  p_setup_idempotency_key          text,
  p_setup_groups                   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_block_id uuid;
  v_entry_id uuid;
  v_setup jsonb := null;
begin
  -- THE AREA FIRST, through the one command that creates one.
  select c.block_id, c.entry_id
    into v_block_id, v_entry_id
    from public.create_block_with_entry(
    p_session_id                    => p_session_id,
    p_client_id                     => p_client_id,
    p_block                         => p_block,
    p_block_extra                   => p_block_extra,
    p_areas                         => p_areas,
    p_with_entry                    => p_with_entry,
    p_area                          => p_area,
    p_areas_list                    => p_areas_list,
    p_probe_size                    => p_probe_size,
    p_probe_lot_id                  => p_probe_lot_id,
    p_mode                          => p_mode,
    p_pulse_count                   => p_pulse_count,
    p_pulse_delay_seconds           => p_pulse_delay_seconds,
    p_comments                      => p_comments,
    p_observation_chips             => p_observation_chips,
    p_apilus_modality               => p_apilus_modality,
    p_energy_level                  => p_energy_level,
    p_minutes_performed             => p_minutes_performed,
    p_probe_type                    => p_probe_type,
    p_machine_frequency             => p_machine_frequency,
    p_hairs_treated                 => p_hairs_treated,
    p_galvanic_ma                   => p_galvanic_ma,
    p_galvanic_duration_seconds     => p_galvanic_duration_seconds,
    p_thermolysis_intensity_percent => p_thermolysis_intensity_percent,
    p_thermolysis_duration_seconds  => p_thermolysis_duration_seconds,
    p_units_of_lye                  => p_units_of_lye
    ) c;

  if v_block_id is null then
    raise exception 'The treatment area could not be created.'
      using errcode = 'no_data_found';
  end if;

  -- THEN THE SETTINGS, IN THE SAME TRANSACTION. No exception handler, which
  -- is what makes this atomic: a refusal below aborts the whole call and the
  -- block created above rolls back with it. Catching anything here would
  -- reintroduce precisely the half-saved state the command exists to remove.
  if p_setup_groups is not null
     and jsonb_typeof(p_setup_groups) = 'array'
     and jsonb_array_length(p_setup_groups) > 0 then
    v_setup := public.record_treatment_setup_submission(
      v_block_id,
      p_studio_machine_id,
      p_setup_mode_key,
      p_setup_idempotency_key,
      p_setup_groups
    );
  end if;

  return jsonb_build_object(
    'block_id', v_block_id,
    'entry_id', v_entry_id,
    -- NULL when nothing was entered, which the caller must be able to tell
    -- apart from a save that recorded zero readings.
    'setup', v_setup
  );
end;
$$;

comment on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) is
  '0223. THE INITIAL SAVE of a treatment area together with the machine settings recorded on it, in ONE transaction: either the area and its settings both exist or neither does. Closes the only window the two separate commands leave - an area that silently has no machine settings while the practitioner believes she entered them. NOT about a phantom or partial submission: record_treatment_setup_submission has been atomic in itself since the submissions table landed. DELEGATES the area to create_block_with_entry (0166) so session_blocks keeps a single write path, forwarding all twenty-six parameters BY NAME; the declaration and forwarding were generated from that function''s own declaration and are pinned by a source-contract guard, which reduces but does not replace a database run. The settings are OPTIONAL - an area saved with none is an ordinary state. Returns {block_id, entry_id, setup}, where setup is NULL when nothing was entered and otherwise the submission result including its reused flag.';

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

-- THE TWO SHARED BUILDING BLOCKS ARE NOT ENTRY POINTS, and their revokes are
-- the load-bearing half of that sentence.
--
-- `record_setup_group_in_scope` TRUSTS the studio and practitioner it is
-- handed, because its callers have just proved them. Called directly by an
-- authenticated role it would write a capture into any studio it names. It is
-- SECURITY INVOKER precisely so that the revoke is not the only thing
-- standing in the way - a direct caller also has no insert privilege on
-- `treatment_setup_captures` or `treatment_setup_readings` - but the revoke is
-- written anyway, for all four roles, by name. Supabase's ALTER DEFAULT
-- PRIVILEGES hands EXECUTE to anon, authenticated AND service_role at
-- function-create time, which is how 0129 missed `anon` and 0164 missed
-- `service_role`. Neither function is granted back to anything.
revoke execute on function public.assert_setup_scope(uuid, uuid) from public;
revoke execute on function public.assert_setup_scope(uuid, uuid) from anon;
revoke execute on function public.assert_setup_scope(uuid, uuid) from authenticated;
revoke execute on function public.assert_setup_scope(uuid, uuid) from service_role;

revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid) from public;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid) from anon;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid) from authenticated;
revoke execute on function public.record_setup_group_in_scope(uuid, uuid, uuid, uuid, text, integer, text[], text, text, smallint[], jsonb, uuid) from service_role;

-- The whole-save command IS an entry point: it is what the treatment form
-- calls.
revoke execute on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) from public;
revoke execute on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) from anon;
revoke execute on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) from authenticated;
revoke execute on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) from service_role;
grant execute on function public.record_treatment_setup_submission(uuid, uuid, text, text, jsonb) to authenticated;

-- THE INITIAL SAVE. An entry point: it is what the create form calls.
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from public;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from anon;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from authenticated;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from service_role;
grant execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) to authenticated;

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
