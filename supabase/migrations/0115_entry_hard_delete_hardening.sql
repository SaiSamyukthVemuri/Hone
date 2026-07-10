-- 0115_entry_hard_delete_hardening.sql
--
-- Close the residual HARD-DELETE path on treatment PASSES.
--
-- Migration 0114 + PR #391 introduced an audited SOFT-DELETE (deleted_at /
-- deleted_by / delete_reason) for electrolysis_entries and laser_entries, and
-- the app actions now only soft-delete. BUT migration 0087 deliberately KEPT a
-- `for delete to authenticated` RLS policy on both tables (for the old bare-✕
-- hard-delete affordance), and the platform-default DELETE grant to
-- authenticated/anon was never revoked. So an authenticated studio member could
-- still BYPASS the soft-delete by issuing a direct PostgREST DELETE on a
-- same-studio pass row — physically destroying the clinical record and
-- defeating the 0114 audit trail. (Confirmed by independent verification.)
--
-- This migration removes that authority to match the soft-delete intent and the
-- posture already used for the other clinical tables (sessions / session_blocks
-- have NO delete policy; imported_treatment_memory (0089) and treatment_images
-- (0092) revoke truncate/delete). After this migration:
--   * authenticated / anon: NO delete — the RLS delete policy is dropped AND the
--     grant is revoked (belt-and-suspenders). Removals must go through the
--     soft-delete UPDATE path (PR #391).
--   * service_role: UNCHANGED — it bypasses RLS and keeps its own grant, so
--     genuine maintenance / right-to-erasure remains possible if ever needed.
--   * SELECT / INSERT / UPDATE policies and their grants are UNCHANGED — PR #391
--     "Remove pass" (a soft-delete UPDATE) keeps working, and cross-studio
--     access stays blocked by session_is_visible() on the surviving policies.
--
-- Policy/grant-only. No schema change, no data change, no backfill, no existing
-- row touched. Idempotent (`drop policy if exists`; REVOKE is idempotent). This
-- HARDENS RLS (removes an authority); it does not weaken it. Migration max
-- 0114 -> 0115.

-- 1. Drop the authenticated DELETE policies (created in 0087:238-240 / 261-263).
drop policy if exists "electrolysis_entries: members delete" on public.electrolysis_entries;
drop policy if exists "laser_entries: members delete" on public.laser_entries;

-- 2. Revoke the platform-default DELETE + TRUNCATE grant from the client roles
--    (mirrors 0089:361 / 0092:106). service_role is not a target and is
--    unaffected.
revoke truncate, delete on public.electrolysis_entries from anon, authenticated;
revoke truncate, delete on public.laser_entries from anon, authenticated;
