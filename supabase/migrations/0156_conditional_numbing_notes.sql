-- 0156: conditional numbing notes (Chloe).
--
-- When a practitioner records "Numbing used" while charting a treatment area,
-- they may add ONE optional free-text note about what was used or observed. This
-- migration adds the single nullable column that holds it and teaches the two
-- authoritative atomic RPCs to carry it. Nothing else changes.
--
-- ADDITIVE + SAFE: one nullable text column, NO default, NO backfill, NO existing
-- row is rewritten, NO RLS/policy/trigger/table change. The numbing_notes value
-- is normalized in the app (trim; blank -> NULL; kept only when
-- numbing_status = 'used'); the DB stores whatever the validated app sends and
-- imposes no CHECK/length constraint (an operator length cap is deliberately not
-- added — a clinical free-text note has no fixed real-world maximum, and the app
-- already trims/normalizes).
--
-- ROLLOUT = MIGRATION-FIRST (DB-first). The new application selects/writes
-- numbing_notes, so this migration MUST be applied to production BEFORE the
-- application PR merges/deploys — app-first is NOT safe. DB-first IS safe: the
-- RPCs below use jsonb_populate_record, so an OLD app payload that OMITS
-- numbing_notes resolves the field to NULL (no note is fabricated) and every
-- existing numbing_status behaviour is unchanged. Full order + verification:
-- docs/runbooks/0156-conditional-numbing-notes-rollout.md
--
-- probe_lots and electrolysis_entries.probe_lot_id remain dormant/untouched.

-- ===========================================================================
-- A. The column.
-- ===========================================================================
alter table public.session_blocks
  add column if not exists numbing_notes text;

comment on column public.session_blocks.numbing_notes is
  '0156: optional free-text note for a numbing-used treatment area. NULL for every legacy row and whenever numbing_status is not ''used''. App-normalized (trimmed; blank -> NULL). No default, no backfill.';

-- ===========================================================================
-- B. Carry the column through the two authoritative atomic RPCs. Bodies are the
--    0155 definitions with numbing_notes added to the create insert + the update
--    SET. Signatures are unchanged; the value travels inside p_block. An absent
--    p_block key -> NULL (old-app compatibility).
-- ===========================================================================
create or replace function public.create_session_block_with_areas(
  p_studio_id  uuid,
  p_session_id uuid,
  p_block      jsonb,
  p_areas      jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id   uuid;
  v_sort integer;
  r      public.session_blocks%rowtype;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;
  perform 1 from public.sessions
    where id = p_session_id and studio_id = p_studio_id and deleted_at is null;
  if not found then
    raise exception 'session % not found in studio %', p_session_id, p_studio_id;
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_sort
    from public.session_blocks
   where session_id = p_session_id and deleted_at is null;

  r := jsonb_populate_record(null::public.session_blocks, p_block);

  insert into public.session_blocks (
    studio_id, session_id, sort_order, block_name,
    mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
    probe_lot_number, probe_lot_confirmed, probe_inventory_item_id,
    primary_area, side, custom_area_detail,
    probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
    probe_size_value, probe_length, probe_label,
    tolerance_rating, reaction_type, reaction_notes,
    caution_for_next_session, caution_note, numbing_status, numbing_notes
  ) values (
    p_studio_id, p_session_id, v_sort, r.block_name,
    r.mode, r.apilus_modality, r.energy_level, r.minutes_performed, r.machine_frequency,
    r.probe_lot_number, coalesce(r.probe_lot_confirmed, false), r.probe_inventory_item_id,
    r.primary_area, r.side, r.custom_area_detail,
    r.probe_key, r.probe_brand, r.probe_material, r.probe_piece_type, r.probe_shank,
    r.probe_size_value, r.probe_length, r.probe_label,
    r.tolerance_rating, r.reaction_type, r.reaction_notes,
    coalesce(r.caution_for_next_session, false), r.caution_note, r.numbing_status, r.numbing_notes
  )
  returning id into v_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select v_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);

  return v_id;
end;
$$;

create or replace function public.update_session_block_with_areas(
  p_studio_id           uuid,
  p_session_id          uuid,
  p_block_id            uuid,
  p_block               jsonb,
  p_areas               jsonb,
  p_expected_updated_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r        public.session_blocks%rowtype;
  v_current timestamptz;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;

  select updated_at into v_current
    from public.session_blocks
   where id = p_block_id
     and studio_id = p_studio_id
     and session_id = p_session_id
     and deleted_at is null
   for update;
  if not found then
    raise exception 'session block % not found in studio %/session %', p_block_id, p_studio_id, p_session_id;
  end if;
  if p_expected_updated_at is not null and v_current <> p_expected_updated_at then
    raise exception 'stale_block_version: this settings block was changed elsewhere';
  end if;

  -- ONLY the allow-listed columns below are ever written. studio_id, session_id,
  -- sort_order, id, deleted_at, created_at, block_name/block_notes, and every
  -- other column are NOT read from p_block, so a caller cannot re-tenant or
  -- mutate unrelated fields.
  r := jsonb_populate_record(null::public.session_blocks, p_block);

  update public.session_blocks b set
    mode = r.mode, apilus_modality = r.apilus_modality, energy_level = r.energy_level,
    minutes_performed = r.minutes_performed, machine_frequency = r.machine_frequency,
    probe_lot_number = r.probe_lot_number,
    probe_lot_confirmed = coalesce(r.probe_lot_confirmed, false),
    probe_inventory_item_id = r.probe_inventory_item_id,
    primary_area = r.primary_area, side = r.side, custom_area_detail = r.custom_area_detail,
    probe_key = r.probe_key, probe_brand = r.probe_brand, probe_material = r.probe_material,
    probe_piece_type = r.probe_piece_type, probe_shank = r.probe_shank,
    probe_size_value = r.probe_size_value, probe_length = r.probe_length, probe_label = r.probe_label,
    tolerance_rating = r.tolerance_rating, reaction_type = r.reaction_type,
    reaction_notes = r.reaction_notes,
    caution_for_next_session = coalesce(r.caution_for_next_session, false),
    caution_note = r.caution_note, numbing_status = r.numbing_status,
    numbing_notes = r.numbing_notes
  where b.id = p_block_id;

  delete from public.session_block_areas where session_block_id = p_block_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select p_block_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);
end;
$$;

-- Verification SQL (operator runs after apply):
--   select column_name, is_nullable, column_default, data_type
--     from information_schema.columns
--    where table_name='session_blocks' and column_name='numbing_notes';   -- text, YES, null default
--   select count(*) from public.session_blocks where numbing_notes is not null;  -- 0 (no backfill)
--   select (pg_get_functiondef('public.create_session_block_with_areas'::regprocedure) ilike '%numbing_notes%');
--   select (pg_get_functiondef('public.update_session_block_with_areas'::regprocedure) ilike '%numbing_notes%');
