-- PULSE COUNT MAY BE BLANK (provisional number; assigned at seal). Forward migration. NOT APPLIED. Lives under docs/proposals until numbered.
-- An untouched pulse count stays NULL instead of silently becoming 1; a touched count (1 to 10) is stored as is. The 1..10 range check stands.
-- Existing rows are unchanged (they keep their stored 1). Readers: the reading-history trigger treats numeric fields generically, so NULL
-- is a recorded blank like every other optional reading (tested).
begin;
set local lock_timeout = '5s';

do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'write_electrolysis_entry') <> 'edd5b247e7c6cb82b9d9e30f044fc2fd' then
    raise exception 'write_electrolysis_entry is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
end $$;
do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'copy_session_setup') <> '49951df17fbad7661b549bc6a8c8f5ce' then
    raise exception 'copy_session_setup is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
end $$;

alter table public.electrolysis_entries alter column pulse_count drop not null;
alter table public.electrolysis_entries alter column pulse_count drop default;

CREATE OR REPLACE FUNCTION public.write_electrolysis_entry(p_entry_id uuid, p_session_id uuid, p_block_id uuid, p_area text, p_areas text[], p_probe_size text, p_probe_lot_id uuid, p_mode text, p_intensity numeric, p_duration_seconds numeric, p_pulse_count integer, p_pulse_delay_seconds numeric, p_comments text, p_observation_chips jsonb, p_apilus_modality text, p_energy_level integer, p_minutes_performed integer, p_probe_type text, p_machine_frequency text, p_hairs_treated integer, p_galvanic_ma numeric, p_galvanic_duration_seconds integer, p_thermolysis_intensity_percent integer, p_thermolysis_duration_seconds numeric, p_units_of_lye numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      p_mode, p_intensity, p_duration_seconds, p_pulse_count,
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
$function$;

CREATE OR REPLACE FUNCTION public.copy_session_setup(p_studio_id uuid, p_target_session_id uuid, p_practitioner_id uuid, p_specs jsonb, p_idempotency_key text, p_expected_source_fingerprint text, p_expected_source_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_client       uuid;
  v_started      timestamptz;
  v_modality     text;
  v_status       text;
  v_blocks       integer;
  v_entries      integer;
  v_source       uuid;
  v_source2      uuid;
  v_fp           text;
  v_req_hash     text;
  v_prior_ids    uuid[];
  v_prior_hash   text;
  v_ids          uuid[] := '{}';
  v_sort         integer := 0;
  v_block_id     uuid;
  spec           jsonb;
  b              public.session_blocks%rowtype;
  e              public.electrolysis_entries%rowtype;
begin
  -- 1. Authorization: the passed practitioner must be an ACTIVE member of the
  --    studio (service_role bypasses RLS, so we check explicitly here).
  perform 1 from public.practitioners
    where id = p_practitioner_id and studio_id = p_studio_id and active = true;
  if not found then
    raise exception 'not authorized' using errcode = 'HN001';
  end if;

  -- 2. Input shape (defense in depth). The source identity + fingerprint are
  --    REQUIRED — a commit cannot proceed without the preview's source.
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) = 0
     or p_expected_source_session_id is null
     or p_expected_source_fingerprint is null then
    raise exception 'invalid request' using errcode = 'HN007';
  end if;
  if jsonb_typeof(coalesce(p_specs, 'null'::jsonb)) is distinct from 'array'
     or jsonb_array_length(p_specs) = 0
     or jsonb_array_length(p_specs) > 50 then
    raise exception 'invalid request' using errcode = 'HN007';
  end if;

  -- Request hash over the BROWSER-provided request (target + source identity +
  -- source fingerprint + specs), SHA-256 via pgcrypto. Stable per preview so a
  -- genuine retry matches; a different payload or source does not.
  v_req_hash := encode(extensions.digest(
    p_target_session_id::text || '|' ||
    p_expected_source_session_id::text || '|' ||
    p_expected_source_fingerprint || '|' ||
    p_specs::text, 'sha256'), 'hex');

  -- 3. Lock the TARGET session row (serializes all copies for one target,
  --    key-independent). Correctness relies on READ COMMITTED (PostgREST default):
  --    after the lock releases, the loser's emptiness recount takes a fresh
  --    snapshot and sees the winner's rows. Do NOT run under REPEATABLE READ.
  select s.client_id, s.started_at, s.modality, s.record_status
    into v_client, v_started, v_modality, v_status
    from public.sessions s
   where s.id = p_target_session_id
     and s.studio_id = p_studio_id
     and s.deleted_at is null
   for update;
  if not found then
    raise exception 'target not found' using errcode = 'HN002';
  end if;

  -- 4. Idempotency: an already-committed batch (same key) short-circuits BEFORE
  --    the emptiness/source work. Same request → replay; different payload/source
  --    (different hash) → reject as ambiguous.
  select created_block_ids, request_hash
    into v_prior_ids, v_prior_hash
    from public.session_copy_operations
   where target_session_id = p_target_session_id
     and idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash is distinct from v_req_hash then
      raise exception 'ambiguous idempotency key' using errcode = 'HN006';
    end if;
    return jsonb_build_object(
      'created_block_ids', to_jsonb(v_prior_ids),
      'copied_block_count', coalesce(array_length(v_prior_ids, 1), 0),
      'idempotent_replay', true
    );
  end if;

  -- 5. Target must be an editable, empty electrolysis draft.
  if v_modality is distinct from 'electrolysis' or v_status is distinct from 'draft' then
    raise exception 'target not eligible' using errcode = 'HN002';
  end if;
  select count(*) into v_blocks
    from public.session_blocks
   where session_id = p_target_session_id and deleted_at is null;
  select count(*) into v_entries
    from public.electrolysis_entries
   where session_id = p_target_session_id and deleted_at is null;
  if v_blocks > 0 or v_entries > 0 then
    raise exception 'target not empty' using errcode = 'HN003';
  end if;

  -- 6. Derive the canonical source (server-authoritative); the browser's id must
  --    match it exactly.
  v_source := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source is null then
    raise exception 'no eligible source' using errcode = 'HN004';
  end if;
  if p_expected_source_session_id <> v_source then
    raise exception 'source changed' using errcode = 'HN005';
  end if;

  -- 6b. Pin the SOURCE against concurrent edits for the rest of the txn, in a
  --     deterministic order (session → blocks → areas → entries, by id) to avoid
  --     deadlocks. FOR UPDATE on the session + block rows also blocks concurrent
  --     child INSERTs (their FK validation needs FOR KEY SHARE, which conflicts),
  --     so no phantom block/area/entry can be attached mid-commit. Re-derive after
  --     the session lock; reject if the canonical source changed.
  perform 1 from public.sessions where id = v_source for update;
  v_source2 := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source2 is distinct from v_source then
    raise exception 'source changed' using errcode = 'HN005';
  end if;
  -- Aliases sb/sba/se avoid colliding with the declared rowtype vars b/e.
  perform sb.id from public.session_blocks sb
    where sb.session_id = v_source and sb.deleted_at is null
    order by sb.id for update;
  perform sba.id from public.session_block_areas sba
    where sba.session_block_id in (
      select sb.id from public.session_blocks sb
       where sb.session_id = v_source and sb.deleted_at is null)
    order by sba.id for update;
  perform se.id from public.electrolysis_entries se
    where se.session_id = v_source and se.deleted_at is null
    order by se.id for update;

  -- 7. Now that the source is pinned, compute the fingerprint and reject if it
  --    differs from the one the preview was built on (zero rows on mismatch).
  v_fp := public._whole_session_copy_fingerprint(v_source);
  if v_fp is distinct from p_expected_source_fingerprint then
    raise exception 'source changed' using errcode = 'HN005';
  end if;

  -- 8. Create the reviewed records. SETUP columns only (no outcomes, no
  --    minutes_performed). jsonb_populate_record parses the payload into the
  --    rowtype; we then read only the allow-listed setup fields.
  for spec in select value from jsonb_array_elements(p_specs) loop
    b := jsonb_populate_record(null::public.session_blocks, spec->'block');
    if jsonb_array_length(coalesce(spec->'areas', '[]'::jsonb)) = 0
       or jsonb_array_length(coalesce(spec->'areas', '[]'::jsonb)) > 25 then
      raise exception 'invalid request' using errcode = 'HN007';
    end if;
    v_sort := v_sort + 1;
    insert into public.session_blocks (
      studio_id, session_id, sort_order,
      mode, apilus_modality, energy_level, machine_frequency,
      probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
      probe_size_value, probe_length, probe_label,
      primary_area, side, custom_area_detail
    ) values (
      p_studio_id, p_target_session_id, v_sort,
      b.mode, b.apilus_modality, b.energy_level, b.machine_frequency,
      b.probe_key, b.probe_brand, b.probe_material, b.probe_piece_type, b.probe_shank,
      b.probe_size_value, b.probe_length, b.probe_label,
      b.primary_area, b.side, b.custom_area_detail
    )
    returning id into v_block_id;
    v_ids := v_ids || v_block_id;

    insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
    select v_block_id, p_studio_id, (a->>'area'), (a->>'laterality'),
           coalesce((a->>'display_order')::int, (ord - 1)::int)
      from jsonb_array_elements(spec->'areas') with ordinality as t(a, ord);

    if (spec ? 'entry') and (spec->'entry') is not null and jsonb_typeof(spec->'entry') = 'object' then
      e := jsonb_populate_record(null::public.electrolysis_entries, spec->'entry');
      insert into public.electrolysis_entries (
        session_id, block_id, area, areas,
        mode, apilus_modality, energy_level, machine_frequency,
        thermolysis_intensity_percent, thermolysis_duration_seconds,
        galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent,
        units_of_lye, pulse_count, pulse_delay_seconds
      ) values (
        p_target_session_id, v_block_id, e.area, coalesce(e.areas, array[e.area]::text[]),
        e.mode, e.apilus_modality, e.energy_level, e.machine_frequency,
        e.thermolysis_intensity_percent, e.thermolysis_duration_seconds,
        -- galvanic_intensity_percent is a RETIRED reading (Phase A): a NEW copied
        -- entry ALWAYS stores a literal NULL. The spec never carries it (canonical
        -- normalization drops it), and this literal makes the RPC authoritative —
        -- even a forged spec containing galvanic_intensity_percent=42 stores NULL.
        e.galvanic_ma, e.galvanic_duration_seconds, NULL,
        -- pulse_count is nullable (an untouched count stays NULL); copied as is when the
        -- reviewed source had none so the copy matches the column default.
        e.units_of_lye, e.pulse_count, e.pulse_delay_seconds
      );
    end if;
  end loop;

  -- 9. Provenance ledger.
  insert into public.session_copy_operations (
    studio_id, target_session_id, source_session_id, created_by_practitioner_id,
    idempotency_key, request_hash, source_fingerprint, copied_block_count, created_block_ids
  ) values (
    p_studio_id, p_target_session_id, v_source, p_practitioner_id,
    p_idempotency_key, v_req_hash, v_fp, coalesce(array_length(v_ids, 1), 0), v_ids
  );

  return jsonb_build_object(
    'created_block_ids', to_jsonb(v_ids),
    'copied_block_count', coalesce(array_length(v_ids, 1), 0),
    'idempotent_replay', false
  );
end;
$function$;

commit;
