-- 0343 (W1 remainder): clinical WRITE enforcement for treatment goals, pinned notes, personal notes and budget context. Roles program, Sam decision
-- (relayed by OPS, 14 Nov 2026): database write enforcement is required before full Roles enforcement is claimed. Builds on 0333 (clin_key_studios)
-- and 0335 (the matching SELECT gates). Evidence: team/EVIDENCE-W1-write-gap-0289-8ee580b18.md (an INSERT without RETURNING needs no SELECT
-- visibility, so the read gate alone did not stop a practitioner who lacks the key from adding rows).
--
-- WHAT THIS CHANGES: the INSERT and UPDATE policies of these tables stop being membership-only. A row may be written by an authenticated ACTIVE
-- PRACTITIONER of its studio who holds the SAME key the read side asks for, through has_studio_permission (0287):
--   clin.view_records          treatment_goals, client_pinned_notes
--   client.view_personal_notes client_personal_notes
--   client.view_budget         client_budget_context
-- Each key is the one the SELECT policy already uses, so a user who cannot read a table cannot write it, and an upsert (INSERT .. ON CONFLICT DO
-- UPDATE, which the app uses for goals, personal notes and budget) is judged by the same key at every step.
-- PROPOSED DEFAULTS, SAM TO CONFIRM: no separate write key. client.edit_personal_notes and client.edit_budget exist in the catalog but are not used
-- here; the engine already caps an edit key by its view key (NQ-10), so keying writes by the view key is the narrowest safe choice that needs no
-- new catalog decision. Goals and pinned notes have no write key in the catalog; they ride on clin.view_records as on the read side.
--
-- UNCHANGED ON PURPOSE
--   * The attribution clause of the budget policies (updated_by_practitioner_id must be the caller's own active practitioner row) is kept.
--   * client_pinned_notes has NO UPDATE policy (0022) and the owner-only DELETE policy (0254) is untouched. The edit-a-caution action updates
--     through the service-role client and so is a SYSTEM PATH that row-level security cannot see; its application gate (active practitioner of the
--     current studio, own cautions only unless owner) stays the only check there. Documented gap, not hidden.
--   * Who can write TODAY. The three keys have snapshot practitioner = studio, and a pending or unreleased key resolves to its snapshot, so
--     existing practitioners keep access until the owner narrows a key. The owner passes. Receptionists are not practitioners and write nothing here.
--   * Service-role code and SECURITY DEFINER functions bypass row-level security (0254 definer code is the only one that touches these tables).
--   * Table grants, SELECT policies, triggers, other tables, and the chart tables (0289 owns those).
--
-- client_pinned_notes_studio_member_insert was not `to authenticated` (0022); it becomes so. Anon matched it only through a false auth.uid() test.

begin;
set local lock_timeout = '5s';

-- ---- clin.view_records ---------------------------------------------------------------------------------------------------------------
alter policy treatment_goals_studio_member_insert on public.treatment_goals to authenticated
  with check (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_goals_studio_member_update on public.treatment_goals to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k))
  with check (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy client_pinned_notes_studio_member_insert on public.client_pinned_notes to authenticated
  with check (studio_id in (select k from public.clin_key_studios('clin.view_records') k));

-- ---- their own keys ------------------------------------------------------------------------------------------------------------------
alter policy client_personal_notes_studio_member_insert on public.client_personal_notes to authenticated
  with check (studio_id in (select k from public.clin_key_studios('client.view_personal_notes') k));
alter policy client_personal_notes_studio_member_update on public.client_personal_notes to authenticated
  using (studio_id in (select k from public.clin_key_studios('client.view_personal_notes') k))
  with check (studio_id in (select k from public.clin_key_studios('client.view_personal_notes') k));

alter policy client_budget_context_member_insert on public.client_budget_context to authenticated
  with check (
    studio_id in (select k from public.clin_key_studios('client.view_budget') k)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );
alter policy client_budget_context_member_update on public.client_budget_context to authenticated
  using (studio_id in (select k from public.clin_key_studios('client.view_budget') k))
  with check (
    studio_id in (select k from public.clin_key_studios('client.view_budget') k)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

commit;
