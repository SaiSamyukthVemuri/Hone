-- 0157: whole-session "Copy areas and settings from last session" — atomic batch
-- commit + idempotency ledger (Chloe).
--
-- The preview a practitioner reviews is EPHEMERAL (component memory only — it
-- creates nothing). Exactly one explicit action ("Add these areas to today's
-- chart") calls the RPC below, which — in ONE transaction — creates the reviewed
-- destination records: for each spec a session_block + its structured areas + a
-- first electrolysis_entry, then records an idempotency-ledger row so a retry /
-- double-submit is an at-most-once no-op.
--
-- SETUP-ONLY BY CONSTRUCTION: the INSERT column lists below carry only the
-- reusable SETUP fields from the reviewed treatment-setup contract
-- (lib/sessions/treatment-setup-snapshot.ts) plus the treated AREA. Outcome
-- columns (comments, observation_chips, hairs_treated, tolerance_rating,
-- reaction_type/notes, caution_*, numbing_*, probe_lot_*/probe_inventory_item_id,
-- started_at/ended_at, block_name/notes, legacy probe_type/size/intensity/
-- duration_seconds) are NEVER read from the payload, so a copy can never carry
-- forward what actually happened to the client.
--
-- ADDITIVE + SAFE: one new ledger table + one new RPC. NO change to any existing
-- table, column, index, policy, grant, or the 0129/0155/0156 block/area RPCs.
-- NO backfill. RLS on the new table is member-scoped read-only; the ledger is
-- written ONLY by this SECURITY DEFINER RPC (no browser insert/update/delete).
-- probe_lots + electrolysis_entries.probe_lot_id stay dormant/untouched.
--
-- ROLLOUT = MIGRATION-FIRST (DB-first). The new application reads/writes these
-- objects, so this migration MUST be applied to production BEFORE the app PR
-- merges/deploys — app-first is NOT safe. DB-first IS safe: these are brand-new
-- objects the old application never references. Full order + verification:
-- docs/runbooks/0157-whole-session-copy-rollout.md

-- ===========================================================================
-- A. Idempotency ledger for a whole-session copy batch.
-- ===========================================================================
create table if not exists public.session_copy_operations (
  id                uuid primary key default gen_random_uuid(),
  studio_id         uuid not null references public.studios(id) on delete cascade,
  session_id        uuid not null,
  idempotency_key   text not null,
  created_block_ids uuid[] not null default '{}',
  created_by        uuid,
  created_at        timestamptz not null default now(),
  constraint session_copy_operations_session_same_studio_fk
    foreign key (studio_id, session_id)
    references public.sessions (studio_id, id) on delete cascade,
  constraint session_copy_operations_idem_uniq unique (session_id, idempotency_key),
  constraint session_copy_operations_idem_len check (char_length(idempotency_key) between 1 and 200)
);

comment on table public.session_copy_operations is
  '0157: at-most-once ledger for whole-session "Copy areas and settings" batches. One row per committed copy (unique on session_id + idempotency_key); created_block_ids records what that batch created so a retry is a no-op. Written ONLY by copy_session_setup (SECURITY DEFINER).';

alter table public.session_copy_operations enable row level security;

-- Members may READ their own studio's copy-operation rows. Rows are WRITTEN only
-- by the SECURITY DEFINER RPC below (no browser insert/update/delete policy),
-- mirroring the least-privilege posture of the charting RPCs.
create policy "session_copy_operations: members select"
  on public.session_copy_operations for select to authenticated
  using (public.is_studio_member(studio_id));

revoke all on public.session_copy_operations from anon;

-- ===========================================================================
-- B. The atomic batch-copy RPC. Creates N (block + areas + first entry) tuples
--    from p_specs in one transaction, with idempotency. p_specs is a JSON array
--    of { block: {...setup...}, areas: [{area,laterality,display_order}],
--    entry: {...setup readings...} | null }.
-- ===========================================================================
create or replace function public.copy_session_setup(
  p_studio_id       uuid,
  p_session_id      uuid,
  p_specs           jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_existing uuid[];
  v_ids      uuid[] := '{}';
  v_sort     integer;
  v_block_id uuid;
  spec       jsonb;
  b          public.session_blocks%rowtype;
  e          public.electrolysis_entries%rowtype;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;
  perform 1 from public.sessions
    where id = p_session_id and studio_id = p_studio_id and deleted_at is null;
  if not found then
    raise exception 'session % not found in studio %', p_session_id, p_studio_id;
  end if;
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) = 0 then
    raise exception 'idempotency key is required';
  end if;

  -- Batch shape + size: p_specs must be a non-empty JSON array within sane
  -- bounds (defense-in-depth against a hand-crafted RPC call — the app never
  -- sends an empty/oversized batch: the commit CTA is disabled with no cards
  -- and the server action rejects an empty specs array).
  if jsonb_typeof(coalesce(p_specs, 'null'::jsonb)) is distinct from 'array' then
    raise exception 'specs must be a JSON array';
  end if;
  if jsonb_array_length(p_specs) = 0 then
    raise exception 'no specs to copy';
  end if;
  if jsonb_array_length(p_specs) > 50 then
    raise exception 'too many specs in one copy (max 50)';
  end if;

  -- Serialize concurrent commits that share a key so a true double-submit
  -- resolves as a clean idempotent replay (below) rather than one request
  -- losing the ledger unique constraint. The lock releases at transaction end.
  perform pg_advisory_xact_lock(hashtext(p_session_id::text || ':' || p_idempotency_key));

  -- Idempotency: an already-committed batch returns its prior ids (no new rows).
  select created_block_ids into v_existing
    from public.session_copy_operations
   where session_id = p_session_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('created_block_ids', to_jsonb(v_existing), 'idempotent_replay', true);
  end if;

  select coalesce(max(sort_order), 0) into v_sort
    from public.session_blocks
   where session_id = p_session_id and deleted_at is null;

  for spec in select value from jsonb_array_elements(coalesce(p_specs, '[]'::jsonb)) loop
    -- Block: SETUP columns only (allow-list). jsonb_populate_record parses the
    -- payload into the rowtype; we then read only the setup fields below, so any
    -- outcome key present in the payload is ignored.
    b := jsonb_populate_record(null::public.session_blocks, spec->'block');
    if jsonb_array_length(coalesce(spec->'areas', '[]'::jsonb)) > 25 then
      raise exception 'too many areas in one block (max 25)';
    end if;
    v_sort := v_sort + 1;
    insert into public.session_blocks (
      studio_id, session_id, sort_order,
      mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
      probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
      probe_size_value, probe_length, probe_label,
      primary_area, side, custom_area_detail
    ) values (
      p_studio_id, p_session_id, v_sort,
      b.mode, b.apilus_modality, b.energy_level, b.minutes_performed, b.machine_frequency,
      b.probe_key, b.probe_brand, b.probe_material, b.probe_piece_type, b.probe_shank,
      b.probe_size_value, b.probe_length, b.probe_label,
      b.primary_area, b.side, b.custom_area_detail
    )
    returning id into v_block_id;
    v_ids := v_ids || v_block_id;

    insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
    select v_block_id, p_studio_id, (a->>'area'), (a->>'laterality'),
           coalesce((a->>'display_order')::int, (ord - 1)::int)
      from jsonb_array_elements(coalesce(spec->'areas', '[]'::jsonb)) with ordinality as t(a, ord);

    -- First entry: SETUP readings only (mode-gated values are already resolved by
    -- the caller). Outcome columns (comments, observation_chips, hairs_treated,
    -- probe_lot_id, legacy intensity/duration/probe_type/size) are NOT written.
    if (spec ? 'entry') and (spec->'entry') is not null and jsonb_typeof(spec->'entry') = 'object' then
      e := jsonb_populate_record(null::public.electrolysis_entries, spec->'entry');
      insert into public.electrolysis_entries (
        session_id, block_id, area, areas,
        mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
        thermolysis_intensity_percent, thermolysis_duration_seconds,
        galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent,
        units_of_lye, pulse_count, pulse_delay_seconds
      ) values (
        p_session_id, v_block_id, e.area, coalesce(e.areas, array[e.area]::text[]),
        e.mode, e.apilus_modality, e.energy_level, e.minutes_performed, e.machine_frequency,
        e.thermolysis_intensity_percent, e.thermolysis_duration_seconds,
        e.galvanic_ma, e.galvanic_duration_seconds, e.galvanic_intensity_percent,
        e.units_of_lye, e.pulse_count, e.pulse_delay_seconds
      );
    end if;
  end loop;

  insert into public.session_copy_operations
    (studio_id, session_id, idempotency_key, created_block_ids, created_by)
  values (p_studio_id, p_session_id, p_idempotency_key, v_ids, auth.uid());

  return jsonb_build_object('created_block_ids', to_jsonb(v_ids), 'idempotent_replay', false);
end;
$$;

revoke all on function public.copy_session_setup(uuid, uuid, jsonb, text) from public, anon;
grant execute on function public.copy_session_setup(uuid, uuid, jsonb, text) to authenticated, service_role;

-- Verification SQL (operator runs after apply):
--   select table_name from information_schema.tables where table_name='session_copy_operations';
--   select conname from pg_constraint where conname='session_copy_operations_idem_uniq';
--   select proname, prosecdef from pg_proc where proname='copy_session_setup';
--   select has_function_privilege('anon','public.copy_session_setup(uuid,uuid,jsonb,text)','execute');  -- false
