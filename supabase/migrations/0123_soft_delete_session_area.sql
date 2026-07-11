-- ---------------------------------------------------------------------------
-- Willow P1-B: remove an incorrectly-recorded treatment AREA from a draft chart.
--
-- A "treatment area" is a public.session_blocks row (0019/0039). Today a
-- practitioner can only remove a single PASS (electrolysis_entries/laser_entries
-- via "Remove pass", 0114); there is no way to remove a whole wrongly-recorded
-- AREA. The block-level soft-delete action (softDeleteSessionBlockAction) exists
-- but (a) was never wired to the UI and (b) soft-deletes ONLY the block row,
-- leaving its child passes + images active-but-hidden (orphaned) — not atomic.
--
-- This adds ONE trusted, atomic soft-delete transaction: soft-void the block
-- AND its block-scoped electrolysis passes AND its block-scoped treatment images
-- together, with mandatory reason + full actor/time attribution, writing a
-- session_audit event and NEVER hard-deleting clinical history.
--
-- Safety:
--   * Draft/legacy-unlocked ONLY. Finalized/void records are rejected up front
--     (and the 0119 finalized-write guard is the backstop — no bypass here).
--   * Same-studio authorization is derived from the row via is_studio_member +
--     the calling active practitioner (auth.uid()); nothing is trusted from the
--     client except the ids + reason.
--   * SECURITY DEFINER, EXECUTE granted to authenticated only (revoked from
--     anon/public). Mirrors the finalize_session grant posture (0119).
--   * Soft-delete only — historical rows are preserved (deleted_at set); the
--     existing per-row soft-delete RLS paths are untouched.
--
-- Scope note: laser_entries have NO block_id (laser passes link by session_id
-- only, 0114) so they are NOT block-scoped and are intentionally NOT touched
-- here — a laser "area" block removal voids the block + its block-scoped images
-- only. Electrolysis (the Willow pilot modality) is fully covered.
--
-- Additive: one new function. Prod migration max was 0122; this is 0123.
-- ---------------------------------------------------------------------------

create or replace function public.soft_delete_session_area(
  p_session_id uuid,
  p_block_id uuid,
  p_reason text
) returns table (entries_removed integer, images_removed integer)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_status text;
  v_actor uuid;
  v_area_label text;
  v_entries integer := 0;
  v_images integer := 0;
begin
  -- Lock the area (block) joined to its session; derive studio + status + a
  -- human area label from the row. is_studio_member(auth.uid()) enforces tenancy.
  select b.studio_id,
         s.record_status,
         coalesce(
           nullif(btrim(
             coalesce(b.primary_area, '') || ' ' ||
             coalesce(b.side, '') || ' ' ||
             coalesce(b.custom_area_detail, '')
           ), ''),
           b.block_name,
           'area'
         )
    into v_studio, v_status, v_area_label
  from public.session_blocks b
  join public.sessions s on s.id = b.session_id
  where b.id = p_block_id
    and b.session_id = p_session_id
    and b.deleted_at is null
    and public.is_studio_member(b.studio_id)
  for update of b;
  if not found then
    raise exception 'Treatment area not found or not editable' using errcode = 'check_violation';
  end if;

  -- The actor must be an active practitioner in this studio.
  select p.id into v_actor
  from public.practitioners p
  where p.user_id = auth.uid()
    and p.studio_id = v_studio
    and p.active = true
  limit 1;
  if v_actor is null then
    raise exception 'Caller is not an active practitioner in this studio' using errcode = 'check_violation';
  end if;

  -- Finalized / void clinical records are immutable — never removed here.
  if v_status in ('finalized', 'void') then
    raise exception 'Finalized records cannot be edited' using errcode = 'check_violation';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'A reason of at least 10 characters is required' using errcode = 'check_violation';
  end if;

  -- 1) Soft-delete the AREA (block).
  update public.session_blocks
     set deleted_at = now(), deleted_by = v_actor, delete_reason = btrim(p_reason)
   where id = p_block_id and deleted_at is null;

  -- 2) Soft-delete its block-scoped electrolysis passes (triad).
  update public.electrolysis_entries
     set deleted_at = now(), deleted_by = v_actor,
         delete_reason = 'Area removed: ' || btrim(p_reason)
   where block_id = p_block_id and deleted_at is null;
  get diagnostics v_entries = row_count;

  -- 3) Soft-delete its block-scoped treatment images (no delete_reason column).
  update public.treatment_images
     set deleted_at = now(), deleted_by = v_actor
   where session_block_id = p_block_id and deleted_at is null;
  get diagnostics v_images = row_count;

  -- 4) Explicit audit event (in addition to the per-row triad above).
  insert into public.session_audit
    (session_id, edited_by_practitioner_id, field, old_value, new_value)
  values
    (p_session_id, v_actor, 'area_removed', v_area_label, btrim(p_reason));

  return query select v_entries, v_images;
end;
$$;

revoke all on function public.soft_delete_session_area(uuid, uuid, text) from public;
revoke all on function public.soft_delete_session_area(uuid, uuid, text) from anon;
grant execute on function public.soft_delete_session_area(uuid, uuid, text) to authenticated;
