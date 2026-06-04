-- Migration 0061: studio members can INSERT studio_timed_blocks.
--
-- PR #140. PR #139 added the calendar drag-to-block UX with a
-- server action (createCalendarTimedBlockAction in
-- app/(app)/calendar/calendar-block-actions.ts) that is
-- intentionally available to every ACTIVE PRACTITIONER -- the
-- product rule for that action is "any active studio member can
-- block their own time on the calendar".
--
-- The pre-existing RLS posture on public.studio_timed_blocks did
-- not match that product rule:
--
--   studio_timed_blocks_member_select  FOR SELECT  is_studio_member
--   studio_timed_blocks_owner_all      FOR ALL     is_studio_owner
--
-- The owner_all policy gave owners SELECT + INSERT + UPDATE +
-- DELETE; non-owner practitioners only had SELECT. The drag-to-
-- block flow therefore worked for owners but failed RLS for
-- non-owner active practitioners, even though the application
-- layer allowed it.
--
-- This migration aligns the DB posture with the action layer for
-- INSERT only. UPDATE and DELETE remain owner-only because
-- managing the studio's blocks-of-record (editing categories,
-- removing past blocks, bulk cleanup) is the admin / owner
-- workflow surfaced in Settings -> Breaks & blocks. If Chloe
-- later asks for non-owner edit/delete a future migration will
-- widen those specifically; we deliberately do NOT add a broad
-- FOR ALL member policy here.
--
-- Posture after this migration:
--
--   studio_timed_blocks_member_select   SELECT   is_studio_member  (existing)
--   studio_timed_blocks_member_insert   INSERT   is_studio_member  (NEW)
--   studio_timed_blocks_owner_all       ALL      is_studio_owner   (existing)
--
-- Why the new policy targets 'authenticated' explicitly while the
-- legacy ones target 'public': the legacy policies fall back to a
-- helper-function check that already excludes anon traffic
-- (is_studio_member / is_studio_owner return false when
-- auth.uid() is null), but every policy added since migration
-- 0055 has used the 'TO authenticated' shape to make the intent
-- self-documenting. We carry that forward here.
--
-- Strictly additive + idempotent. Existing owner_all and
-- member_select policies are NOT modified; the new policy is
-- preceded by DROP POLICY IF EXISTS so re-running is safe.

drop policy if exists "studio_timed_blocks_member_insert"
  on public.studio_timed_blocks;
create policy "studio_timed_blocks_member_insert"
  on public.studio_timed_blocks for insert
  to authenticated
  with check (public.is_studio_member(studio_id));

comment on table public.studio_timed_blocks is
  'Practitioner-authored intra-day blocks. studio_timed_blocks_member_select grants SELECT to studio members via is_studio_member. studio_timed_blocks_member_insert (PR #140 / migration 0061) grants INSERT to studio members via is_studio_member so the calendar drag-to-block action in app/(app)/calendar/calendar-block-actions.ts works for active non-owner practitioners. studio_timed_blocks_owner_all keeps SELECT / INSERT / UPDATE / DELETE for owners; UPDATE and DELETE remain owner-only by design (admin / Settings workflow). No anon access at any of the three policies (the helper functions reject auth.uid() IS NULL).';
