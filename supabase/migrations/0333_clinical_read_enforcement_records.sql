-- 0333 (I1): clinical-read enforcement, treatment-record tables. Roles clinical-read gating, Sam decision of 12 Nov 2026
-- ("database enforcement of record permissions"; "Restricted users must not receive clinical contents or derived counts, names, dates or session history").
--
-- WHAT THIS CHANGES: the SELECT policies of the treatment-record tables stop being membership-only. A row is now readable by an authenticated
-- ACTIVE PRACTITIONER of its studio who holds the key through has_studio_permission (0287):
--   clin.view_records  sessions, session_blocks, session_block_areas, session_copy_operations, electrolysis_entries, laser_entries,
--                      treatment_setup_captures / readings / submissions, treatment_area_create_claims, treatment_reading_change_events,
--                      imported_treatment_memories (+ audit events), session_audit
--   clin.view_photos   treatment_images, photos          (its own key; independent of clin.view_records in both directions)
-- PROPOSED DEFAULTS, SAM TO CONFIRM: the photo key for `photos` (a legacy table), and the table-to-key mapping above as a whole.
--
-- WHAT IT DOES NOT CHANGE (by design):
--   * Who can read TODAY. has_studio_permission returns the SNAPSHOT for a key that is pending or has no release row, and the snapshot for
--     clin.view_records / clin.view_photos is practitioner = studio, so an existing practitioner keeps access until the owner narrows it.
--     The owner always passes. Service-role code and SECURITY DEFINER functions bypass RLS and are untouched.
--   * Receptionists. is_studio_member (and so every old policy) covers practitioners only; this helper does too, even if a receptionist is later
--     granted the key: receptionists read treatment data through the 0274 projection, not through these tables. No access is added.
--   * INSERT / UPDATE policies and write keys (clin.edit_*). Writes go through SECURITY DEFINER RPCs; out of scope.
--   * Table grants (the anon grants are I4, 0336) and the RPC read gates (I4).
--
-- PERFORMANCE: the key is evaluated ONCE per statement, not per row. `studio_id in (select ... from clin_key_studios(key))` is an uncorrelated
-- subquery (a hashed subplan). The entry tables have no studio_id, so they follow `sessions` itself: `session_id in (select id from sessions)`
-- runs under sessions' own policy, which makes a child table unable to be wider than its session.
--
-- Anon: every changed policy is `to authenticated`, so anon matches no policy (zero rows) and never evaluates the helper.

begin;
set local lock_timeout = '5s';

-- The studios in which the caller is an ACTIVE PRACTITIONER and holds the key. Empty for anon, for a non-member, for an unknown key.
create or replace function public.clin_key_studios(p_key text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select pr.studio_id
    from public.practitioners pr
   where auth.uid() is not null
     and pr.user_id = auth.uid()
     and pr.active
     and public.has_studio_permission(pr.studio_id, p_key)
$$;

revoke all on function public.clin_key_studios(text) from public, anon, authenticated, service_role;
grant execute on function public.clin_key_studios(text) to authenticated;

comment on function public.clin_key_studios(text) is
  '0333: studios where the caller is an active practitioner AND holds the permission key (has_studio_permission). Used by clinical SELECT policies as an uncorrelated subquery.';

-- ---- clin.view_records: tables with a studio_id --------------------------------------------------------------------------------------
alter policy "sessions: members select" on public.sessions to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy session_blocks_member_select on public.session_blocks to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy session_block_areas_member_select on public.session_block_areas to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy "session_copy_operations: members select" on public.session_copy_operations to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_area_create_claims_member_select on public.treatment_area_create_claims to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_setup_captures_member_select on public.treatment_setup_captures to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_setup_readings_member_select on public.treatment_setup_readings to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_setup_submissions_member_select on public.treatment_setup_submissions to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy "imported_treatment_memories: members select" on public.imported_treatment_memories to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy "imported_treatment_memory_audit_events: members select" on public.imported_treatment_memory_audit_events to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));

-- ---- clin.view_records: tables keyed by session (they follow sessions' own policy) --------------------------------------------------
alter policy "electrolysis_entries: members select" on public.electrolysis_entries to authenticated
  using (session_id in (select s.id from public.sessions s));
alter policy "laser_entries: members select" on public.laser_entries to authenticated
  using (session_id in (select s.id from public.sessions s));
alter policy session_audit_studio_member_read on public.session_audit to authenticated
  using (session_id in (select s.id from public.sessions s));

-- treatment_reading_change_events: keep its own session/client/studio consistency join, and make the key explicit rather than inherited.
alter policy treatment_reading_change_events_clinical_select on public.treatment_reading_change_events to authenticated
  using (
    treatment_reading_change_events.studio_id in (select k from public.clin_key_studios('clin.view_records') k)
    and exists (
      select 1 from public.sessions s
      join public.clients c on c.id = s.client_id and c.studio_id = s.studio_id
      where s.id = treatment_reading_change_events.session_id
        and s.studio_id = treatment_reading_change_events.studio_id
        and c.id = treatment_reading_change_events.client_id
    )
  );

-- ---- clin.view_photos -----------------------------------------------------------------------------------------------------------------
alter policy "treatment_images: members select" on public.treatment_images to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_photos') k));
alter policy "photos: members select" on public.photos to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_photos') k));

commit;
