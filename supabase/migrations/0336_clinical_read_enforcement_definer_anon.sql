-- 0336 (I4): clinical-read enforcement, definer gate, anon table grants, session_is_visible. Roles clinical-read gating, Sam decision of 12 Nov 2026
-- ("database enforcement of record permissions"). Builds on 0333 to 0335 (clin_key_studios). OPS scope go (12 Nov): items (a) to (c) only.
--
-- WHAT THIS CHANGES
--   (a) public.whole_session_copy_source_descriptor(studio, target) is SECURITY DEFINER, so the SELECT policies of 0333 never applied to it. It returns
--       a source session's id, start time and fingerprint. It now requires clin.view_records in addition to membership (HN001, the same refusal).
--   (b) Table privileges. RLS already returns ZERO rows to anon on every table below; this removes the privilege as well (defence in depth), so a
--       future policy mistake cannot expose a clinical table to the logged-out role. PostgREST on a logged-out request now answers 42501 instead of an
--       empty list for these tables; every page that reads them sits behind login. authenticated and service_role are NOT touched.
--   (c) public.session_is_visible(uuid) was revoked from public in 0001 but Supabase's default privileges also granted anon and service_role. It is
--       revoked from public, anon and service_role BY NAME; authenticated keeps it (the entry INSERT/UPDATE/DELETE policies still call it).
--
-- WHAT IT DOES NOT CHANGE (by design)
--   * Who can read TODAY: a pending or unreleased clin.view_records resolves to its snapshot (practitioner = studio), the owner always passes.
--   * record_clinical_records_audit stays ungated: it RECORDS that records were previewed or printed; gating it on the read key would drop the audit
--     row for the access it records (Team confirmed).
--   * 0274 last_visit and the G8 write grants (photos, treatment_images): NOT in this migration; they wait for Sam's decision.
--   * Service-role and definer paths.

begin;
set local lock_timeout = '5s';

-- ---- (a) -------------------------------------------------------------------------------------------------------------------------------
create or replace function public.whole_session_copy_source_descriptor(
  p_studio_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_modality text;
  v_status   text;
  v_deleted  timestamptz;
  v_blocks   integer;
  v_entries  integer;
  v_source   uuid;
  v_started  timestamptz;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized' using errcode = 'HN001';
  end if;
  -- 0336 (I4): the descriptor reveals a source session's id, start time and fingerprint, which is treatment history. It now needs clin.view_records
  -- as well as membership (the page that calls it already stands behind that key). The same HN001 as the membership refusal, so a restricted caller
  -- learns nothing from the difference.
  if p_studio_id not in (select k from public.clin_key_studios('clin.view_records') k) then
    raise exception 'not authorized' using errcode = 'HN001';
  end if;

  select s.modality, s.record_status, s.deleted_at
    into v_modality, v_status, v_deleted
    from public.sessions s
   where s.id = p_target_session_id and s.studio_id = p_studio_id;
  if not found or v_deleted is not null then
    return jsonb_build_object('eligible', false, 'reason', 'target');
  end if;
  if v_modality is distinct from 'electrolysis' or v_status is distinct from 'draft' then
    return jsonb_build_object('eligible', false, 'reason', 'target');
  end if;

  select count(*) into v_blocks
    from public.session_blocks
   where session_id = p_target_session_id and deleted_at is null;
  select count(*) into v_entries
    from public.electrolysis_entries
   where session_id = p_target_session_id and deleted_at is null;
  if v_blocks > 0 or v_entries > 0 then
    return jsonb_build_object('eligible', false, 'reason', 'not_empty');
  end if;

  v_source := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source is null then
    return jsonb_build_object('eligible', false, 'reason', 'no_source');
  end if;
  select started_at into v_started from public.sessions where id = v_source;

  return jsonb_build_object(
    'eligible', true,
    'source_session_id', v_source,
    'source_started_at', v_started,
    'source_fingerprint', public._whole_session_copy_fingerprint(v_source)
  );
end;
$$;

revoke all on function public.whole_session_copy_source_descriptor(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.whole_session_copy_source_descriptor(uuid, uuid) to authenticated, service_role;

-- ---- (b) -------------------------------------------------------------------------------------------------------------------------------
revoke all on table public.sessions from public, anon;
revoke all on table public.session_blocks from public, anon;
revoke all on table public.session_block_areas from public, anon;
revoke all on table public.session_copy_operations from public, anon;
revoke all on table public.treatment_area_create_claims from public, anon;
revoke all on table public.treatment_setup_captures from public, anon;
revoke all on table public.treatment_setup_readings from public, anon;
revoke all on table public.treatment_setup_submissions from public, anon;
revoke all on table public.imported_treatment_memories from public, anon;
revoke all on table public.imported_treatment_memory_audit_events from public, anon;
revoke all on table public.treatment_reading_change_events from public, anon;
revoke all on table public.treatment_images from public, anon;
revoke all on table public.photos from public, anon;
revoke all on table public.electrolysis_entries from public, anon;
revoke all on table public.laser_entries from public, anon;
revoke all on table public.session_audit from public, anon;
revoke all on table public.client_intake_forms from public, anon;
revoke all on table public.client_consent_signatures from public, anon;
revoke all on table public.appointment_policy_acknowledgements from public, anon;
revoke all on table public.treatment_plans from public, anon;
revoke all on table public.treatment_plan_stages from public, anon;
revoke all on table public.treatment_goals from public, anon;
revoke all on table public.client_clinical_notes from public, anon;
revoke all on table public.client_pinned_notes from public, anon;
revoke all on table public.client_personal_notes from public, anon;
revoke all on table public.client_budget_context from public, anon;
revoke all on table public.clinical_audit_events from public, anon;
revoke all on table public.clinical_record_snapshots from public, anon;
revoke all on table public.clinical_record_amendments from public, anon;

-- ---- (c) -------------------------------------------------------------------------------------------------------------------------------
revoke all on function public.session_is_visible(uuid) from public, anon, authenticated, service_role;
grant execute on function public.session_is_visible(uuid) to authenticated;

commit;
