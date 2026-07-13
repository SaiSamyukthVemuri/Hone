-- ---------------------------------------------------------------------------
-- Migration 0129: atomic create/update of a settings block + its structured
-- area set (Willow multi-area charting, on the 0128 foundation).
--
-- WHY. The first multi-area implementation replaced a block's session_block_areas
-- from application code as delete-then-bulk-insert. supabase-js has no cross-
-- statement transaction, so a failure AFTER the delete could permanently remove
-- the previously-saved structured area set (per-area laterality included), with
-- only the legacy primary_area projection surviving — a clinical-record
-- data-loss risk. These SECURITY DEFINER functions perform the block write + the
-- legacy projection + the COMPLETE structured area set inside ONE transaction, so
-- it is all-or-nothing. No application-side compensating soft-delete is needed.
--
-- SECURITY. Both functions run as the definer (bypassing RLS) but authorize the
-- CALLER explicitly: is_studio_member(p_studio_id) (studio membership via
-- auth.uid()) plus a same-studio/same-session check on the target block/session.
-- search_path is pinned; EXECUTE is granted to authenticated only (anon/public
-- revoked). The 0128 studio-derive trigger + laterality CHECK + unique
-- (block, area, laterality) still fire on the area inserts (the ultimate
-- backstop); a violation rolls the whole transaction back.
--
-- Additive. Does NOT modify migration 0128, the session_block_areas table, any
-- RLS policy, or existing data. No backfill.
-- ---------------------------------------------------------------------------

-- Insert a block's structured area set from a validated jsonb array
-- [{area, laterality, display_order?}, ...]. Order falls back to array position.
-- (Helper is inlined in both functions rather than a shared SQL function to keep
-- the transactional boundary obvious.)

create or replace function public.create_session_block_with_areas(
  p_studio_id  uuid,
  p_session_id uuid,
  p_block      jsonb,   -- settable session_blocks column values (no id/studio/session/sort)
  p_areas      jsonb    -- [{area, laterality, display_order?}]
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

  -- Cast the caller-provided column bag once (clean type coercion).
  r := jsonb_populate_record(null::public.session_blocks, p_block);

  insert into public.session_blocks (
    studio_id, session_id, sort_order, block_name,
    mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
    probe_lot_number, probe_lot_confirmed,
    primary_area, side, custom_area_detail,
    probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
    probe_size_value, probe_length, probe_label,
    tolerance_rating, reaction_type, reaction_notes,
    caution_for_next_session, caution_note, numbing_status
  ) values (
    p_studio_id, p_session_id, v_sort, r.block_name,
    r.mode, r.apilus_modality, r.energy_level, r.minutes_performed, r.machine_frequency,
    r.probe_lot_number, coalesce(r.probe_lot_confirmed, false),
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
  p_studio_id  uuid,
  p_session_id uuid,
  p_block_id   uuid,
  p_block      jsonb,   -- settable session_blocks column values (patch)
  p_areas      jsonb    -- the COMPLETE new area set
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r public.session_blocks%rowtype;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;

  r := jsonb_populate_record(null::public.session_blocks, p_block);

  update public.session_blocks b set
    mode = r.mode, apilus_modality = r.apilus_modality, energy_level = r.energy_level,
    minutes_performed = r.minutes_performed, machine_frequency = r.machine_frequency,
    probe_lot_number = r.probe_lot_number,
    probe_lot_confirmed = coalesce(r.probe_lot_confirmed, false),
    primary_area = r.primary_area, side = r.side, custom_area_detail = r.custom_area_detail,
    probe_key = r.probe_key, probe_brand = r.probe_brand, probe_material = r.probe_material,
    probe_piece_type = r.probe_piece_type, probe_shank = r.probe_shank,
    probe_size_value = r.probe_size_value, probe_length = r.probe_length, probe_label = r.probe_label,
    tolerance_rating = r.tolerance_rating, reaction_type = r.reaction_type,
    reaction_notes = r.reaction_notes,
    caution_for_next_session = coalesce(r.caution_for_next_session, false),
    caution_note = r.caution_note, numbing_status = r.numbing_status
  where b.id = p_block_id
    and b.studio_id = p_studio_id
    and b.session_id = p_session_id
    and b.deleted_at is null;
  if not found then
    raise exception 'session block % not found in studio %/session %', p_block_id, p_studio_id, p_session_id;
  end if;

  -- Complete replacement of the structured area set — delete + insert in the
  -- SAME transaction, so the prior set can never be left deleted-without-replacement.
  delete from public.session_block_areas where session_block_id = p_block_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select p_block_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);
end;
$$;

-- Least privilege: authenticated may EXECUTE (RLS enforced inside via
-- is_studio_member); anon/public cannot.
revoke all on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb) from public;
revoke all on function public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb) to service_role;
