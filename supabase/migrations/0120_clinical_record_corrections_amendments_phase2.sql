-- 0120_clinical_record_corrections_amendments_phase2.sql
--
-- Clinical-record architecture — PHASE 2: Corrections & Amendments.
--
-- Adds two safe, attributable ways to evolve a FINALIZED clinical record without
-- ever changing or deleting the original:
--
--   * AMENDMENT  — appends information that was MISSING (a late note, a client
--     clarification, a photo taken after finalization). Append-only; references a
--     specific finalized version; requires a reason; NEVER overwrites a recorded
--     value; does NOT change normalized rows, snapshots, or record_version.
--
--   * CORRECTION — changes a clinical value that was recorded INCORRECTLY. Creates
--     a NEW immutable finalized snapshot version (N+1) by updating the canonical
--     normalized rows through a NARROW trusted path, rebuilding + re-hashing the
--     snapshot, incrementing session.record_version exactly once, superseding the
--     prior version, and preserving every prior version permanently.
--
-- THE TRUSTED-CORRECTION BYPASS (the crux). Phase 1's guard_finalized_clinical_write
-- freezes finalized rows for EVERY role with NO bypass. A correction must write
-- those frozen canonical rows. We introduce ONE narrow, session-scoped, transaction-
-- local permit:
--   * The guard permits a write to a finalized row ONLY when
--       current_setting('hone.correction_session_id', true) = <the row's session id>.
--   * That GUC is set (transaction-local, is_local=true) ONLY inside the SECURITY
--     DEFINER correction/amendment-photo RPCs, scoped to the exact session they hold
--     a FOR UPDATE lock on, and reset before return (and auto-discarded at COMMIT/
--     ROLLBACK).
--   * It is STRUCTURALLY UNREACHABLE from PostgREST clients: a REST client cannot run
--     a `SET`/`set_config` alongside a finalized-row write in the SAME transaction
--     (each REST request is its own transaction; clients cannot compose arbitrary
--     multi-statement transactions). Only the DEFINER RPC body can do both — and it
--     validates auth, native origin, finalized status, and the version compare-and-set
--     BEFORE setting the GUC. Row-scoping means a correction of session A grants zero
--     permission over session B, even in the same transaction. A dedicated corrector
--     ROLE was rejected: Supabase migrations cannot CREATE ROLE (zero precedent) and a
--     role check is process-scoped, not row-scoped.
--
-- Snapshots stay append-only; prior versions are RESTRICT-preserved (undeletable), so
-- lineage is preserved by construction. Legacy rows remain ineligible. Treatment-
-- memory reads are UNCHANGED in this PR. No Stripe/payment/email/SMS/booking change.
--
-- Migration max 0119 -> 0120. Additive + inert (gated by a NEW studio flag, default OFF).

-- ===========================================================================
-- 1. Snapshot lineage fields (additive; existing v1 rows become 'original').
-- ===========================================================================
alter table public.clinical_record_snapshots
  add column if not exists version_type text not null default 'original',
  add column if not exists supersedes_snapshot_id uuid,
  add column if not exists correction_reason text,
  add column if not exists corrected_by uuid,
  add column if not exists corrected_by_display_name text,
  add column if not exists corrected_at timestamptz;

alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_version_type_check;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_version_type_check
  check (version_type in ('original', 'correction'));

-- Lineage consistency: originals have no supersede/correction attribution;
-- corrections must carry a supersede pointer + reason + corrector.
alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_lineage_check;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_lineage_check
  check (
    (version_type = 'original'
       and supersedes_snapshot_id is null and correction_reason is null
       and corrected_by is null and corrected_by_display_name is null and corrected_at is null)
    or
    (version_type = 'correction'
       and supersedes_snapshot_id is not null and correction_reason is not null
       and corrected_by is not null and corrected_by_display_name is not null and corrected_at is not null)
  );

-- Supersede pointer: RESTRICT (a superseded version can never be deleted).
alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_supersedes_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_supersedes_fk
  foreign key (supersedes_snapshot_id) references public.clinical_record_snapshots(id) on delete restrict;

alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_corrected_by_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_corrected_by_fk
  foreign key (corrected_by) references public.practitioners(id) on delete restrict;

-- ===========================================================================
-- 2. clinical_record_amendments (append-only addenda; never alter the original).
-- ===========================================================================
create table if not exists public.clinical_record_amendments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  session_id uuid not null,
  applies_to_snapshot_id uuid not null,
  amendment_type text not null,
  reason text not null,
  body text,
  structured_addition jsonb,
  linked_entity_type text,
  linked_entity_id uuid,
  authored_by uuid not null,
  authored_by_display_name text,
  authored_at timestamptz not null default now(),
  content_hash text not null,
  hash_algorithm text not null default 'sha256',
  canonicalization_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint clinical_record_amendments_type_check
    check (amendment_type in ('late_note', 'clarification', 'missing_detail', 'photo', 'other')),
  constraint clinical_record_amendments_reason_nonempty
    check (length(btrim(reason)) > 0),
  constraint clinical_record_amendments_has_content
    check (body is not null or structured_addition is not null or linked_entity_id is not null)
);

-- Same-studio composite FK (0094 pattern) + studio + snapshot + author, all RESTRICT.
alter table public.clinical_record_amendments
  drop constraint if exists clinical_record_amendments_studio_fk;
alter table public.clinical_record_amendments
  add constraint clinical_record_amendments_studio_fk
  foreign key (studio_id) references public.studios(id) on delete restrict;
alter table public.clinical_record_amendments
  drop constraint if exists clinical_record_amendments_session_same_studio_fk;
alter table public.clinical_record_amendments
  add constraint clinical_record_amendments_session_same_studio_fk
  foreign key (studio_id, session_id) references public.sessions (studio_id, id) on delete restrict;
alter table public.clinical_record_amendments
  drop constraint if exists clinical_record_amendments_snapshot_fk;
alter table public.clinical_record_amendments
  add constraint clinical_record_amendments_snapshot_fk
  foreign key (applies_to_snapshot_id) references public.clinical_record_snapshots(id) on delete restrict;
alter table public.clinical_record_amendments
  drop constraint if exists clinical_record_amendments_author_fk;
alter table public.clinical_record_amendments
  add constraint clinical_record_amendments_author_fk
  foreign key (authored_by) references public.practitioners(id) on delete restrict;

create index if not exists clinical_record_amendments_session_idx
  on public.clinical_record_amendments (studio_id, session_id, authored_at);

alter table public.clinical_record_amendments enable row level security;

drop policy if exists "clinical_record_amendments_member_select" on public.clinical_record_amendments;
create policy "clinical_record_amendments_member_select"
  on public.clinical_record_amendments for select to authenticated
  using (public.is_studio_member(studio_id));

revoke insert, update, delete, truncate on public.clinical_record_amendments from anon, authenticated;
revoke all on public.clinical_record_amendments from public;

-- ===========================================================================
-- 3. clinical_audit_events (dedicated clinical audit; append-only; PHI-safe).
--    IDs + version numbers + reason only — NEVER clinical VALUES.
-- ===========================================================================
create table if not exists public.clinical_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  session_id uuid not null,
  operation_type text not null,
  actor_practitioner_id uuid not null,
  actor_display_name text,
  record_version_before integer,
  record_version_after integer,
  snapshot_id uuid,
  previous_snapshot_id uuid,
  amendment_id uuid,
  affected_entity_type text,
  affected_entity_ids jsonb,
  reason text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint clinical_audit_events_operation_check
    check (operation_type in ('correction', 'amendment'))
);

alter table public.clinical_audit_events
  drop constraint if exists clinical_audit_events_studio_fk;
alter table public.clinical_audit_events
  add constraint clinical_audit_events_studio_fk
  foreign key (studio_id) references public.studios(id) on delete restrict;
alter table public.clinical_audit_events
  drop constraint if exists clinical_audit_events_session_same_studio_fk;
alter table public.clinical_audit_events
  add constraint clinical_audit_events_session_same_studio_fk
  foreign key (studio_id, session_id) references public.sessions (studio_id, id) on delete restrict;
alter table public.clinical_audit_events
  drop constraint if exists clinical_audit_events_actor_fk;
alter table public.clinical_audit_events
  add constraint clinical_audit_events_actor_fk
  foreign key (actor_practitioner_id) references public.practitioners(id) on delete restrict;

create index if not exists clinical_audit_events_session_idx
  on public.clinical_audit_events (studio_id, session_id, occurred_at);

alter table public.clinical_audit_events enable row level security;

drop policy if exists "clinical_audit_events_member_select" on public.clinical_audit_events;
create policy "clinical_audit_events_member_select"
  on public.clinical_audit_events for select to authenticated
  using (public.is_studio_member(studio_id));

revoke insert, update, delete, truncate on public.clinical_audit_events from anon, authenticated;
revoke all on public.clinical_audit_events from public;

-- ===========================================================================
-- 4. Append-only triggers for the two new immutable history tables.
-- ===========================================================================
-- guard_snapshot_append_only already exists (0119); reuse it for the new tables.
drop trigger if exists clinical_record_amendments_append_only on public.clinical_record_amendments;
create trigger clinical_record_amendments_append_only
  before update or delete on public.clinical_record_amendments
  for each row execute function public.guard_snapshot_append_only();

drop trigger if exists clinical_audit_events_append_only on public.clinical_audit_events;
create trigger clinical_audit_events_append_only
  before update or delete on public.clinical_audit_events
  for each row execute function public.guard_snapshot_append_only();

-- ===========================================================================
-- 5. Phase 2 studio flag (separate from Phase 1; default OFF).
-- ===========================================================================
alter table public.studios
  add column if not exists clinical_corrections_enabled boolean not null default false;

-- ===========================================================================
-- 6. Extend the finalized-write guard with the NARROW correction permit.
--    A frozen-row write is permitted ONLY when the transaction-local GUC
--    hone.correction_session_id equals the row's own session id (set exclusively
--    inside the SECURITY DEFINER correction/amendment-photo RPCs). Compared as TEXT
--    (no ::uuid cast — a bogus client-set value can never crash an ordinary write).
--    DELETE and child/entry INSERT are NEVER permitted (corrections update existing
--    values; amendments append to clinical_record_amendments / a NEW image only).
-- ===========================================================================
create or replace function public.guard_finalized_clinical_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_new_status text;
  v_correcting text := coalesce(current_setting('hone.correction_session_id', true), '');
  v_msg constant text :=
    'This clinical record is finalized and read-only. Use an amendment or a correction version (both preserve the original).';
begin
  -- --- sessions ---------------------------------------------------------------
  if tg_table_name = 'sessions' then
    if tg_op = 'DELETE' then
      -- Never deletable (corrections do not delete the session).
      if old.record_status in ('finalized', 'void')
         or exists (select 1 from public.clinical_record_snapshots cs where cs.session_id = old.id) then
        raise exception 'This clinical record is finalized and cannot be deleted (retraction/void is a later phase).'
          using errcode = 'check_violation';
      end if;
      return old;
    end if;
    if old.record_status in ('finalized', 'void') then
      -- Trusted correction of THIS session: permit (the typed RPC payload constrains
      -- what actually changes; the guard's job is to block everyone else).
      if v_correcting <> '' and v_correcting = old.id::text then
        return new;
      end if;
      if new.studio_id is distinct from old.studio_id
         or new.client_id is distinct from old.client_id
         or new.practitioner_id is distinct from old.practitioner_id
         or new.performed_by_practitioner_id is distinct from old.performed_by_practitioner_id
         or new.modality is distinct from old.modality
         or new.started_at is distinct from old.started_at
         or new.ended_at is distinct from old.ended_at
         or new.started_at_original is distinct from old.started_at_original
         or new.session_notes is distinct from old.session_notes
         or new.next_session_note is distinct from old.next_session_note
         or new.aftercare_and_risks_explained_at is distinct from old.aftercare_and_risks_explained_at
         or new.aftercare_and_risks_explained_by is distinct from old.aftercare_and_risks_explained_by
         or new.created_at is distinct from old.created_at
         or new.deleted_at is distinct from old.deleted_at
         or new.deleted_by is distinct from old.deleted_by
         or new.delete_reason is distinct from old.delete_reason
         or new.record_status is distinct from old.record_status
         or new.finalized_at is distinct from old.finalized_at
         or new.finalized_by is distinct from old.finalized_by
         or new.record_version is distinct from old.record_version
         or new.current_snapshot_id is distinct from old.current_snapshot_id
         or new.record_origin is distinct from old.record_origin
         or new.legacy_classification is distinct from old.legacy_classification then
        raise exception '%', v_msg using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- --- treatment_images (nullable session_id) ---------------------------------
  if tg_table_name = 'treatment_images' then
    if tg_op = 'DELETE' then
      if old.session_id is not null then
        select s.record_status into v_status from public.sessions s where s.id = old.session_id;
        if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
      end if;
      return old;
    elsif tg_op = 'INSERT' then
      if new.session_id is not null then
        select s.record_status into v_status from public.sessions s where s.id = new.session_id;
        if v_status in ('finalized', 'void') then
          -- Late-photo amendment: permit the trusted INSERT onto THIS finalized session.
          if v_correcting <> '' and v_correcting = new.session_id::text then return new; end if;
          raise exception '%', v_msg using errcode = 'check_violation';
        end if;
      end if;
      return new;
    else
      if old.session_id is not null then
        select s.record_status into v_status from public.sessions s where s.id = old.session_id;
        if v_status in ('finalized', 'void') then
          if v_correcting <> '' and v_correcting = old.session_id::text then return new; end if;
          raise exception '%', v_msg using errcode = 'check_violation';
        end if;
      end if;
      if new.session_id is not null and new.session_id is distinct from old.session_id then
        select s.record_status into v_new_status from public.sessions s where s.id = new.session_id;
        if v_new_status in ('finalized', 'void') then
          if v_correcting <> '' and v_correcting = new.session_id::text then return new; end if;
          raise exception '%', v_msg using errcode = 'check_violation';
        end if;
      end if;
      return new;
    end if;
  end if;

  -- --- child clinical tables (session_blocks / electrolysis_entries / laser_entries) ---
  if tg_op = 'DELETE' then
    -- Never deletable (corrections update values; they do not remove children).
    select s.record_status into v_status from public.sessions s where s.id = old.session_id;
    if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    return old;
  elsif tg_op = 'INSERT' then
    -- Never insertable (missing info is captured as an amendment, not a frozen-child insert).
    select s.record_status into v_status from public.sessions s where s.id = new.session_id;
    if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    return new;
  else
    select s.record_status into v_status from public.sessions s where s.id = old.session_id;
    if v_status in ('finalized', 'void') then
      -- Trusted correction: permit UPDATE of an existing child value on THIS session.
      if v_correcting <> '' and v_correcting = old.session_id::text then return new; end if;
      raise exception '%', v_msg using errcode = 'check_violation';
    end if;
    if new.session_id is distinct from old.session_id then
      select s.record_status into v_new_status from public.sessions s where s.id = new.session_id;
      if v_new_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    end if;
    return new;
  end if;
end;
$$;

-- ===========================================================================
-- 7. Correction-payload appliers (fixed column ALLOWLISTS; NO dynamic SQL, NO
--    client-supplied table/column names). SECURITY INVOKER helpers, callable only
--    from within the trusted correction RPC (execute revoked from clients). Each
--    rejects any unknown key. A key PRESENT with a JSON null sets the column NULL;
--    an ABSENT key leaves the column unchanged.
-- ===========================================================================
create or replace function public._apply_session_correction(p_session_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in (
      'modality','started_at','ended_at','session_notes','next_session_note',
      'performed_by_practitioner_id','aftercare_and_risks_explained_at','aftercare_and_risks_explained_by')) then
    raise exception 'Disallowed session correction field' using errcode = 'check_violation';
  end if;
  update public.sessions set
    modality = case when p ? 'modality' then (p->>'modality') else modality end,
    started_at = case when p ? 'started_at' then (p->>'started_at')::timestamptz else started_at end,
    ended_at = case when p ? 'ended_at' then (p->>'ended_at')::timestamptz else ended_at end,
    session_notes = case when p ? 'session_notes' then (p->>'session_notes') else session_notes end,
    next_session_note = case when p ? 'next_session_note' then (p->>'next_session_note') else next_session_note end,
    performed_by_practitioner_id = case when p ? 'performed_by_practitioner_id' then (p->>'performed_by_practitioner_id')::uuid else performed_by_practitioner_id end,
    aftercare_and_risks_explained_at = case when p ? 'aftercare_and_risks_explained_at' then (p->>'aftercare_and_risks_explained_at')::timestamptz else aftercare_and_risks_explained_at end,
    aftercare_and_risks_explained_by = case when p ? 'aftercare_and_risks_explained_by' then (p->>'aftercare_and_risks_explained_by')::uuid else aftercare_and_risks_explained_by end
  where id = p_session_id;
end;
$$;

create or replace function public._apply_block_correction(p_session_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in (
      'id','primary_area','side','custom_area_detail','mode','apilus_modality','energy_level',
      'minutes_performed','probe_label','probe_lot_number','machine_frequency','tolerance_rating',
      'reaction_type','reaction_notes','caution_for_next_session','caution_note','block_name')) then
    raise exception 'Disallowed block correction field' using errcode = 'check_violation';
  end if;
  v_id := (p->>'id')::uuid;
  if not exists (select 1 from public.session_blocks b where b.id = v_id and b.session_id = p_session_id and b.deleted_at is null) then
    raise exception 'Block does not belong to this session' using errcode = 'check_violation';
  end if;
  update public.session_blocks set
    primary_area = case when p ? 'primary_area' then (p->>'primary_area') else primary_area end,
    side = case when p ? 'side' then (p->>'side') else side end,
    custom_area_detail = case when p ? 'custom_area_detail' then (p->>'custom_area_detail') else custom_area_detail end,
    mode = case when p ? 'mode' then (p->>'mode') else mode end,
    apilus_modality = case when p ? 'apilus_modality' then (p->>'apilus_modality') else apilus_modality end,
    energy_level = case when p ? 'energy_level' then (p->>'energy_level')::numeric else energy_level end,
    minutes_performed = case when p ? 'minutes_performed' then (p->>'minutes_performed')::int else minutes_performed end,
    probe_label = case when p ? 'probe_label' then (p->>'probe_label') else probe_label end,
    probe_lot_number = case when p ? 'probe_lot_number' then (p->>'probe_lot_number') else probe_lot_number end,
    machine_frequency = case when p ? 'machine_frequency' then (p->>'machine_frequency') else machine_frequency end,
    tolerance_rating = case when p ? 'tolerance_rating' then (p->>'tolerance_rating')::smallint else tolerance_rating end,
    reaction_type = case when p ? 'reaction_type' then (p->>'reaction_type') else reaction_type end,
    reaction_notes = case when p ? 'reaction_notes' then (p->>'reaction_notes') else reaction_notes end,
    caution_for_next_session = case when p ? 'caution_for_next_session' then (p->>'caution_for_next_session')::boolean else caution_for_next_session end,
    caution_note = case when p ? 'caution_note' then (p->>'caution_note') else caution_note end,
    block_name = case when p ? 'block_name' then (p->>'block_name') else block_name end
  where id = v_id;
end;
$$;

create or replace function public._apply_electrolysis_correction(p_session_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in (
      'id','area','mode','observation_chips','comments','hairs_treated','minutes_performed')) then
    raise exception 'Disallowed electrolysis correction field' using errcode = 'check_violation';
  end if;
  v_id := (p->>'id')::uuid;
  if not exists (select 1 from public.electrolysis_entries e where e.id = v_id and e.session_id = p_session_id and e.deleted_at is null) then
    raise exception 'Entry does not belong to this session' using errcode = 'check_violation';
  end if;
  update public.electrolysis_entries set
    area = case when p ? 'area' then (p->>'area') else area end,
    mode = case when p ? 'mode' then (p->>'mode') else mode end,
    observation_chips = case when p ? 'observation_chips' then (p->'observation_chips') else observation_chips end,
    comments = case when p ? 'comments' then (p->>'comments') else comments end,
    hairs_treated = case when p ? 'hairs_treated' then (p->>'hairs_treated')::int else hairs_treated end,
    minutes_performed = case when p ? 'minutes_performed' then (p->>'minutes_performed')::int else minutes_performed end
  where id = v_id;
end;
$$;

create or replace function public._apply_laser_correction(p_session_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in (
      'id','zone','session_number','equipment_params','observation_notes','ejection_results')) then
    raise exception 'Disallowed laser correction field' using errcode = 'check_violation';
  end if;
  v_id := (p->>'id')::uuid;
  if not exists (select 1 from public.laser_entries l where l.id = v_id and l.session_id = p_session_id and l.deleted_at is null) then
    raise exception 'Entry does not belong to this session' using errcode = 'check_violation';
  end if;
  update public.laser_entries set
    zone = case when p ? 'zone' then (p->>'zone') else zone end,
    session_number = case when p ? 'session_number' then (p->>'session_number')::int else session_number end,
    equipment_params = case when p ? 'equipment_params' then (p->'equipment_params') else equipment_params end,
    observation_notes = case when p ? 'observation_notes' then (p->>'observation_notes') else observation_notes end,
    ejection_results = case when p ? 'ejection_results' then (p->>'ejection_results') else ejection_results end
  where id = v_id;
end;
$$;

create or replace function public._apply_image_correction(p_session_id uuid, p jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_id uuid;
begin
  if exists (select 1 from jsonb_object_keys(p) k where k not in ('id','practitioner_note','session_block_id')) then
    raise exception 'Disallowed image correction field' using errcode = 'check_violation';
  end if;
  v_id := (p->>'id')::uuid;
  if not exists (select 1 from public.treatment_images ti where ti.id = v_id and ti.session_id = p_session_id and ti.deleted_at is null) then
    raise exception 'Image does not belong to this session' using errcode = 'check_violation';
  end if;
  -- session_block_id, if provided, must belong to this session.
  if p ? 'session_block_id' and (p->>'session_block_id') is not null
     and not exists (select 1 from public.session_blocks b where b.id = (p->>'session_block_id')::uuid and b.session_id = p_session_id) then
    raise exception 'Target block does not belong to this session' using errcode = 'check_violation';
  end if;
  update public.treatment_images set
    practitioner_note = case when p ? 'practitioner_note' then (p->>'practitioner_note') else practitioner_note end,
    session_block_id = case when p ? 'session_block_id' then (p->>'session_block_id')::uuid else session_block_id end
  where id = v_id;
end;
$$;

revoke execute on function public._apply_session_correction(uuid, jsonb) from anon, authenticated, public;
revoke execute on function public._apply_block_correction(uuid, jsonb) from anon, authenticated, public;
revoke execute on function public._apply_electrolysis_correction(uuid, jsonb) from anon, authenticated, public;
revoke execute on function public._apply_laser_correction(uuid, jsonb) from anon, authenticated, public;
revoke execute on function public._apply_image_correction(uuid, jsonb) from anon, authenticated, public;

-- ===========================================================================
-- 8. Trusted AMENDMENT RPC (append-only; no normalized/version/snapshot change).
-- ===========================================================================
create or replace function public.amend_finalized_session(
  p_session_id uuid,
  p_applies_to_snapshot_id uuid,
  p_amendment_type text,
  p_reason text,
  p_body text,
  p_structured_addition jsonb
)
returns table (amendment_id uuid, content_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid; v_status text; v_origin text; v_flag boolean;
  v_actor uuid; v_actor_name text; v_hash text; v_amend_id uuid; v_doc jsonb;
begin
  select s.studio_id, s.record_status, s.record_origin
    into v_studio, v_status, v_origin
  from public.sessions s
  where s.id = p_session_id and s.deleted_at is null and public.is_studio_member(s.studio_id)
  for update;
  if not found then raise exception 'Session not found or not accessible' using errcode = 'check_violation'; end if;

  select st.clinical_corrections_enabled into v_flag from public.studios st where st.id = v_studio;
  if not coalesce(v_flag, false) then raise exception 'Clinical corrections are not enabled for this studio' using errcode = 'check_violation'; end if;

  select p.id, p.display_name into v_actor, v_actor_name
  from public.practitioners p where p.user_id = auth.uid() and p.active = true and p.studio_id = v_studio limit 1;
  if v_actor is null then raise exception 'Caller is not an active practitioner in this studio' using errcode = 'check_violation'; end if;

  if v_origin <> 'native' then raise exception 'Only native records can be amended' using errcode = 'check_violation'; end if;
  if v_status <> 'finalized' then raise exception 'Session is not finalized (status=%)', v_status using errcode = 'check_violation'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'A reason is required' using errcode = 'check_violation'; end if;
  if p_amendment_type is null or p_amendment_type not in ('late_note','clarification','missing_detail','other') then
    raise exception 'Invalid amendment type' using errcode = 'check_violation';
  end if;
  if (p_body is null or length(btrim(p_body)) = 0) and p_structured_addition is null then
    raise exception 'An amendment must add content (body or structured addition)' using errcode = 'check_violation';
  end if;
  -- Target snapshot must belong to this session's lineage.
  if not exists (select 1 from public.clinical_record_snapshots cs
                 where cs.id = p_applies_to_snapshot_id and cs.session_id = p_session_id) then
    raise exception 'Target version does not belong to this session' using errcode = 'check_violation';
  end if;

  v_doc := jsonb_build_object(
    'schema', 'hone.clinical_amendment.v1',
    'session_id', p_session_id, 'applies_to_snapshot_id', p_applies_to_snapshot_id,
    'amendment_type', p_amendment_type, 'reason', p_reason,
    'body', p_body, 'structured_addition', p_structured_addition,
    'authored_by', v_actor);
  v_hash := encode(extensions.digest(v_doc::text, 'sha256'), 'hex');

  insert into public.clinical_record_amendments
    (studio_id, session_id, applies_to_snapshot_id, amendment_type, reason, body,
     structured_addition, authored_by, authored_by_display_name, content_hash)
  values
    (v_studio, p_session_id, p_applies_to_snapshot_id, p_amendment_type, p_reason, p_body,
     p_structured_addition, v_actor, v_actor_name, v_hash)
  returning id into v_amend_id;

  insert into public.clinical_audit_events
    (studio_id, session_id, operation_type, actor_practitioner_id, actor_display_name,
     snapshot_id, amendment_id, reason)
  values
    (v_studio, p_session_id, 'amendment', v_actor, v_actor_name,
     p_applies_to_snapshot_id, v_amend_id, p_reason);

  return query select v_amend_id, v_hash;
end;
$$;

-- ===========================================================================
-- 9. Trusted LATE-PHOTO amendment RPC (attaches a NEW image to a finalized session
--    under the narrow correction permit; bytes are uploaded by the app first).
-- ===========================================================================
create or replace function public.amend_finalized_session_with_image(
  p_session_id uuid,
  p_applies_to_snapshot_id uuid,
  p_reason text,
  p_storage_bucket text,
  p_storage_path text,
  p_content_type text,
  p_size_bytes bigint,
  p_original_filename text,
  p_session_block_id uuid,
  p_practitioner_note text
)
returns table (amendment_id uuid, image_id uuid, content_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid; v_client uuid; v_status text; v_origin text; v_flag boolean;
  v_actor uuid; v_actor_name text; v_hash text; v_amend_id uuid; v_img_id uuid; v_doc jsonb;
begin
  select s.studio_id, s.client_id, s.record_status, s.record_origin
    into v_studio, v_client, v_status, v_origin
  from public.sessions s
  where s.id = p_session_id and s.deleted_at is null and public.is_studio_member(s.studio_id)
  for update;
  if not found then raise exception 'Session not found or not accessible' using errcode = 'check_violation'; end if;

  select st.clinical_corrections_enabled into v_flag from public.studios st where st.id = v_studio;
  if not coalesce(v_flag, false) then raise exception 'Clinical corrections are not enabled for this studio' using errcode = 'check_violation'; end if;

  select p.id, p.display_name into v_actor, v_actor_name
  from public.practitioners p where p.user_id = auth.uid() and p.active = true and p.studio_id = v_studio limit 1;
  if v_actor is null then raise exception 'Caller is not an active practitioner in this studio' using errcode = 'check_violation'; end if;

  if v_origin <> 'native' then raise exception 'Only native records can be amended' using errcode = 'check_violation'; end if;
  if v_status <> 'finalized' then raise exception 'Session is not finalized' using errcode = 'check_violation'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'A reason is required' using errcode = 'check_violation'; end if;
  if p_storage_bucket is null or p_storage_path is null or p_content_type is null or p_size_bytes is null then
    raise exception 'Image metadata is incomplete' using errcode = 'check_violation'; end if;
  if not exists (select 1 from public.clinical_record_snapshots cs where cs.id = p_applies_to_snapshot_id and cs.session_id = p_session_id) then
    raise exception 'Target version does not belong to this session' using errcode = 'check_violation'; end if;
  if p_session_block_id is not null and not exists (
       select 1 from public.session_blocks b where b.id = p_session_block_id and b.session_id = p_session_id) then
    raise exception 'Target block does not belong to this session' using errcode = 'check_violation'; end if;

  -- Narrow correction permit: allow the trusted INSERT of the new image onto THIS
  -- finalized session (0093 parent-consistency still enforced on INSERT).
  perform set_config('hone.correction_session_id', p_session_id::text, true);
  insert into public.treatment_images
    (studio_id, client_id, session_id, session_block_id, storage_bucket, storage_path,
     original_filename, content_type, size_bytes, uploaded_by, practitioner_note)
  values
    (v_studio, v_client, p_session_id, p_session_block_id, p_storage_bucket, p_storage_path,
     p_original_filename, p_content_type, p_size_bytes, v_actor, p_practitioner_note)
  returning id into v_img_id;
  perform set_config('hone.correction_session_id', '', true);

  v_doc := jsonb_build_object(
    'schema', 'hone.clinical_amendment.v1', 'session_id', p_session_id,
    'applies_to_snapshot_id', p_applies_to_snapshot_id, 'amendment_type', 'photo',
    'reason', p_reason, 'treatment_image_id', v_img_id, 'authored_by', v_actor);
  v_hash := encode(extensions.digest(v_doc::text, 'sha256'), 'hex');

  insert into public.clinical_record_amendments
    (studio_id, session_id, applies_to_snapshot_id, amendment_type, reason,
     linked_entity_type, linked_entity_id, authored_by, authored_by_display_name, content_hash)
  values
    (v_studio, p_session_id, p_applies_to_snapshot_id, 'photo', p_reason,
     'treatment_image', v_img_id, v_actor, v_actor_name, v_hash)
  returning id into v_amend_id;

  insert into public.clinical_audit_events
    (studio_id, session_id, operation_type, actor_practitioner_id, actor_display_name,
     snapshot_id, amendment_id, affected_entity_type, affected_entity_ids, reason)
  values
    (v_studio, p_session_id, 'amendment', v_actor, v_actor_name,
     p_applies_to_snapshot_id, v_amend_id, 'image', jsonb_build_array(v_img_id), p_reason);

  return query select v_amend_id, v_img_id, v_hash;
end;
$$;

-- ===========================================================================
-- 10. Trusted CORRECTION RPC (atomic: version N -> N+1). The ONLY setter of the
--     correction GUC for normalized rows.
-- ===========================================================================
create or replace function public.correct_finalized_session(
  p_session_id uuid,
  p_expected_record_version integer,
  p_reason text,
  p_payload jsonb
)
returns table (snapshot_id uuid, new_version integer, content_hash text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid; v_status text; v_origin text; v_version integer; v_prev_snap uuid;
  v_flag boolean; v_actor uuid; v_actor_name text;
  v_new_ver integer; v_snapshot jsonb; v_hash text; v_snap_id uuid; v_elem jsonb;
begin
  -- Lock + ownership (serializes concurrent corrections -> one winner).
  select s.studio_id, s.record_status, s.record_origin, s.record_version, s.current_snapshot_id
    into v_studio, v_status, v_origin, v_version, v_prev_snap
  from public.sessions s
  where s.id = p_session_id and s.deleted_at is null and public.is_studio_member(s.studio_id)
  for update;
  if not found then raise exception 'Session not found or not accessible' using errcode = 'check_violation'; end if;

  select st.clinical_corrections_enabled into v_flag from public.studios st where st.id = v_studio;
  if not coalesce(v_flag, false) then raise exception 'Clinical corrections are not enabled for this studio' using errcode = 'check_violation'; end if;

  select p.id, p.display_name into v_actor, v_actor_name
  from public.practitioners p where p.user_id = auth.uid() and p.active = true and p.studio_id = v_studio limit 1;
  if v_actor is null then raise exception 'Caller is not an active practitioner in this studio' using errcode = 'check_violation'; end if;

  if v_origin <> 'native' then raise exception 'Only native records can be corrected' using errcode = 'check_violation'; end if;
  if v_status <> 'finalized' then raise exception 'Session is not finalized (status=%)', v_status using errcode = 'check_violation'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'A correction reason is required' using errcode = 'check_violation'; end if;
  -- Compare-and-set.
  if p_expected_record_version is null or p_expected_record_version <> v_version then
    raise exception 'Record version conflict (expected %, actual %)', p_expected_record_version, v_version using errcode = 'check_violation';
  end if;
  -- Reject unknown payload sections.
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'A correction payload is required' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k
             where k not in ('session','blocks','electrolysis_entries','laser_entries','images')) then
    raise exception 'Unknown correction payload section' using errcode = 'check_violation';
  end if;

  -- BEGIN trusted correction context (row-scoped, transaction-local).
  perform set_config('hone.correction_session_id', p_session_id::text, true);

  if p_payload ? 'session' then
    perform public._apply_session_correction(p_session_id, p_payload->'session');
  end if;
  if p_payload ? 'blocks' then
    for v_elem in select jsonb_array_elements(p_payload->'blocks') loop
      perform public._apply_block_correction(p_session_id, v_elem);
    end loop;
  end if;
  if p_payload ? 'electrolysis_entries' then
    for v_elem in select jsonb_array_elements(p_payload->'electrolysis_entries') loop
      perform public._apply_electrolysis_correction(p_session_id, v_elem);
    end loop;
  end if;
  if p_payload ? 'laser_entries' then
    for v_elem in select jsonb_array_elements(p_payload->'laser_entries') loop
      perform public._apply_laser_correction(p_session_id, v_elem);
    end loop;
  end if;
  if p_payload ? 'images' then
    for v_elem in select jsonb_array_elements(p_payload->'images') loop
      perform public._apply_image_correction(p_session_id, v_elem);
    end loop;
  end if;

  v_new_ver := v_version + 1;
  v_snapshot := public.build_session_snapshot(p_session_id);
  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');

  -- Corrected record must still satisfy minimum charting (never empty).
  if coalesce(jsonb_array_length(v_snapshot->'blocks'), 0) < 1
     or (coalesce(jsonb_array_length(v_snapshot->'electrolysis_entries'), 0)
         + coalesce(jsonb_array_length(v_snapshot->'laser_entries'), 0)) < 1 then
    raise exception 'A correction cannot leave the record without a treatment area/pass' using errcode = 'check_violation';
  end if;

  -- Each snapshot version records ITS OWN signer. This correction version is signed
  -- by the corrector now(); the original signer + time are permanently preserved on
  -- the superseded version (RESTRICT-immutable) and reachable via the supersede chain.
  insert into public.clinical_record_snapshots
    (studio_id, session_id, version_no, snapshot, content_hash, hash_algorithm,
     canonicalization_version, finalized_by, finalized_at, attestation_text,
     signed, backfilled, record_origin, version_type, supersedes_snapshot_id,
     correction_reason, corrected_by, corrected_by_display_name, corrected_at)
  values
    (v_studio, p_session_id, v_new_ver, v_snapshot, v_hash, 'sha256',
     1, v_actor, now(),
     'Corrected by ' || v_actor_name || ' (' || v_actor::text || ') at ' || now()::text
       || '. Supersedes version ' || v_version::text || '. Reason: ' || p_reason,
     true, false, 'native', 'correction', v_prev_snap,
     p_reason, v_actor, v_actor_name, now())
  returning id into v_snap_id;

  -- Advance the version + re-point current_snapshot_id; record_status stays finalized.
  update public.sessions
     set record_version = v_new_ver, current_snapshot_id = v_snap_id
   where id = p_session_id;

  -- END trusted correction context (also auto-discarded at COMMIT/ROLLBACK).
  perform set_config('hone.correction_session_id', '', true);

  insert into public.clinical_audit_events
    (studio_id, session_id, operation_type, actor_practitioner_id, actor_display_name,
     record_version_before, record_version_after, snapshot_id, previous_snapshot_id, reason)
  values
    (v_studio, p_session_id, 'correction', v_actor, v_actor_name,
     v_version, v_new_ver, v_snap_id, v_prev_snap, p_reason);

  return query select v_snap_id, v_new_ver, v_hash;
end;
$$;

-- ===========================================================================
-- 11. Grants (narrow): callable only by authenticated; never anon/public.
-- ===========================================================================
revoke execute on function public.amend_finalized_session(uuid, uuid, text, text, text, jsonb) from anon, public;
grant execute on function public.amend_finalized_session(uuid, uuid, text, text, text, jsonb) to authenticated;

revoke execute on function public.amend_finalized_session_with_image(uuid, uuid, text, text, text, text, bigint, text, uuid, text) from anon, public;
grant execute on function public.amend_finalized_session_with_image(uuid, uuid, text, text, text, text, bigint, text, uuid, text) to authenticated;

revoke execute on function public.correct_finalized_session(uuid, integer, text, jsonb) from anon, public;
grant execute on function public.correct_finalized_session(uuid, integer, text, jsonb) to authenticated;
