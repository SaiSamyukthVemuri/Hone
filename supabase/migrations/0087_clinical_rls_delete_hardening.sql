-- Migration 0087: clinical RLS delete hardening (PR #217).
--
-- The 0001-era base policies (and several later tables) used broad
-- FOR ALL policies, which implicitly let any authenticated studio
-- member hard-DELETE core clinical/client-history rows directly via
-- Supabase even though the app exposes no such delete. That
-- contradicts the newer Record Keeping posture (PR #205/#206) and
-- risks the product's moat: treatment memory.
--
-- This migration is POLICY-ONLY: no schema change, no data change,
-- no backfill. For each table the broad FOR ALL policy is replaced
-- with explicit per-command policies using the same studio-scoped
-- expressions the old policy used (is_studio_member, or
-- session_is_visible for the entries tables).
--
-- Posture after this migration, for normal authenticated members:
--
--   NO DELETE (history is preserved; the app already archives or
--   soft-deletes these):
--     clients               (archive via archived_at, migration 0050)
--     sessions              (soft delete via deleted_at, 0013)
--     session_blocks        (soft delete via deleted_at, 0019)
--     photos                (no app delete path exists)
--     probe_lots            (dormant legacy table; no app usage)
--     client_intake_forms   (soft delete via deleted_at)
--     client_tags           (soft delete via deleted_at/deleted_by)
--     treatment_goals       (upsert-only in the app)
--     client_personal_notes (upsert-only in the app)
--
--   DELETE KEPT, now EXPLICIT (each is a clear, existing app
--   requirement with a UI affordance; previously implicit via FOR
--   ALL):
--     electrolysis_entries  (deleteElectrolysisEntryAction)
--     laser_entries         (deleteLaserEntryAction)
--     treatment_plan_stages (deleteTreatmentPlanStageAction)
--     client_pricing        (deleteClientPricingAction; pricing
--                            config, not clinical history)
--
-- Unchanged (out of scope or already correct): treatment_plans
-- (0024 was already per-command with NO delete), client_pinned_notes
-- (0022, explicit delete by design), session_audit /
-- appointment_audit / audit_logs (read+insert only),
-- record_keeping_* (PR #205/#206 posture), payment tables, auth
-- tables, and the booking/availability tables (operational, not
-- clinical history; reported separately).
--
-- Service-role and table-owner access is unaffected, as everywhere.
-- Re-runnable throughout; no anon access; no grants.

-- ---------------------------------------------------------------------------
-- clients: select/insert/update; NO delete (archive via archived_at).
-- ---------------------------------------------------------------------------
drop policy if exists "clients: members all" on public.clients;
drop policy if exists "clients: members select" on public.clients;
create policy "clients: members select"
  on public.clients for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "clients: members insert" on public.clients;
create policy "clients: members insert"
  on public.clients for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "clients: members update" on public.clients;
create policy "clients: members update"
  on public.clients for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- sessions: select/insert/update; NO delete (soft delete via deleted_at).
-- ---------------------------------------------------------------------------
drop policy if exists "sessions: members all" on public.sessions;
drop policy if exists "sessions: members select" on public.sessions;
create policy "sessions: members select"
  on public.sessions for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "sessions: members insert" on public.sessions;
create policy "sessions: members insert"
  on public.sessions for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "sessions: members update" on public.sessions;
create policy "sessions: members update"
  on public.sessions for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- session_blocks: select/insert/update; NO delete (soft delete via
-- deleted_at; the one app cleanup path now soft-deletes too).
-- ---------------------------------------------------------------------------
drop policy if exists "session_blocks_member_all" on public.session_blocks;
drop policy if exists "session_blocks_member_select" on public.session_blocks;
create policy "session_blocks_member_select"
  on public.session_blocks for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "session_blocks_member_insert" on public.session_blocks;
create policy "session_blocks_member_insert"
  on public.session_blocks for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "session_blocks_member_update" on public.session_blocks;
create policy "session_blocks_member_update"
  on public.session_blocks for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- photos: select/insert/update; NO delete (no app delete path).
-- ---------------------------------------------------------------------------
drop policy if exists "photos: members all" on public.photos;
drop policy if exists "photos: members select" on public.photos;
create policy "photos: members select"
  on public.photos for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "photos: members insert" on public.photos;
create policy "photos: members insert"
  on public.photos for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "photos: members update" on public.photos;
create policy "photos: members update"
  on public.photos for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- probe_lots: select/insert/update; NO delete (dormant legacy table).
-- ---------------------------------------------------------------------------
drop policy if exists "probe_lots: members all" on public.probe_lots;
drop policy if exists "probe_lots: members select" on public.probe_lots;
create policy "probe_lots: members select"
  on public.probe_lots for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "probe_lots: members insert" on public.probe_lots;
create policy "probe_lots: members insert"
  on public.probe_lots for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "probe_lots: members update" on public.probe_lots;
create policy "probe_lots: members update"
  on public.probe_lots for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- client_intake_forms: select/insert/update; NO delete (soft delete
-- via deleted_at). The public intake fill flow runs through the
-- service role and is unaffected.
-- ---------------------------------------------------------------------------
drop policy if exists "client_intake_forms_member_all" on public.client_intake_forms;
drop policy if exists "client_intake_forms_member_select" on public.client_intake_forms;
create policy "client_intake_forms_member_select"
  on public.client_intake_forms for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "client_intake_forms_member_insert" on public.client_intake_forms;
create policy "client_intake_forms_member_insert"
  on public.client_intake_forms for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "client_intake_forms_member_update" on public.client_intake_forms;
create policy "client_intake_forms_member_update"
  on public.client_intake_forms for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- client_tags: select/insert/update; NO delete (soft delete via
-- deleted_at/deleted_by in removeClientTagAction).
-- ---------------------------------------------------------------------------
drop policy if exists "client_tags_member_all" on public.client_tags;
drop policy if exists "client_tags_member_select" on public.client_tags;
create policy "client_tags_member_select"
  on public.client_tags for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "client_tags_member_insert" on public.client_tags;
create policy "client_tags_member_insert"
  on public.client_tags for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "client_tags_member_update" on public.client_tags;
create policy "client_tags_member_update"
  on public.client_tags for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- treatment_goals: select/insert/update; NO delete (upsert-only).
-- ---------------------------------------------------------------------------
drop policy if exists "treatment_goals_studio_member_all" on public.treatment_goals;
drop policy if exists "treatment_goals_studio_member_select" on public.treatment_goals;
create policy "treatment_goals_studio_member_select"
  on public.treatment_goals for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "treatment_goals_studio_member_insert" on public.treatment_goals;
create policy "treatment_goals_studio_member_insert"
  on public.treatment_goals for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "treatment_goals_studio_member_update" on public.treatment_goals;
create policy "treatment_goals_studio_member_update"
  on public.treatment_goals for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- client_personal_notes: select/insert/update; NO delete (upsert-only;
-- the studio-derive trigger from 0035 is unchanged).
-- ---------------------------------------------------------------------------
drop policy if exists "client_personal_notes_studio_member_all" on public.client_personal_notes;
drop policy if exists "client_personal_notes_studio_member_select" on public.client_personal_notes;
create policy "client_personal_notes_studio_member_select"
  on public.client_personal_notes for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "client_personal_notes_studio_member_insert" on public.client_personal_notes;
create policy "client_personal_notes_studio_member_insert"
  on public.client_personal_notes for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "client_personal_notes_studio_member_update" on public.client_personal_notes;
create policy "client_personal_notes_studio_member_update"
  on public.client_personal_notes for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- electrolysis_entries: per-command, DELETE KEPT explicitly (the app's
-- deleteElectrolysisEntryAction has a UI affordance for removing a
-- mistaken reading; entries use the session_is_visible expression the
-- old FOR ALL policy used).
-- ---------------------------------------------------------------------------
drop policy if exists "electrolysis_entries: members all" on public.electrolysis_entries;
drop policy if exists "electrolysis_entries: members select" on public.electrolysis_entries;
create policy "electrolysis_entries: members select"
  on public.electrolysis_entries for select to authenticated
  using (public.session_is_visible(session_id));
drop policy if exists "electrolysis_entries: members insert" on public.electrolysis_entries;
create policy "electrolysis_entries: members insert"
  on public.electrolysis_entries for insert to authenticated
  with check (public.session_is_visible(session_id));
drop policy if exists "electrolysis_entries: members update" on public.electrolysis_entries;
create policy "electrolysis_entries: members update"
  on public.electrolysis_entries for update to authenticated
  using (public.session_is_visible(session_id))
  with check (public.session_is_visible(session_id));
drop policy if exists "electrolysis_entries: members delete" on public.electrolysis_entries;
create policy "electrolysis_entries: members delete"
  on public.electrolysis_entries for delete to authenticated
  using (public.session_is_visible(session_id));

-- ---------------------------------------------------------------------------
-- laser_entries: per-command, DELETE KEPT explicitly
-- (deleteLaserEntryAction has a UI affordance).
-- ---------------------------------------------------------------------------
drop policy if exists "laser_entries: members all" on public.laser_entries;
drop policy if exists "laser_entries: members select" on public.laser_entries;
create policy "laser_entries: members select"
  on public.laser_entries for select to authenticated
  using (public.session_is_visible(session_id));
drop policy if exists "laser_entries: members insert" on public.laser_entries;
create policy "laser_entries: members insert"
  on public.laser_entries for insert to authenticated
  with check (public.session_is_visible(session_id));
drop policy if exists "laser_entries: members update" on public.laser_entries;
create policy "laser_entries: members update"
  on public.laser_entries for update to authenticated
  using (public.session_is_visible(session_id))
  with check (public.session_is_visible(session_id));
drop policy if exists "laser_entries: members delete" on public.laser_entries;
create policy "laser_entries: members delete"
  on public.laser_entries for delete to authenticated
  using (public.session_is_visible(session_id));

-- ---------------------------------------------------------------------------
-- treatment_plan_stages: per-command, DELETE KEPT explicitly
-- (deleteTreatmentPlanStageAction has a UI affordance; stages are plan
-- structure, not treatment history).
-- ---------------------------------------------------------------------------
drop policy if exists "treatment_plan_stages_studio_member_all" on public.treatment_plan_stages;
drop policy if exists "treatment_plan_stages_studio_member_select" on public.treatment_plan_stages;
create policy "treatment_plan_stages_studio_member_select"
  on public.treatment_plan_stages for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "treatment_plan_stages_studio_member_insert" on public.treatment_plan_stages;
create policy "treatment_plan_stages_studio_member_insert"
  on public.treatment_plan_stages for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "treatment_plan_stages_studio_member_update" on public.treatment_plan_stages;
create policy "treatment_plan_stages_studio_member_update"
  on public.treatment_plan_stages for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
drop policy if exists "treatment_plan_stages_studio_member_delete" on public.treatment_plan_stages;
create policy "treatment_plan_stages_studio_member_delete"
  on public.treatment_plan_stages for delete to authenticated
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- client_pricing: per-command, DELETE KEPT explicitly
-- (deleteClientPricingAction has a UI affordance; pricing rows are
-- billing configuration, not clinical history).
-- ---------------------------------------------------------------------------
drop policy if exists "client_pricing: members all" on public.client_pricing;
drop policy if exists "client_pricing: members select" on public.client_pricing;
create policy "client_pricing: members select"
  on public.client_pricing for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "client_pricing: members insert" on public.client_pricing;
create policy "client_pricing: members insert"
  on public.client_pricing for insert to authenticated
  with check (public.is_studio_member(studio_id));
drop policy if exists "client_pricing: members update" on public.client_pricing;
create policy "client_pricing: members update"
  on public.client_pricing for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
drop policy if exists "client_pricing: members delete" on public.client_pricing;
create policy "client_pricing: members delete"
  on public.client_pricing for delete to authenticated
  using (public.is_studio_member(studio_id));
