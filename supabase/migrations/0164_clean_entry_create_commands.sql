-- ---------------------------------------------------------------------------
-- 0164 — L18 Phase 1A: a narrow create command for the ONE clean entry writer
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
-- two entry tables, exactly ONE is genuinely entry-only:
--
--   * addLaserEntryAction -> laser_entries INSERT, and nothing else
--
-- This migration adds a command for that writer, and NOTHING else.
--
-- DELIBERATELY NOT MOVED — ALL THREE electrolysis writers are block-coupled:
--
--   * createTreatmentAreaWithEntryAction and updateTreatmentAreaWithEntryAction
--     each write session_blocks AND electrolysis_entries as ONE user intent.
--     The create path compensates with a soft delete; the update path does not
--     compensate at all.
--   * addElectrolysisEntryAction is ALSO block-coupled, which an earlier
--     revision of this migration got wrong. When the submitted form omits
--     `block_id` — a legacy caller shape the action deliberately still
--     supports — it calls `ensureBlockForSession`, which INSERTs a
--     `session_blocks` row before the entry is written. The two writes are in
--     separate transactions, so if the entry write then fails the newly created
--     block remains. It is therefore NOT cleanly separable and must move with
--     the block phase.
--
-- Splitting only the entry half of any of these onto an RPC would leave the
-- pair straddling two transactions — exactly the non-atomicity that exists
-- today. Making them genuinely atomic requires a command that owns BOTH
-- writes, which is session_blocks work. All three move together in the
-- combined session_blocks/electrolysis_entries phase, and all three are pinned
-- as temporary exceptions by the static drift guard in
-- tests/security/entry-direct-dml-guard.test.ts.
--
-- THIS MIGRATION MAKES NO CLAIM ABOUT electrolysis_entries. That table is not
-- command-bound in any respect by 0164.
--
-- NO PRIVILEGE OR POLICY IS REVOKED HERE. This migration is purely additive:
-- direct DML remains available on BOTH entry tables for the whole of this
-- phase (and is the ONLY path for electrolysis), so
-- the deployed application keeps working before, during and after the apply.
--
-- SAFETY
-- ===========================================================================
--   * Additive only: ONE function. NO table, column, constraint, index,
--     policy, grant-removal or trigger change.
--   * NO data change, NO backfill, NO deletion.
--   * The function is SECURITY DEFINER with `search_path = ''`, so every
--     reference below is schema-qualified.
--   * It reads no runtime setting and takes no studio_id or practitioner id
--     from the caller — all lineage is derived from trusted rows. There is NO
--     dynamic SQL and NO generic JSON patch.
--   * Existing clinical guard triggers still fire on the INSERT this function
--     performs (SECURITY DEFINER changes the privilege context, not
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
-- Authorization contract
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
-- creates the function.
--
-- EXECUTE is granted to `authenticated` ONLY. There is deliberately no
-- service_role grant: ordinary practitioner charting must not run through an
-- admin client, and this command requires a non-null auth.uid() anyway.
-- `postgres` retains ownership and its implicit maintenance access.
-- ===========================================================================

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
--   -- (a) the command exists, SECURITY DEFINER, search_path pinned
--   select p.proname, p.prosecdef, array_to_string(p.proconfig, ',')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'create_laser_entry';
--   -- expect prosecdef = true and proconfig = search_path=""
--   -- and NO create_electrolysis_entry function should exist
--
--   -- (b) EXECUTE is authenticated-only
--   select p.proname,
--          has_function_privilege('anon',          p.oid, 'execute') as anon_x,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
--          has_function_privilege('service_role',  p.oid, 'execute') as svc_x
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'create_laser_entry';
--   -- expect anon_x = false, auth_x = true
--
--   -- (c) NOTHING was revoked by this migration — direct DML must still work
--   select has_table_privilege('authenticated','public.electrolysis_entries','insert') as e_ins,
--          has_table_privilege('authenticated','public.laser_entries','insert')        as l_ins;
--   -- expect BOTH true; this phase is additive and revokes nothing
--
-- L18 REMAINS OPEN. This migration moves ONE of 25 runtime writers onto a
-- command. It revokes no grant and drops no policy, and it does not make
-- electrolysis_entries command-bound in any respect.
-- ---------------------------------------------------------------------------
