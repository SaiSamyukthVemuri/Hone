-- ---------------------------------------------------------------------------
-- 0166 — L18 Phase 2: narrow commands for session_blocks + electrolysis_entries
--
-- WHAT THIS REPLACES
-- ===========================================================================
-- Verified runtime writer census on the current tree (statement-chain accurate,
-- matching the 7 + 4 baseline):
--
--   session_blocks (7)
--     ensureBlockForSession                INSERT   actions.ts:143
--     createSessionBlockAction             INSERT   block-actions.ts:376
--     updateSessionBlockAction             UPDATE   block-actions.ts:518
--     softDeleteSessionBlockAction         UPDATE   block-actions.ts:611
--     createTreatmentAreaWithEntryAction   INSERT   block-actions.ts:1062
--     createTreatmentAreaWithEntryAction   UPDATE   block-actions.ts:1119  (compensating)
--     updateTreatmentAreaWithEntryAction   UPDATE   block-actions.ts:1359
--   electrolysis_entries (4)
--     addElectrolysisEntryAction           INSERT   actions.ts:344
--     createTreatmentAreaWithEntryAction   INSERT   block-actions.ts:1091
--     updateTreatmentAreaWithEntryAction   UPDATE   block-actions.ts:1407
--     updateTreatmentAreaWithEntryAction   INSERT   block-actions.ts:1421
--   session_block_areas (0) — already behind the 0128/0129 command boundary.
--
-- AFTER this migration and its application half, the same statement-chain
-- census reports session_blocks 0, electrolysis_entries 0, session_block_areas
-- 0 and laser_entries 0: every one of the writers above calls a command below.
-- Pinned by tests/security/entry-direct-dml-guard.test.ts, which prints the
-- full census and has NO remaining exception entries to grow.
--
-- FIELDS 0129 DOES NOT OWN (each one a silent data-loss path this had to close)
-- ===========================================================================
-- 0129's create INSERT and update SET lists were written for the area-selection
-- form, and omit columns the direct writers were persisting. Routing every
-- writer through 0129 without handling them would have stopped saving real
-- clinical data with nothing going red:
--   * block_notes, probe_size          — omitted by 0129's INSERT
--   * block_name, probe_type,
--     started_at, ended_at             — omitted by 0129's UPDATE
--   * probe_inventory_item_id          — omitted by BOTH (the 0155 link)
-- All seven are routed through apply_block_extra_fields, which enumerates them
-- literally, rejects any other key, and writes by key PRESENCE so an omitted
-- key is preserved rather than nulled.
--
-- Two further preservation rules, for the same reason:
--   * p_areas NULL means "this caller does not own the area set" — 0129's
--     update always REPLACES it, so a legacy single-area edit would otherwise
--     DELETE the recorded areas. An explicit '[]' still clears.
--   * the entry UPDATE omits probe_type, probe_size and probe_lot_id, so an
--     existing entry's legacy probe data is never wiped by an edit. The INSERT
--     still writes probe_type, where the column starts empty.
--
-- THE ATOMICITY PROBLEM THIS CLOSES
-- ===========================================================================
-- Three workflows write a block AND an entry for ONE user intent, today across
-- SEPARATE transactions:
--   * createTreatmentAreaWithEntryAction — block first, then entry; on entry
--     failure it issues a COMPENSATING soft-delete of the block it just made.
--   * updateTreatmentAreaWithEntryAction — block update commits first; if the
--     entry write then fails, block and entry describe different treatments
--     and there is NO compensation at all.
--   * addElectrolysisEntryAction — when the form omits block_id (a legacy
--     caller shape it still supports) it calls ensureBlockForSession, which
--     INSERTs a block before the entry. A failed entry write leaves it behind.
--
-- Each command below performs its whole workflow inside ONE function body, so
-- it is ONE transaction: any failure rolls back the block mutation, the area
-- linkage, the entry mutation, the probe-inventory linkage and the observation
-- chips together. No partial charting state can survive, and the compensating
-- delete is retired.
--
-- REUSING THE PROVEN AREA BOUNDARY
-- ===========================================================================
-- The block+areas half is delegated to the EXISTING 0129 commands
-- (create_session_block_with_areas / update_session_block_with_areas) rather
-- than opening a competing area-write path. They already allow-list block
-- columns via jsonb_populate_record, replace the area set atomically, and carry
-- the optimistic-concurrency check. Calling them from inside these functions
-- keeps ONE area-write path and inherits their behaviour exactly.
--
-- SAFE TO APPLY BEFORE DEPLOY
-- ===========================================================================
-- Purely additive: four functions and their grants. NO table, column,
-- constraint, index, policy or trigger change; NO data change; and NO privilege
-- is revoked, so the currently deployed application keeps writing directly and
-- works unchanged before, during and after the apply.
--
-- L18 REMAINS OPEN. Direct authenticated table DML is NOT revoked here, and
-- sessions / treatment_images writers are untouched and separately documented.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson).
--
-- Migration max 0165 -> 0166.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- Shared guard: resolve the studio from the SESSION and require the caller to
-- be an ACTIVE practitioner of that same studio, matched by auth.uid().
--
-- The caller never supplies studio_id or an actor identity, so neither can be
-- forged. `p_client_id` is an assertion re-checked against the session's real
-- client — it can refuse, never redirect. current_user is deliberately NOT
-- consulted: inside a SECURITY DEFINER function it is the owner, not the
-- authenticated actor.
-- ===========================================================================
create or replace function public.assert_session_writable(
  p_session_id uuid,
  p_client_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_client_id uuid;
begin
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;

  select s.studio_id, s.client_id
    into v_studio_id, v_client_id
    from public.sessions s
   where s.id = p_session_id
     and exists (
       select 1
         from public.practitioners p
        where p.studio_id = s.studio_id
          and p.user_id = auth.uid()
          and p.active = true
     );

  if v_studio_id is null then
    -- Covers: no such session, a session in another studio, and a caller who
    -- is not an active practitioner of it. Deliberately one message.
    raise exception 'Session not found or not writable by this practitioner.'
      using errcode = 'check_violation';
  end if;

  if p_client_id is null or p_client_id is distinct from v_client_id then
    raise exception 'Session does not belong to that client.'
      using errcode = 'check_violation';
  end if;

  return v_studio_id;
end;
$$;

-- ===========================================================================
-- Shared guard: the block must belong to THIS session and studio, and be live.
-- Locks the block row so a coupled block+entry mutation cannot interleave with
-- another writer. Parent (session) is resolved first, then the block — a
-- stable order, so two concurrent commands cannot deadlock against each other.
-- ===========================================================================
create or replace function public.assert_block_in_session(
  p_block_id   uuid,
  p_session_id uuid,
  p_studio_id  uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
begin
  select true into v_ok
    from public.session_blocks b
   where b.id = p_block_id
     and b.session_id = p_session_id
     and b.studio_id = p_studio_id
     and b.deleted_at is null
   for update;

  if v_ok is not true then
    raise exception 'Block does not belong to this session.'
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ===========================================================================
-- Shared: write one electrolysis entry's clinical values.
-- Explicit typed parameters only — there is deliberately NO generic
-- column/value map. `galvanic_intensity_percent` is a RETIRED reading and is
-- not a parameter at all: new rows always store NULL, server-authoritatively.
-- Every value passes through verbatim so the existing CHECK constraints and the
-- 0119/0159/0160 guard triggers remain the sole validation authority.
-- ===========================================================================
create or replace function public.write_electrolysis_entry(
  p_entry_id                       uuid,     -- null => INSERT, else UPDATE
  p_session_id                     uuid,
  p_block_id                       uuid,
  p_area                           text,
  p_areas                          text[],
  p_probe_size                     text,
  p_probe_lot_id                   uuid,
  p_mode                           text,
  p_intensity                      numeric,
  p_duration_seconds               numeric,
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
  p_units_of_lye                   numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_entry_id is null then
    insert into public.electrolysis_entries (
      session_id, block_id, area, areas, probe_size, probe_lot_id, mode,
      intensity, duration_seconds, pulse_count, pulse_delay_seconds, comments,
      observation_chips, apilus_modality, energy_level, minutes_performed,
      probe_type, machine_frequency, hairs_treated, galvanic_ma,
      galvanic_duration_seconds, galvanic_intensity_percent,
      thermolysis_intensity_percent, thermolysis_duration_seconds, units_of_lye
    )
    values (
      p_session_id, p_block_id, p_area, p_areas, p_probe_size, p_probe_lot_id,
      p_mode, p_intensity, p_duration_seconds, coalesce(p_pulse_count, 1),
      p_pulse_delay_seconds, p_comments, coalesce(p_observation_chips, '[]'::jsonb),
      p_apilus_modality, p_energy_level, p_minutes_performed, p_probe_type,
      p_machine_frequency, p_hairs_treated, p_galvanic_ma,
      p_galvanic_duration_seconds, null,
      p_thermolysis_intensity_percent, p_thermolysis_duration_seconds, p_units_of_lye
    )
    returning id into v_id;
  else
    -- The entry must belong to THIS block and session. Scoping the UPDATE by
    -- all three is what refuses an entry from another block or session; the
    -- affected-row check turns a zero-row update into an explicit refusal
    -- rather than a silent success.
    -- Legacy intensity/duration_seconds are intentionally NOT in this patch, so
    -- an old entry's values are preserved. Lineage columns are never written.
    update public.electrolysis_entries e
       set area                          = coalesce(p_area, e.area),
           areas                         = coalesce(p_areas, e.areas),
           pulse_count                   = coalesce(p_pulse_count, e.pulse_count),
           pulse_delay_seconds           = p_pulse_delay_seconds,
           comments                      = p_comments,
           observation_chips             = coalesce(p_observation_chips, e.observation_chips),
           apilus_modality               = p_apilus_modality,
           energy_level                  = p_energy_level,
           minutes_performed             = p_minutes_performed,
           -- probe_type is deliberately ABSENT from this patch, exactly as the
           -- application's own entry snapshot excluded it: an existing entry may
           -- carry legacy probe data that the block edit form does not collect,
           -- and writing p_probe_type here would wipe it on every save. It is
           -- still written on INSERT above, where the column starts empty.
           machine_frequency             = p_machine_frequency,
           hairs_treated                 = p_hairs_treated,
           galvanic_ma                   = p_galvanic_ma,
           galvanic_duration_seconds     = p_galvanic_duration_seconds,
           thermolysis_intensity_percent = p_thermolysis_intensity_percent,
           thermolysis_duration_seconds  = p_thermolysis_duration_seconds,
           units_of_lye                  = p_units_of_lye
     where e.id = p_entry_id
       and e.block_id = p_block_id
       and e.session_id = p_session_id
       and e.deleted_at is null
    returning e.id into v_id;

    if v_id is null then
      raise exception 'Entry does not belong to this block.'
        using errcode = 'check_violation';
    end if;
  end if;

  return v_id;
end;
$$;

-- ===========================================================================
-- Shared: apply the block columns the 0128/0129 boundary deliberately does NOT
-- own. 0129's update explicitly excludes block_name/block_notes and never
-- touched probe_type/probe_size/started_at/ended_at; its insert additionally
-- omits block_notes/probe_type/probe_size. Routing the block writers through
-- 0129 alone would therefore have SILENTLY STOPPED persisting those columns —
-- the writes would still succeed, just without the data. This closes that gap
-- inside the SAME transaction rather than adding a competing command.
--
-- STRICT ALLOW-LIST, NOT A GENERIC UPDATER:
--   * every accepted key is enumerated in SQL below;
--   * an unknown key RAISES rather than being silently ignored;
--   * key PRESENCE distinguishes the three cases —
--       key absent          -> column left unchanged
--       key present, null   -> nullable column explicitly cleared
--       key present, value  -> column updated
--     which COALESCE alone cannot express;
--   * every value is cast explicitly;
--   * id / studio_id / session_id / sort_order / deleted_* / created_at and
--     every lineage column are unreachable — they are simply not in the list.
-- ===========================================================================
create or replace function public.apply_block_extra_fields(
  p_block_id uuid,
  p_extra    jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key    text;
  v_allowed constant text[] := array[
    'block_name', 'block_notes', 'probe_type', 'probe_size',
    'started_at', 'ended_at',
    -- 0129 writes probe_inventory_item_id on NEITHER create nor update, so a
    -- block saved through those functions silently loses its 0155 inventory
    -- link. Routing every writer through them without this entry would make
    -- that pre-existing drop universal. Enumerated and cast like the rest; the
    -- composite FK (studio_id, probe_inventory_item_id) still refuses another
    -- studio's item, so allow-listing it grants no cross-tenant reach.
    'probe_inventory_item_id'
  ];
begin
  if p_extra is null or p_extra = '{}'::jsonb then
    return;
  end if;

  if jsonb_typeof(p_extra) <> 'object' then
    raise exception 'Block patch must be an object.'
      using errcode = 'check_violation';
  end if;

  -- Reject unknown keys loudly. A silently-ignored key is how a field stops
  -- being saved without anything going red.
  for v_key in select jsonb_object_keys(p_extra) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Unsupported block field.'
        using errcode = 'check_violation';
    end if;
  end loop;

  update public.session_blocks b set
    block_name = case when p_extra ? 'block_name'
                      then nullif(p_extra->>'block_name', '') else b.block_name end,
    block_notes = case when p_extra ? 'block_notes'
                       then nullif(p_extra->>'block_notes', '') else b.block_notes end,
    probe_type = case when p_extra ? 'probe_type'
                      then nullif(p_extra->>'probe_type', '') else b.probe_type end,
    probe_size = case when p_extra ? 'probe_size'
                      then nullif(p_extra->>'probe_size', '') else b.probe_size end,
    started_at = case when p_extra ? 'started_at'
                      then (p_extra->>'started_at')::timestamptz else b.started_at end,
    ended_at = case when p_extra ? 'ended_at'
                    then (p_extra->>'ended_at')::timestamptz else b.ended_at end,
    probe_inventory_item_id = case when p_extra ? 'probe_inventory_item_id'
                    then (p_extra->>'probe_inventory_item_id')::uuid
                    else b.probe_inventory_item_id end
  where b.id = p_block_id;
end;
$$;

-- ===========================================================================
-- COMMAND 1 — create a block, its area set and (optionally) its first entry,
-- ATOMICALLY. Replaces createTreatmentAreaWithEntryAction, createSessionBlockAction
-- and the block-creating half of ensureBlockForSession.
--
-- The block+areas write is delegated to the 0129 command so there is exactly
-- one area-write path. Because this whole body is one transaction, a failure in
-- the entry write rolls the block and its areas back — the compensating
-- soft-delete the application performed today is no longer needed.
-- ===========================================================================
create or replace function public.create_block_with_entry(
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
  p_units_of_lye                   numeric
)
returns table (block_id uuid, entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_block_id  uuid;
  v_entry_id  uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  -- Reuse the proven 0128/0129 boundary for the block + its complete area set.
  v_block_id := public.create_session_block_with_areas(
    v_studio_id, p_session_id, p_block, coalesce(p_areas, '[]'::jsonb)
  );

  -- Same transaction: a failure here rolls back the block AND its areas.
  perform public.apply_block_extra_fields(v_block_id, p_block_extra);

  if coalesce(p_with_entry, false) then
    v_entry_id := public.write_electrolysis_entry(
      null, p_session_id, v_block_id, p_area, p_areas_list, p_probe_size,
      p_probe_lot_id, p_mode, null, null,
      p_pulse_count, p_pulse_delay_seconds, p_comments, p_observation_chips,
      p_apilus_modality, p_energy_level, p_minutes_performed, p_probe_type,
      p_machine_frequency, p_hairs_treated, p_galvanic_ma,
      p_galvanic_duration_seconds, p_thermolysis_intensity_percent,
      p_thermolysis_duration_seconds, p_units_of_lye
    );
  end if;

  return query select v_block_id, v_entry_id;
end;
$$;

-- ===========================================================================
-- COMMAND 2 — update a block, its area set and its coupled first entry,
-- ATOMICALLY. Replaces updateTreatmentAreaWithEntryAction and
-- updateSessionBlockAction.
--
-- p_entry_id null + p_with_entry true => the block had no entry; one is created.
-- The block update keeps the 0129 optimistic-concurrency check, so a stale edit
-- still raises `stale_block_version` and the entry is never written.
-- ===========================================================================
create or replace function public.update_block_with_entry(
  p_session_id                     uuid,
  p_client_id                      uuid,
  p_block_id                       uuid,
  p_block                          jsonb,
  p_block_extra                    jsonb,
  p_areas                          jsonb,
  p_expected_updated_at            timestamptz,
  p_with_entry                     boolean,
  p_entry_id                       uuid,
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
  p_units_of_lye                   numeric
)
returns table (block_id uuid, entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_entry_id  uuid;
  v_areas     jsonb;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);
  perform public.assert_block_in_session(p_block_id, p_session_id, v_studio_id);

  -- p_areas NULL means "this caller does not own the area set" — the legacy
  -- single-area edit path, which historically left the child rows untouched.
  -- 0129's update always REPLACES the set, and coalescing NULL to '[]' would
  -- therefore CLEAR it. Re-send the block's current set instead, so a caller
  -- that submits no areas cannot delete the ones already recorded. An explicit
  -- '[]' still clears, which is how the area-selection form removes them all.
  if p_areas is null then
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'area', a.area,
               'laterality', a.laterality,
               'display_order', a.display_order
             ) order by a.display_order),
             '[]'::jsonb)
      into v_areas
      from public.session_block_areas a
     where a.session_block_id = p_block_id;
  else
    v_areas := p_areas;
  end if;

  perform public.update_session_block_with_areas(
    v_studio_id, p_session_id, p_block_id, p_block,
    v_areas, p_expected_updated_at
  );

  -- Same transaction, on the already-validated and locked block.
  perform public.apply_block_extra_fields(p_block_id, p_block_extra);

  if coalesce(p_with_entry, false) then
    v_entry_id := public.write_electrolysis_entry(
      p_entry_id, p_session_id, p_block_id, p_area, p_areas_list, p_probe_size,
      p_probe_lot_id, p_mode, null, null,
      p_pulse_count, p_pulse_delay_seconds, p_comments, p_observation_chips,
      p_apilus_modality, p_energy_level, p_minutes_performed, p_probe_type,
      p_machine_frequency, p_hairs_treated, p_galvanic_ma,
      p_galvanic_duration_seconds, p_thermolysis_intensity_percent,
      p_thermolysis_duration_seconds, p_units_of_lye
    );
  end if;

  return query select p_block_id, v_entry_id;
end;
$$;

-- ===========================================================================
-- COMMAND 3 — add another electrolysis pass to a session, ATOMICALLY.
-- Replaces addElectrolysisEntryAction AND the find-or-create behaviour of
-- ensureBlockForSession.
--
-- When p_block_id is null the command resolves the session's first live block,
-- creating a default one if none exists — in the SAME transaction as the entry,
-- so a failed entry write can no longer leave an orphan block behind.
-- ===========================================================================
create or replace function public.add_electrolysis_pass(
  p_session_id                     uuid,
  p_client_id                      uuid,
  p_block_id                       uuid,
  p_block_defaults                 jsonb,
  p_area                           text,
  p_areas_list                     text[],
  p_probe_size                     text,
  p_probe_lot_id                   uuid,
  p_mode                           text,
  p_intensity                      numeric,
  p_duration_seconds               numeric,
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
  p_units_of_lye                   numeric
)
returns table (block_id uuid, entry_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_block_id  uuid;
  v_entry_id  uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_block_id is not null then
    perform public.assert_block_in_session(p_block_id, p_session_id, v_studio_id);
    v_block_id := p_block_id;
  else
    select b.id into v_block_id
      from public.session_blocks b
     where b.session_id = p_session_id
       and b.studio_id = v_studio_id
       and b.deleted_at is null
     order by b.sort_order asc
     limit 1
       for update;

    if v_block_id is null then
      v_block_id := public.create_session_block_with_areas(
        v_studio_id, p_session_id,
        coalesce(p_block_defaults, '{}'::jsonb), '[]'::jsonb
      );

      -- 0129's INSERT column list does not include block_notes, probe_type,
      -- probe_size, started_at or ended_at, so a default block created here
      -- would silently drop them — the same field-drop class this migration
      -- exists to close. Route exactly those five (enumerated literally, never
      -- built dynamically) to the strict allow-list writer. block_name is
      -- deliberately absent: 0129 already owns it.
      perform public.apply_block_extra_fields(
        v_block_id,
        (
          select coalesce(jsonb_object_agg(k.key, coalesce(p_block_defaults -> k.key, 'null'::jsonb)), '{}'::jsonb)
            from unnest(array['block_notes','probe_type','probe_size','started_at','ended_at']) as k(key)
           where p_block_defaults ? k.key
        )
      );
    end if;
  end if;

  v_entry_id := public.write_electrolysis_entry(
    null, p_session_id, v_block_id, p_area, p_areas_list, p_probe_size,
    p_probe_lot_id, p_mode, p_intensity,
    p_duration_seconds, p_pulse_count, p_pulse_delay_seconds, p_comments,
    p_observation_chips, p_apilus_modality, p_energy_level, p_minutes_performed,
    p_probe_type, p_machine_frequency, p_hairs_treated, p_galvanic_ma,
    p_galvanic_duration_seconds, p_thermolysis_intensity_percent,
    p_thermolysis_duration_seconds, p_units_of_lye
  );

  return query select v_block_id, v_entry_id;
end;
$$;

-- ===========================================================================
-- COMMAND 4 — soft-retire a settings block. Replaces softDeleteSessionBlockAction.
-- SOFT delete only: `deleted_at` is stamped, never a hard DELETE, preserving
-- the clinical record exactly as the 0019/0087 posture requires.
-- ===========================================================================
create or replace function public.soft_delete_session_block(
  p_session_id uuid,
  p_client_id  uuid,
  p_block_id   uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id      uuid;
  v_practitioner_id uuid;
  v_id             uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  -- deleted_by is DERIVED from auth.uid(), never accepted from the caller, so
  -- a removal cannot be attributed to another practitioner.
  select p.id into v_practitioner_id
    from public.practitioners p
   where p.studio_id = v_studio_id
     and p.user_id = auth.uid()
     and p.active = true;

  if v_practitioner_id is null then
    raise exception 'Inactive practitioners cannot remove blocks.'
      using errcode = 'check_violation';
  end if;

  update public.session_blocks b
     set deleted_at = now(),
         deleted_by = v_practitioner_id,
         delete_reason = p_reason
   where b.id = p_block_id
     and b.session_id = p_session_id
     and b.studio_id = v_studio_id
     and b.deleted_at is null
  returning b.id into v_id;

  if v_id is null then
    raise exception 'Block does not belong to this session.'
      using errcode = 'check_violation';
  end if;

  return v_id;
end;
$$;

-- ===========================================================================
-- PRIVILEGES — authenticated only.
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at create time, and PostgreSQL grants it to PUBLIC. 0129 revoked
-- only from public and left anon (fixed by 0130); 0164 revoked public+anon and
-- left service_role (fixed by 0165). All THREE are revoked explicitly here, by
-- name, in the same migration that creates the functions.
-- ===========================================================================
-- Explicit, literal REVOKE per function and role. Deliberately not a
-- DO-block with format(): a literal statement is auditable by reading, and
-- tests/security/clinical-rpc-grant-guard.test.ts verifies these textually.
-- `authenticated` is revoked from EVERY function and re-granted below only to
-- the four capability commands, so the internal helpers cannot be invoked
-- directly to run half a workflow. Verified on a fresh reset: the helpers
-- showed auth=true until this revoke was added.

revoke execute on function public.assert_session_writable(uuid, uuid) from public;
revoke execute on function public.assert_session_writable(uuid, uuid) from anon;
revoke execute on function public.assert_session_writable(uuid, uuid) from service_role;
revoke execute on function public.assert_session_writable(uuid, uuid) from authenticated;

revoke execute on function public.assert_block_in_session(uuid, uuid, uuid) from public;
revoke execute on function public.assert_block_in_session(uuid, uuid, uuid) from anon;
revoke execute on function public.assert_block_in_session(uuid, uuid, uuid) from service_role;
revoke execute on function public.assert_block_in_session(uuid, uuid, uuid) from authenticated;

revoke execute on function public.write_electrolysis_entry(uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from public;
revoke execute on function public.write_electrolysis_entry(uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from anon;
revoke execute on function public.write_electrolysis_entry(uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from service_role;
revoke execute on function public.write_electrolysis_entry(uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from authenticated;

revoke execute on function public.apply_block_extra_fields(uuid, jsonb) from public;
revoke execute on function public.apply_block_extra_fields(uuid, jsonb) from anon;
revoke execute on function public.apply_block_extra_fields(uuid, jsonb) from service_role;
revoke execute on function public.apply_block_extra_fields(uuid, jsonb) from authenticated;

revoke execute on function public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from public;
revoke execute on function public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from anon;
revoke execute on function public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from service_role;
revoke execute on function public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from authenticated;

revoke execute on function public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from public;
revoke execute on function public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from anon;
revoke execute on function public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from service_role;
revoke execute on function public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from authenticated;

revoke execute on function public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from public;
revoke execute on function public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from anon;
revoke execute on function public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from service_role;
revoke execute on function public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) from authenticated;

revoke execute on function public.soft_delete_session_block(uuid, uuid, uuid, text) from public;
revoke execute on function public.soft_delete_session_block(uuid, uuid, uuid, text) from anon;
revoke execute on function public.soft_delete_session_block(uuid, uuid, uuid, text) from service_role;
revoke execute on function public.soft_delete_session_block(uuid, uuid, uuid, text) from authenticated;

-- The four capability commands are callable by authenticated. The helpers
-- stay revoked: invoking one directly would bypass its workflow.

grant execute on function public.create_block_with_entry(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) to authenticated;

grant execute on function public.update_block_with_entry(uuid, uuid, uuid, jsonb, jsonb, jsonb, timestamptz, boolean, uuid, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) to authenticated;

grant execute on function public.add_electrolysis_pass(uuid, uuid, uuid, jsonb, text, text[], text, uuid, text, numeric, numeric, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric) to authenticated;

grant execute on function public.soft_delete_session_block(uuid, uuid, uuid, text) to authenticated;
commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION
--
--   select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as cfg,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
--          has_function_privilege('anon',          p.oid, 'execute') as anon_x,
--          has_function_privilege('service_role',  p.oid, 'execute') as svc_x,
--          (select count(*) from aclexplode(p.proacl) a where a.grantee = 0) as public_entries
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('create_block_with_entry','update_block_with_entry',
--                        'add_electrolysis_pass','soft_delete_session_block');
--   -- expect for all four: prosecdef true, cfg search_path="",
--   --   auth_x true, anon_x FALSE, svc_x FALSE, public_entries 0
--
--   -- nothing was revoked from the tables — the deployed app still works:
--   select has_table_privilege('authenticated','public.session_blocks','insert')       as b_ins,
--          has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins;
--   -- expect BOTH true
--
-- L18 REMAINS OPEN. This migration moves writers onto commands; it revokes no
-- table privilege and does not make any L18 table command-boundary complete on
-- its own.
-- ---------------------------------------------------------------------------
