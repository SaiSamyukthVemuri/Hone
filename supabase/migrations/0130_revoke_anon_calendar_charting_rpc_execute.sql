-- ---------------------------------------------------------------------------
-- Migration 0130: revoke the stray anon EXECUTE grant on the multi-area
-- charting RPCs (least-privilege hardening for migration 0129).
--
-- WHY. Migration 0129 created two SECURITY DEFINER functions and ran
--   revoke all on function ... from public;
--   grant execute on function ... to authenticated, service_role;
-- but it did NOT revoke from `anon`. Supabase's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE to anon on every new function at creation time, so revoking only from
-- PUBLIC left anon holding an explicit EXECUTE grant. Post-apply verification of
-- 0129 found anon EXECUTE on both RPCs.
--
-- NOT EXPLOITABLE (why this was a defense-in-depth gap, not a breach): each
-- function's first statement is `if not public.is_studio_member(p_studio_id)
-- then raise exception 'not authorized'`. An anonymous caller has
-- auth.uid() = null, is a member of no studio, and is rejected before any read
-- or write; anon also holds ZERO direct grants on session_block_areas. The data
-- was never reachable. This migration restores the intended least-privilege
-- posture so the grant layer matches the reviewed contract (mirrors migration
-- 0123 soft_delete_session_area, which revokes from public AND anon).
--
-- SCOPE. Grants only. Does NOT touch function bodies, ownership, SECURITY
-- DEFINER state, search_path, signatures, table grants, RLS, triggers,
-- constraints, or any data. No backfill. Migration 0129 is unchanged.
--
-- Intended final EXECUTE posture for both RPCs after this migration:
--   authenticated -> EXECUTE ; service_role -> EXECUTE ; anon -> none ; PUBLIC -> none
-- ---------------------------------------------------------------------------

revoke execute
  on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb)
  from anon;

revoke execute
  on function public.update_session_block_with_areas(
    uuid,
    uuid,
    uuid,
    jsonb,
    jsonb,
    timestamptz
  )
  from anon;
