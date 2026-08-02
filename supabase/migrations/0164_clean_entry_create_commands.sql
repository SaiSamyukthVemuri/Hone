-- ---------------------------------------------------------------------------
-- 0164 — L18 Phase 1A: narrow create commands for the two CLEAN entry writers
--
-- WHAT THIS CLOSES (and, just as importantly, what it does NOT)
-- ===========================================================================
-- L18 records that `authenticated` holds direct row DML on five clinical
-- tables. Closing it means moving every legitimate runtime writer onto narrow
-- reviewed commands FIRST, deploying them, and only then revoking the grants.
--
-- Phase 0 recon at production branch `722bd617c6ca1fd17c34b9378b44aad2570e24e8`
-- found 25 runtime write sites (NOT the 26 the findings register claims — see
-- docs/production/l18-command-inventory.md for why). Of the five sites on the
-- two entry tables, exactly TWO are cleanly separable:
--
--   * addElectrolysisEntryAction  -> electrolysis_entries INSERT, entry-only
--   * addLaserEntryAction         -> laser_entries        INSERT, entry-only
--
-- This migration adds a command for each, and NOTHING else.
--
-- DELIBERATELY NOT MOVED — createTreatmentAreaWithEntryAction and
-- updateTreatmentAreaWithEntryAction each write session_blocks AND
-- electrolysis_entries as ONE user intent. Splitting only the entry half onto
-- an RPC would leave that pair straddling two transactions — exactly the
-- non-atomicity that exists today (the create path compensates with a soft
-- delete; the update path does not compensate at all). Making them genuinely
-- atomic requires a command that owns BOTH writes, which is session_blocks
-- work. They move in the combined session_blocks/electrolysis_entries phase.
-- They are pinned as the ONLY two temporary exceptions by the static drift
-- guard in tests/security/entry-direct-dml-guard.test.ts.
--
-- NO PRIVILEGE OR POLICY IS REVOKED HERE. This migration is purely additive:
-- direct DML remains available on both tables for the whole of this phase, so
-- the deployed application keeps working before, during and after the apply.
--
-- SAFETY
-- ===========================================================================
--   * Additive only: two functions. NO table, column, constraint, index,
--     policy, grant-removal or trigger change.
--   * NO data change, NO backfill, NO deletion.
--   * Both functions are SECURITY DEFINER with `search_path = ''`, so every
--     reference below is schema-qualified.
--   * Neither function reads a runtime setting, and neither takes a studio_id,
--     client_id or practitioner id from the caller — all lineage is derived
--     from trusted rows. There is NO dynamic SQL and NO generic JSON patch.
--   * Existing clinical guard triggers still fire on the INSERTs these
--     functions perform (SECURITY DEFINER changes the privilege context, not
--     trigger execution): 0119/0159 `guard_finalized_clinical_write` and
--     0160 `guard_immutable_clinical_lineage` / `guard_clearable_clinical_lineage`
--     all remain in force, as do every CHECK constraint. Validation is
--     therefore preserved EXACTLY — this migration re-implements none of it.
--
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (0159/0160/0161/0162/0163 precedent)
-- `supabase db push --linked` does NOT wrap a migration file in an explicit
-- transaction. A bare `SET LOCAL lock_timeout` therefore emits
-- `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
-- silently NEVER ARMS, and the file is not atomic. This file opens the
-- transaction itself so the timeout genuinely arms and the whole migration
-- commits or rolls back as one unit.
--
-- Migration max 0163 -> 0164.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- Shared authorization contract for both commands
-- ===========================================================================
-- 1. auth.uid() must be non-null. A service-role / no-JWT caller is REFUSED —
--    ordinary practitioner charting must not run through an admin client, so
--    there is deliberately no service-role path into these commands.
-- 2. The caller must be an ACTIVE practitioner. The practitioner row is looked
--    up BY auth.uid(); the caller never supplies a practitioner id, so a
--    foreign practitioner cannot be asserted.
-- 3. studio_id and client_id are read from the trusted `sessions` row, never
--    from a parameter. The session must belong to the caller's studio, which
--    is what rejects cross-studio and foreign-session references.
-- 4. `p_client_id` is accepted ONLY as an assertion to re-check against the
--    session's real client_id — it can refuse, never redirect. This mirrors
--    `assertSessionVisible(studio.id, clientId, sessionId)` in the deployed
--    action, so a mismatched client is refused exactly as it is today.
--
-- Errors are stable and non-sensitive: they name the failed rule, never a row
-- id, client name, studio name or clinical value.
-- ===========================================================================

create or replace function public.create_electrolysis_entry(
  p_session_id                     uuid,
  p_client_id                      uuid,
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
  v_studio_id  uuid;
  v_client_id  uuid;
  v_entry_id   uuid;
begin
  -- (1) An authenticated caller is required. Service role / no JWT is refused.
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;

  -- (2) + (3) Derive the studio from the SESSION, and require the caller to be
  -- an ACTIVE practitioner of that same studio. One statement so a caller can
  -- never pair a session from one studio with a practitioner row from another.
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
    -- is not an active practitioner of the session's studio. Deliberately one
    -- message — it must not disclose which of those was true.
    raise exception 'Session not found or not writable by this practitioner.'
      using errcode = 'check_violation';
  end if;

  -- (4) The asserted client must match the session's real client.
  if p_client_id is null or p_client_id is distinct from v_client_id then
    raise exception 'Session does not belong to that client.'
      using errcode = 'check_violation';
  end if;

  -- The block, when supplied, must belong to THIS session. This is what stops
  -- an entry being filed against another session's (or another client's)
  -- block. A NULL block_id is permitted — the column is nullable and the
  -- deployed action's legacy path can still resolve a block itself.
  if p_block_id is not null then
    if not exists (
      select 1
        from public.session_blocks b
       where b.id = p_block_id
         and b.session_id = p_session_id
         and b.studio_id = v_studio_id
         and b.deleted_at is null
    ) then
      raise exception 'Block does not belong to this session.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- A supplied probe lot must belong to this studio's inventory. Mirrors
  -- validateProbeLotId in the deployed action; an absent lot is fine.
  if p_probe_lot_id is not null then
    if not exists (
      select 1
        from public.probe_lots l
       where l.id = p_probe_lot_id
         and l.studio_id = v_studio_id
    ) then
      raise exception 'Probe lot does not belong to this studio.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The write. Every clinical value is passed through verbatim so the existing
  -- CHECK constraints and 0119/0159/0160 guard triggers remain the ONLY
  -- validation authority — this command adds no new rule and relaxes none.
  --
  -- `galvanic_intensity_percent` is a RETIRED reading and is deliberately NOT
  -- a parameter: a new row always stores NULL, server-authoritatively, exactly
  -- as the deployed action does. A forged value has nowhere to land.
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
    p_mode, p_intensity, p_duration_seconds,
    coalesce(p_pulse_count, 1), p_pulse_delay_seconds, p_comments,
    coalesce(p_observation_chips, '[]'::jsonb), p_apilus_modality,
    p_energy_level, p_minutes_performed, p_probe_type, p_machine_frequency,
    p_hairs_treated, p_galvanic_ma, p_galvanic_duration_seconds,
    null,
    p_thermolysis_intensity_percent, p_thermolysis_duration_seconds,
    p_units_of_lye
  )
  returning id into v_entry_id;

  -- Only the id — the deployed action needs nothing else from the write, and
  -- performs its own separate persisted-row verification read afterwards.
  return v_entry_id;
end;
$$;

create or replace function public.create_laser_entry(
  p_session_id        uuid,
  p_client_id         uuid,
  p_zone              text,
  p_session_number    integer,
  p_equipment_params  jsonb,
  p_observation_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_client_id uuid;
  v_entry_id  uuid;
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
    raise exception 'Session not found or not writable by this practitioner.'
      using errcode = 'check_violation';
  end if;

  if p_client_id is null or p_client_id is distinct from v_client_id then
    raise exception 'Session does not belong to that client.'
      using errcode = 'check_violation';
  end if;

  insert into public.laser_entries (
    session_id, zone, session_number, equipment_params, observation_notes
  )
  values (
    p_session_id, p_zone, p_session_number, p_equipment_params,
    p_observation_notes
  )
  returning id into v_entry_id;

  return v_entry_id;
end;
$$;

-- ===========================================================================
-- Privileges — least privilege, and the 0129/0130 lesson applied up front
-- ===========================================================================
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to `anon` at create time,
-- and PostgreSQL grants EXECUTE to PUBLIC by default. 0129 revoked only
-- `from public` and left `anon` holding EXECUTE, which 0130 had to clean up.
-- Both are revoked explicitly here, by name, in the same migration that
-- creates the functions.
--
-- EXECUTE is granted to `authenticated` ONLY. There is deliberately no
-- service_role grant: ordinary practitioner charting must not run through an
-- admin client, and these commands require a non-null auth.uid() anyway.
-- `postgres` retains ownership and its implicit maintenance access.
-- ===========================================================================

revoke execute on function public.create_electrolysis_entry(
  uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer,
  numeric, text, jsonb, text, integer, integer, text, text, integer, numeric,
  integer, integer, numeric, numeric
) from public;
revoke execute on function public.create_electrolysis_entry(
  uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer,
  numeric, text, jsonb, text, integer, integer, text, text, integer, numeric,
  integer, integer, numeric, numeric
) from anon;
grant execute on function public.create_electrolysis_entry(
  uuid, uuid, uuid, text, text[], text, uuid, text, numeric, numeric, integer,
  numeric, text, jsonb, text, integer, integer, text, text, integer, numeric,
  integer, integer, numeric, numeric
) to authenticated;

revoke execute on function public.create_laser_entry(
  uuid, uuid, text, integer, jsonb, text
) from public;
revoke execute on function public.create_laser_entry(
  uuid, uuid, text, integer, jsonb, text
) from anon;
grant execute on function public.create_laser_entry(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- READ-ONLY POST-APPLY VERIFICATION (run against production AFTER applying).
--
--   -- (a) both commands exist, SECURITY DEFINER, search_path pinned
--   select p.proname, p.prosecdef, array_to_string(p.proconfig, ',')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('create_electrolysis_entry','create_laser_entry');
--   -- expect prosecdef = true and proconfig = search_path="" for BOTH
--
--   -- (b) EXECUTE is authenticated-only
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'execute') as anon_x,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
--          has_function_privilege('service_role',  p.oid, 'execute') as svc_x
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('create_electrolysis_entry','create_laser_entry');
--   -- expect anon_x = false, auth_x = true for BOTH
--
--   -- (c) NOTHING was revoked by this migration — direct DML must still work
--   select has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins,
--          has_table_privilege('authenticated','public.laser_entries','insert')        as l_ins;
--   -- expect BOTH true; this phase is additive and revokes nothing
--
-- L18 REMAINS OPEN. This migration moves two of 25 runtime writers onto
-- commands. It revokes no grant and drops no policy.
-- ---------------------------------------------------------------------------
