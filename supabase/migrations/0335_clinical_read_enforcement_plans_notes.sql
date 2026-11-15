-- 0335 (I3): clinical-read enforcement, plans, notes, budget, record history. Roles clinical-read gating, Sam decision of 12 Nov 2026
-- ("database enforcement of record permissions"; "Restricted users must not receive clinical contents or derived counts, names, dates or session history").
-- Builds on 0333 (clin_key_studios).
--
-- WHAT THIS CHANGES: the SELECT policies of these tables stop being membership-only. A row is readable by an authenticated ACTIVE PRACTITIONER of its
-- studio who holds the key through has_studio_permission (0287):
--   clin.view_records          treatment_plans, treatment_plan_stages, treatment_goals, client_clinical_notes, client_pinned_notes,
--                              clinical_record_snapshots, clinical_record_amendments
--   client.view_personal_notes client_personal_notes
--   client.view_budget         client_budget_context
--   clin.view_records AND rep.audit_log_view   clinical_audit_events  (both keys must be held)
-- PROPOSED DEFAULTS, SAM TO CONFIRM: the whole table-to-key mapping above (Team census v2, fail-closed). Pinned notes ride on clin.view_records;
-- treatment goals ride on clin.view_records (they are part of the treatment plan record).
--
-- clinical_audit_events: rep.audit_log_view has snapshot Off/Off, so while that key is PENDING a practitioner no longer reads this table directly from
-- the moment this migration lands (the owner still does). No application code reads it with a signed-in client (the only readers are SECURITY DEFINER
-- functions and the retired-record migration), so nothing visible changes today; the table is simply closed to a role that the catalog says may not
-- see the studio-wide audit log.
--
-- WHAT IT DOES NOT CHANGE (by design)
--   * Who can read TODAY for the other tables. clin.view_records / client.view_personal_notes / client.view_budget have snapshot practitioner = studio,
--     and a pending or unreleased key resolves to its snapshot, so existing practitioners keep access until the owner narrows the key. The owner passes.
--   * Receptionists (is_studio_member covers practitioners only; this helper does too). Service-role code and SECURITY DEFINER functions bypass RLS.
--   * INSERT / UPDATE / DELETE policies and write keys. Note that an INSERT ... RETURNING and an UPDATE evaluate the SELECT policy on the row, so a
--     practitioner without the read key can no longer add a row and read it back; the matching write keys already require the read key in the catalog.
--   * Table grants (anon grants are I4, 0336).
--
-- Policies that were not `to authenticated` (treatment_plans, client_pinned_notes) become so: anon matched them only through a false auth.uid() test.

begin;
set local lock_timeout = '5s';

-- ---- clin.view_records ---------------------------------------------------------------------------------------------------------------
alter policy treatment_plans_studio_member_read on public.treatment_plans to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_plan_stages_studio_member_select on public.treatment_plan_stages to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy treatment_goals_studio_member_select on public.treatment_goals to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy client_clinical_notes_member_select on public.client_clinical_notes to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy client_pinned_notes_studio_member_read on public.client_pinned_notes to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy clinical_record_snapshots_member_select on public.clinical_record_snapshots to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));
alter policy clinical_record_amendments_member_select on public.clinical_record_amendments to authenticated
  using (studio_id in (select k from public.clin_key_studios('clin.view_records') k));

-- ---- their own keys ------------------------------------------------------------------------------------------------------------------
alter policy client_personal_notes_studio_member_select on public.client_personal_notes to authenticated
  using (studio_id in (select k from public.clin_key_studios('client.view_personal_notes') k));
alter policy client_budget_context_member_select on public.client_budget_context to authenticated
  using (studio_id in (select k from public.clin_key_studios('client.view_budget') k));

-- ---- record history: BOTH keys --------------------------------------------------------------------------------------------------------
alter policy clinical_audit_events_member_select on public.clinical_audit_events to authenticated
  using (
    studio_id in (select k from public.clin_key_studios('clin.view_records') k)
    and studio_id in (select k from public.clin_key_studios('rep.audit_log_view') k)
  );

commit;
