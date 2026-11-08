-- 0310 (number decided by Sam, 7 Nov; local draft, not applied): validate the saved machine identity against the published mode contract.
-- LOCAL DRAFT ONLY. Not applied, not authorized to apply. Forward migration: 0301 is applied and frozen.
--
-- THE FINDING (Vercel Security Review 01M6VEJJ83G4GZ10DFCKMJAEVP, Low; confirmed on a local stack with a real JWT): every 0301 identity
-- command goes through apply_block_machine_identity, which checked the unit's studio, retirement and profile but only the SHAPE of the
-- mode key. A practitioner calling record_block_machine_identity directly could store any 1-120 character key, and an unregistered
-- profile text with no unit.
--
-- THE FIX: apply_block_machine_identity (the one function all three wrappers call; their bodies and grants are untouched) now
--   * refuses a mode that is not in machine_profile_mode_contract for the unit's profile AND version;
--   * refuses an option-gated mode when the unit's installed_options lack the required option;
--   * refuses a unit-less identity unless it is the legacy xCell Pur machine ('dectro-apilus:xcell', no mode).
-- The checks sit after the receipt replay and the stale-version check, so a committed attempt is still answered from its receipt, and
-- the session -> block lock order is unchanged. No grant changes. No data is read or written by the migration itself: existing rows
-- that already carry an off-contract mode are NOT rewritten (a separate, counted decision).
--
-- Same-studio data integrity only: the block must belong to the caller's studio, so nothing crosses studios.

begin;
set local lock_timeout = '5s';

create or replace function public.apply_block_machine_identity(
  p_block_id           uuid,
  p_studio_id          uuid,
  p_profile_id         text,
  p_studio_machine_id  uuid,
  p_mode_key           text,
  p_expected_updated_at timestamptz default null,
  p_receipt_kind       text default null,
  p_idempotency_key    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_new timestamptz;
  v_current timestamptz;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_digest text;
  v_receipt public.block_write_receipts%rowtype;
  v_profile text := nullif(btrim(coalesce(p_profile_id, '')), '');
  v_mode text := nullif(btrim(coalesce(p_mode_key, '')), '');
  v_unit_profile text;
  v_unit_version integer;
  v_unit_options text[];
  v_requires text;
  v_session_id uuid;
begin
  -- THE HELD VERSION IS CHECKED INSIDE THIS TRANSACTION, under the row lock
  -- (Codex 4476240827, decided by OPS). A caller that holds the block's
  -- updated_at passes it; a mismatch is the same refusal as the block commands'
  -- own stale check, so a write by another tab between the caller's read and
  -- this call is detected, never overwritten. The NEW updated_at comes back from
  -- the same UPDATE ... RETURNING, so the caller adopts exactly the version its
  -- own write produced and no separate read can race it.
  --
  -- THE SESSION MUST BE LIVE, AND IS LOCKED BEFORE THE BLOCK (Codex 4486745915).
  -- assert_session_writable (0166, frozen) does not look at sessions.deleted_at, and
  -- soft_delete_session (0167) stamps the session and leaves its blocks alone, so a direct
  -- call could change the machine identity of a block in a removed session. The session is
  -- read from the block (a plain read, no lock), then locked FOR SHARE with the liveness
  -- test in the same statement, then the block is locked FOR UPDATE and must still belong
  -- to it. That is the documented order: SESSION, then BLOCK (0166 assert_block_in_session,
  -- 0223 assert_setup_scope; copy_session_setup and correct_finalized_session hold the
  -- session FOR UPDATE and then want its blocks). FOR SHARE is the same mode the
  -- record_setup_submission_with_identity wrapper already holds, so it is a no-op there.
  select b.session_id into v_session_id
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = p_studio_id
     and b.deleted_at is null;
  if not found then
    raise exception 'Block not found.' using errcode = 'check_violation';
  end if;
  perform 1
    from public.sessions s
   where s.id = v_session_id
     and s.studio_id = p_studio_id
     and s.deleted_at is null
     for share;
  if not found then
    raise exception '%', 'Session not found or not writable by this practitioner.' using errcode = 'check_violation';
  end if;
  select b.updated_at into v_current
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = p_studio_id
     and b.session_id = v_session_id
     and b.deleted_at is null
     for update;
  if not found then
    raise exception 'Block not found.' using errcode = 'check_violation';
  end if;
  -- A SAME-KEY REPLAY IS ANSWERED FROM ITS RECEIPT, BEFORE ANY CHECK THAT DEPENDS ON THE BLOCK'S CURRENT STATE.
  -- The earlier attempt committed and its answer was lost; the block may since have been edited, the unit retired or
  -- the version moved on, none of which changes what that attempt did. The stored version is the one THAT write
  -- produced (never the current one, Insurance N-8), so the caller adopts it and any later edit still conflicts on
  -- its next save. The same key with a different identity is refused, never answered with the original.
  if v_key is not null then
    if p_receipt_kind is null or p_receipt_kind not in ('identity', 'readings', 'create') then
      raise exception 'A receipt kind is required with a retry key.' using errcode = 'check_violation';
    end if;
    if length(v_key) not between 8 and 100 then
      raise exception 'The retry key is not valid.' using errcode = 'check_violation';
    end if;
    v_digest := md5(
      coalesce(nullif(btrim(coalesce(p_profile_id, '')), ''), '') || '|' ||
      coalesce(p_studio_machine_id::text, '') || '|' ||
      coalesce(nullif(btrim(coalesce(p_mode_key, '')), ''), ''));
    -- THE READINGS KIND NEVER REPLAYS FROM HERE (Privacy RV-1). A readings replay is decided by 0223's own submission claim
    -- (record_treatment_setup_submission, in the wrapper): this function is reached only for a submission the wrapper judged NEW.
    -- If the claim were ever gone while this key's receipt remained, answering from the receipt would hand back a stale version for
    -- readings that were just written; a new submission instead writes a fresh receipt over the stale one (below).
    if p_receipt_kind <> 'readings' then
      select r.* into v_receipt
        from public.block_write_receipts r
       where r.session_block_id = p_block_id
         and r.studio_id = p_studio_id
         and r.kind = p_receipt_kind
         and r.idempotency_key = v_key;
    end if;
    if found and p_receipt_kind <> 'readings' then
      if v_receipt.payload_digest <> v_digest then
        raise exception 'That save key was already used for a different machine choice.'
          using errcode = 'unique_violation';
      end if;
      return jsonb_build_object(
        'updated_at', v_receipt.resulting_updated_at,
        'reused', true,
        'machine_profile_id', v_receipt.machine_profile_id,
        'studio_machine_id', v_receipt.studio_machine_id,
        'machine_mode_key', v_receipt.machine_mode_key);
    end if;
  end if;
  if p_expected_updated_at is not null and v_current <> p_expected_updated_at then
    raise exception 'stale_block_version: this settings block was changed elsewhere';
  end if;

  if p_studio_machine_id is not null then
    select m.machine_profile_id, m.machine_profile_version, m.installed_options
      into v_unit_profile, v_unit_version, v_unit_options
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
    -- THE MODE MUST BE ONE THIS UNIT'S PROFILE VERSION PUBLISHED, AND ITS OPTION MUST BE FITTED (0301 mode-key finding, Vercel
    -- Security Review 01M6VEJJ83G4GZ10DFCKMJAEVP). Until now the mode was only shape-checked (1-120 characters), so a direct call could
    -- store a key no model offers. This sits AFTER the same-key receipt replay and the stale-version check above, so a committed
    -- attempt is still answered from its receipt and never becomes an error, and the lock order is unchanged. It mirrors the 0223
    -- submission command: the contract row must exist (fail closed), and the unit's own installed options decide an option-gated mode.
    if v_mode is not null then
      select c.requires_installed_option into v_requires
        from public.machine_profile_mode_contract c
       where c.machine_profile_id = v_unit_profile
         and c.machine_profile_version = v_unit_version
         and c.mode_key = v_mode;
      if not found then
        raise exception 'That machine does not offer that mode.'
          using errcode = 'check_violation';
      end if;
      if v_requires is not null
         and not (v_requires = any (coalesce(v_unit_options, '{}'::text[]))) then
        raise exception 'This machine does not have the % option fitted, so its mode cannot be recorded.', v_requires
          using errcode = 'check_violation';
      end if;
    end if;
  else
    if v_profile is null then
      raise exception 'A machine model is required.'
        using errcode = 'check_violation';
    end if;
    if v_mode is not null then
      raise exception 'A mode needs a registered machine.'
        using errcode = 'check_violation';
    end if;
    -- WITHOUT A REGISTERED UNIT ONLY THE EXISTING xCell Pur IDENTITY IS SUPPORTED (the legacy workflow: a model with no unit and
    -- no mode). Any other profile text was previously accepted on length alone.
    if v_profile <> 'dectro-apilus:xcell' then
      raise exception 'A machine without a registered unit must be the xCell Pur machine.'
        using errcode = 'check_violation';
    end if;
  end if;


  -- AN AREA THAT ALREADY HOLDS xCell Pur READINGS NEVER GETS A NATIVE IDENTITY (Codex 4471593271, decided by OPS; protects
  -- the studio's existing records). Two machines' settings on one area, or the second overwriting the first, is the harm.
  -- The same list the app's lock uses: the legacy columns on the block and the legacy reading columns on its entries.
  -- A soft-deleted entry is not a reading (OPS decision on Insurance LK-1).
  -- Choosing the legacy xCell Pur machine itself stays allowed. The block row is already locked above, so this read is
  -- consistent with the write below. A new area (create wrapper) has no readings at this point.
  if v_profile <> 'dectro-apilus:xcell' and (
       exists (
         select 1
           from public.session_blocks b
          where b.id = p_block_id
            and (nullif(btrim(b.mode::text), '') is not null
                 or nullif(btrim(b.apilus_modality::text), '') is not null
                 or b.energy_level is not null
                 or nullif(btrim(b.machine_frequency::text), '') is not null))
       or exists (
         select 1
           from public.electrolysis_entries e
          where e.block_id = p_block_id
            and e.deleted_at is null
            and (e.thermolysis_intensity_percent is not null
                 or e.thermolysis_duration_seconds is not null
                 or e.galvanic_ma is not null
                 or e.galvanic_duration_seconds is not null
                 or e.units_of_lye is not null))) then
    raise exception 'This area already holds xCell Pur readings; add a new area for another machine.'
      using errcode = 'check_violation';
  end if;

  update public.session_blocks b
     set machine_profile_id = v_profile,
         studio_machine_id = p_studio_machine_id,
         machine_mode_key = v_mode
   where b.id = p_block_id
   returning b.updated_at into v_new;
  if v_key is not null then
    insert into public.block_write_receipts (
      session_block_id, studio_id, kind, idempotency_key, payload_digest,
      resulting_updated_at, machine_profile_id, studio_machine_id, machine_mode_key)
    values (
      p_block_id, p_studio_id, p_receipt_kind, v_key, v_digest,
      v_new, v_profile, p_studio_machine_id, v_mode)
    on conflict (session_block_id, kind, idempotency_key) do update
      set payload_digest = excluded.payload_digest,
          resulting_updated_at = excluded.resulting_updated_at,
          machine_profile_id = excluded.machine_profile_id,
          studio_machine_id = excluded.studio_machine_id,
          machine_mode_key = excluded.machine_mode_key;
  end if;
  return jsonb_build_object(
    'updated_at', v_new,
    'reused', false,
    'machine_profile_id', v_profile,
    'studio_machine_id', p_studio_machine_id,
    'machine_mode_key', v_mode);
end;
$$;

revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text) from public;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text) from anon;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text) from authenticated;
revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text) from service_role;

-- In-migration assertions: grants exactly as 0301 left them (the core function reachable by nobody; each wrapper by authenticated only),
-- the function still SECURITY DEFINER with the pinned search_path, and the new checks are present.
do $$
declare
  v_def text;
  v_cfg text[];
  r record;
begin
  if (select count(*) from pg_proc where proname = 'apply_block_machine_identity' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception '0310: apply_block_machine_identity must exist exactly once';
  end if;
  select pg_get_functiondef(p.oid), p.proconfig into v_def, v_cfg
    from pg_proc p where p.proname = 'apply_block_machine_identity' and p.pronamespace = 'public'::regnamespace;
  if v_def !~* 'security definer' or v_cfg is distinct from array['search_path=pg_catalog, pg_temp'] then
    raise exception '0310: apply_block_machine_identity lost SECURITY DEFINER or its pinned search_path';
  end if;
  if position('machine_profile_mode_contract' in v_def) = 0 or position('must be the xCell Pur machine' in v_def) = 0 then
    raise exception '0310: the mode-contract or unit-less checks are missing';
  end if;
  for r in
    select p.proname, p.oid, p.proacl, p.proowner
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('apply_block_machine_identity', 'record_block_machine_identity',
                         'create_block_with_initial_setup_and_identity', 'record_setup_submission_with_identity')
  loop
    if exists (select 1 from aclexplode(coalesce(r.proacl, acldefault('f', r.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
      raise exception '0310: % is executable by PUBLIC', r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'execute') or has_function_privilege('service_role', r.oid, 'execute') then
      raise exception '0310: % is executable by anon or service_role', r.proname;
    end if;
    if (r.proname = 'apply_block_machine_identity') <> (not has_function_privilege('authenticated', r.oid, 'execute')) then
      raise exception '0310: % has the wrong authenticated EXECUTE state', r.proname;
    end if;
  end loop;
end $$;

commit;
