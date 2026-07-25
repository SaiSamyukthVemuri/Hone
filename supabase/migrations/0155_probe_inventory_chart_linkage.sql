-- 0155: inventory-backed probe lot linkage (Chloe item #9).
--
-- Today a charted probe lot is a free-text snapshot on
-- session_blocks.probe_lot_number with NO durable link to the studio's sterile
-- inventory (record_keeping_sterile_items), and inventory rows have no
-- structured probe identity (only free-text item_description, matched by an
-- ILIKE '%probe%' heuristic). This migration makes the link durable, probe-
-- specific, and same-studio safe — additively and migration-first.
--
-- CANONICAL INVENTORY = public.record_keeping_sterile_items (0085). The legacy
-- public.probe_lots table and electrolysis_entries.probe_lot_id remain DORMANT:
-- this migration does NOT reference, revive, read, or write either of them. The
-- inventory-linked charting path introduced here goes exclusively through
-- record_keeping_sterile_items + session_blocks.
--
-- Nothing is backfilled. Existing rows are unchanged. No RLS policy is added,
-- removed, or weakened (the deliberate no-authenticated-DELETE posture of
-- record_keeping_sterile_items from 0085/0087 is preserved untouched).
--
-- ROLLOUT = MIGRATION-FIRST (DB-first). The new application code selects/writes
-- probe_key + probe_inventory_item_id, so this migration MUST be applied to
-- production BEFORE the application PR merges/deploys — app-first is NOT safe.
-- DB-first IS safe: the RPCs below accept OLD app payloads that omit
-- probe_inventory_item_id (an absent jsonb key resolves to NULL — no link is
-- fabricated). Full order + verification: docs/runbooks/0155-probe-inventory-linkage-rollout.md

-- ===========================================================================
-- A. Structured probe identity on the inventory row.
-- ===========================================================================
-- probe_key is the stable catalog key from lib/probes.ts (validated in the app
-- against the code catalog before writing). NULL = the sterile item is not
-- explicitly classified as a probe (or is a legacy/unclassified row). We never
-- infer it from item_description here — no backfill.
alter table public.record_keeping_sterile_items
  add column if not exists probe_key text;

alter table public.record_keeping_sterile_items
  drop constraint if exists record_keeping_sterile_items_probe_key_len;
alter table public.record_keeping_sterile_items
  add constraint record_keeping_sterile_items_probe_key_len
  check (probe_key is null or char_length(probe_key) <= 120);

-- ===========================================================================
-- B. Durable, same-studio inventory reference on charting.
-- ===========================================================================
-- B1. The FK target: a composite UNIQUE on the parent so a same-studio
--     composite FK can reference (studio_id, id). Trivially satisfied (id is
--     already the PK), no row rewrite. Mirrors the 0094 tenant pattern.
alter table public.record_keeping_sterile_items
  drop constraint if exists record_keeping_sterile_items_studio_id_uniq;
alter table public.record_keeping_sterile_items
  add constraint record_keeping_sterile_items_studio_id_uniq unique (studio_id, id);

-- B2. The nullable pointer on the charting row. NULL = manual/unlinked lot
--     (or legacy). Additive, no default, no backfill.
alter table public.session_blocks
  add column if not exists probe_inventory_item_id uuid;

-- B3. The same-studio composite FK. ON DELETE SET NULL (probe_inventory_item_id)
--     — the Postgres-17 column-list form — nulls ONLY the pointer, never the
--     NOT NULL studio_id, so:
--       * deleting a STUDIO still cascades cleanly (both tables carry
--         studio_id -> studios ON DELETE CASCADE; both endpoints go together);
--       * deleting/archiving an INVENTORY item never cascade-deletes clinical
--         charting — it only clears the link and leaves the block + its
--         probe_lot_number snapshot intact;
--       * a cross-studio probe_inventory_item_id can never be attached (the
--         studio_id must match on both sides);
--       * MATCH SIMPLE skips the check when the pointer is NULL (legacy blocks
--         with no link are valid).
alter table public.session_blocks
  drop constraint if exists session_blocks_probe_inventory_same_studio_fk;
alter table public.session_blocks
  add constraint session_blocks_probe_inventory_same_studio_fk
  foreign key (studio_id, probe_inventory_item_id)
  references public.record_keeping_sterile_items (studio_id, id)
  on delete set null (probe_inventory_item_id);

-- Keep the parent-delete SET-NULL scan cheap.
create index if not exists session_blocks_probe_inventory_item_idx
  on public.session_blocks (probe_inventory_item_id)
  where probe_inventory_item_id is not null;

-- ===========================================================================
-- C. Teach the 0129 atomic RPCs the new column.
-- ===========================================================================
-- The RPCs use a FIXED column allowlist (not a jsonb allowlist), so a new
-- column carried in p_block is silently dropped until the bodies reference it.
-- We CREATE OR REPLACE both with IDENTICAL signatures (no grant change) and add
-- probe_inventory_item_id to the insert/update column lists, sourced from
-- r.probe_inventory_item_id (inside p_block). studio_id/session_id/sort_order/id
-- are still sourced from the authorized parameters/server-compute, so the
-- anti-re-tenant guarantee is unchanged. The same-studio FK (B3) is the DB-level
-- backstop: a forged cross-studio id inside p_block fails the FK and aborts the
-- whole transaction. The application also validates the id server-side first.

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
    caution_for_next_session, caution_note, numbing_status
  ) values (
    p_studio_id, p_session_id, v_sort, r.block_name,
    r.mode, r.apilus_modality, r.energy_level, r.minutes_performed, r.machine_frequency,
    r.probe_lot_number, coalesce(r.probe_lot_confirmed, false), r.probe_inventory_item_id,
    r.primary_area, r.side, r.custom_area_detail,
    r.probe_key, r.probe_brand, r.probe_material, r.probe_piece_type, r.probe_shank,
    r.probe_size_value, r.probe_length, r.probe_label,
    r.tolerance_rating, r.reaction_type, r.reaction_notes,
    coalesce(r.caution_for_next_session, false), r.caution_note, r.numbing_status
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

  -- ONLY the allow-listed columns below are ever written (plus the new
  -- probe_inventory_item_id). studio_id, session_id, sort_order, id, deleted_at,
  -- created_at, block_name/block_notes, and every other column are NOT read from
  -- p_block, so a caller cannot re-tenant or mutate unrelated fields.
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
    caution_note = r.caution_note, numbing_status = r.numbing_status
  where b.id = p_block_id;

  delete from public.session_block_areas where session_block_id = p_block_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select p_block_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);
end;
$$;

-- Verification SQL (operator runs after apply):
--   select column_name from information_schema.columns
--    where table_name='record_keeping_sterile_items' and column_name='probe_key';
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname='session_blocks_probe_inventory_same_studio_fk';  -- SET NULL, not cascade
--   select conname from pg_constraint where conname='record_keeping_sterile_items_studio_id_uniq';
