-- 0119_clinical_record_finalization_phase1.sql
--
-- Clinical-record architecture — PHASE 1: the finalization boundary.
--
-- Introduces a real draft -> finalized lifecycle for the clinical ENCOUNTER
-- (a session), an immutable finalized SNAPSHOT artifact, a trusted finalize RPC,
-- and DB-enforced write guards that make a finalized record read-only to EVERY
-- runtime role (authenticated members AND service-role). Corrections, amendments,
-- the hash-chained audit ledger, the treatment-memory projection, and photo
-- content-addressing are LATER phases.
--
-- BINDING DECISIONS honored here:
--   * Normalized relational rows remain canonical; the snapshot is an audit/
--     export/tamper-evidence artifact, NOT a read source. No projection table.
--   * The existing `sessions` row stays the encounter aggregate root (no rename).
--   * Native lifecycle: draft -> finalized (-> void reserved, but NO Phase-1 path
--     INTO void; there is no reopen/void/correction/amendment RPC or UI).
--   * PROVENANCE: existing rows are marked record_origin='legacy' (metadata-only,
--     see below); future rows default to 'native'. Legacy rows are NEVER finalized,
--     signed, or given a fabricated finalized_at/by. The finalize RPC rejects any
--     row where record_origin <> 'native'.
--   * Snapshots/lineage NEVER cascade-delete (RESTRICT/NO ACTION everywhere) and
--     cannot be hard-deleted; a finalized session cannot be hard-deleted.
--   * Integrity is enforced by TRIGGERS (final guarantee), not UI/RLS/service-role
--     trust. NO broad service-role / auth.uid()-null / GUC bypass exists.
--   * price_paid_cents is OPERATIONAL billing data: excluded from the snapshot and
--     left mutable after finalization (see decision 13). appointment_id /
--     treatment_plan_id are relational links, also excluded from the snapshot and
--     left mutable (re-linking/reconciliation must not break). EVERYTHING else on
--     a finalized session is frozen.
--   * Treatment-memory reads (Last Visit / Before Today / Treatment Intelligence /
--     reporting) are UNCHANGED. No Stripe/payment/email/SMS/booking change.
--
-- MIGRATION-FIRST SAFETY: purely additive schema + inert guards. record_status
-- defaults to 'draft', so at apply time ZERO sessions are finalized -> every guard
-- is inert -> deployed OLD code is unaffected -> no break window. The record_origin
-- default flip ('legacy' at ADD time, then 'native' for future inserts) is a
-- METADATA-ONLY change on PG 11+ (attmissingval) — no physical row rewrite, no
-- clinical data touched.
--
-- Migration max 0118 -> 0119.

-- ===========================================================================
-- 1. Session lifecycle + provenance columns (additive).
-- ===========================================================================
-- Lifecycle. finalized_by uses ON DELETE RESTRICT so finalization attribution
-- can never be nulled by deleting a practitioner (see also section 8 trigger).
alter table public.sessions
  add column if not exists record_status text not null default 'draft',
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_by uuid references public.practitioners(id) on delete restrict,
  add column if not exists record_version integer not null default 1,
  add column if not exists current_snapshot_id uuid;

-- Provenance: existing rows classify as 'legacy' (default at ADD time -> applies to
-- all 59 pre-existing rows as a metadata-only default); future inserts default to
-- 'native' (the SET DEFAULT below only affects new rows).
alter table public.sessions
  add column if not exists record_origin text not null default 'legacy';
alter table public.sessions
  alter column record_origin set default 'native';

-- Descriptive legacy classification (review-queue assigned; NOT auto-inferred here
-- because the historical data has no reliable completion signal — see PR notes).
alter table public.sessions
  add column if not exists legacy_classification text;

alter table public.sessions drop constraint if exists sessions_record_status_check;
alter table public.sessions add constraint sessions_record_status_check
  check (record_status in ('draft', 'finalized', 'void'));

alter table public.sessions drop constraint if exists sessions_record_origin_check;
alter table public.sessions add constraint sessions_record_origin_check
  check (record_origin in ('native', 'legacy'));

alter table public.sessions drop constraint if exists sessions_legacy_classification_check;
alter table public.sessions add constraint sessions_legacy_classification_check
  check (legacy_classification is null
         or legacy_classification in ('clearly_completed', 'clearly_incomplete', 'ambiguous'));

-- Only legacy rows may carry a classification; native rows must have NULL.
alter table public.sessions drop constraint if exists sessions_classification_origin_check;
alter table public.sessions add constraint sessions_classification_origin_check
  check (legacy_classification is null or record_origin = 'legacy');

create index if not exists sessions_record_status_idx
  on public.sessions (studio_id, record_status)
  where deleted_at is null;

-- ===========================================================================
-- 2. Studio-scoped feature flag (default OFF; studio-scoped, NOT global).
-- ===========================================================================
alter table public.studios
  add column if not exists clinical_finalization_enabled boolean not null default false;

-- ===========================================================================
-- 3. Immutable finalized snapshot artifact.
-- ===========================================================================
create table if not exists public.clinical_record_snapshots (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  session_id uuid not null,
  version_no integer not null,
  snapshot jsonb not null,
  content_hash text not null,
  hash_algorithm text not null default 'sha256',
  canonicalization_version integer not null default 1,
  finalized_by uuid references public.practitioners(id) on delete restrict,
  finalized_at timestamptz not null,
  attestation_text text,
  signed boolean not null default false,     -- practitioner-signed (false for any future backfilled legacy)
  backfilled boolean not null default false, -- legacy backfill marker (Phase 1: always false)
  record_origin text not null default 'native',
  created_at timestamptz not null default now(),
  unique (session_id, version_no)
);

-- Snapshot -> studio: RESTRICT. Deleting a studio can never silently drop a
-- permanent clinical artifact.
alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_studio_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_studio_fk
  foreign key (studio_id) references public.studios(id) on delete restrict;

-- Snapshot -> session: plain FK, RESTRICT. Deleting a session can never delete
-- its snapshot (see also the session BEFORE DELETE guard, section 5).
alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_session_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_session_fk
  foreign key (session_id) references public.sessions(id) on delete restrict;

-- Same-studio composite FK (0094 pattern), RESTRICT: a snapshot can only bind to a
-- session in the SAME studio. Uses the existing sessions_studio_id_uniq (studio_id,id).
alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_session_same_studio_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_session_same_studio_fk
  foreign key (studio_id, session_id) references public.sessions (studio_id, id) on delete restrict;

-- sessions.current_snapshot_id -> snapshot: NO ACTION (never cascades; and the
-- snapshot immutability trigger + RESTRICT above make deletion impossible anyway).
alter table public.sessions
  drop constraint if exists sessions_current_snapshot_fk;
alter table public.sessions
  add constraint sessions_current_snapshot_fk
  foreign key (current_snapshot_id) references public.clinical_record_snapshots(id) on delete no action;

alter table public.clinical_record_snapshots enable row level security;

-- Studio-scoped SELECT for members. NO authenticated insert/update/delete policy:
-- the ONLY writer is the SECURITY DEFINER finalize RPC. Anon: nothing.
drop policy if exists "clinical_record_snapshots_member_select" on public.clinical_record_snapshots;
create policy "clinical_record_snapshots_member_select"
  on public.clinical_record_snapshots for select to authenticated
  using (public.is_studio_member(studio_id));

-- Belt-and-suspenders: revoke direct write grants from client roles so even a
-- crafted PostgREST call cannot mutate a snapshot.
revoke insert, update, delete, truncate on public.clinical_record_snapshots from anon, authenticated;
revoke all on public.clinical_record_snapshots from public;

-- Append-only at the storage layer: block UPDATE/DELETE for EVERY role (including
-- service-role and the table owner). The finalize RPC only INSERTs; it never
-- updates a snapshot. This makes existing snapshots immutable even to broad
-- service-role runtime paths.
create or replace function public.guard_snapshot_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception
    'clinical_record_snapshots is append-only: snapshots cannot be updated or deleted.'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists clinical_record_snapshots_append_only on public.clinical_record_snapshots;
create trigger clinical_record_snapshots_append_only
  before update or delete on public.clinical_record_snapshots
  for each row execute function public.guard_snapshot_append_only();

-- ===========================================================================
-- 4. Deterministic snapshot builder (canonical clinical document).
-- ===========================================================================
-- Determinism guarantees (same unchanged relational encounter -> same SHA-256):
--   * jsonb canonicalizes object key order.
--   * Every array has an explicit ORDER BY with a stable secondary id tiebreak.
--   * Timestamps are rendered in UTC via to_char (NOT the connection TimeZone GUC),
--     so the hash is identical under any database timezone.
--   * DELETED / voided children are EXCLUDED (deleted_at is null); the normalized
--     model still retains them. The snapshot is "treatment recorded as performed".
--   * Practitioner IDENTITY EVIDENCE (display_name) is captured inline so
--     attribution survives account changes.
--   * price_paid_cents is EXCLUDED (operational billing; decision 13).
--   * updated_at and other transient fields are EXCLUDED.
--   * Photos are METADATA references only (id/bucket/path/hash-if-present/times) —
--     never image bytes, signed URLs, temporary URLs, or secrets.
create or replace function public.build_session_snapshot(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema', 'hone.clinical_snapshot.v1',
    'session', (
      select jsonb_build_object(
        'id', s.id, 'client_id', s.client_id,
        'practitioner_id', s.practitioner_id,
        'practitioner_display_name', (select p.display_name from public.practitioners p where p.id = s.practitioner_id),
        'performed_by_practitioner_id', s.performed_by_practitioner_id,
        'performed_by_display_name', (select p.display_name from public.practitioners p where p.id = s.performed_by_practitioner_id),
        'modality', s.modality,
        'started_at', to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'ended_at', to_char(s.ended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'started_at_original', to_char(s.started_at_original at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'session_notes', s.session_notes, 'next_session_note', s.next_session_note,
        'aftercare_explained_at', to_char(s.aftercare_and_risks_explained_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'aftercare_explained_by', s.aftercare_and_risks_explained_by
      ) from public.sessions s where s.id = p_session_id
    ),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'sort_order', b.sort_order, 'block_name', b.block_name,
        'primary_area', b.primary_area, 'side', b.side, 'custom_area_detail', b.custom_area_detail,
        'mode', b.mode, 'apilus_modality', b.apilus_modality, 'energy_level', b.energy_level,
        'minutes_performed', b.minutes_performed, 'probe_label', b.probe_label,
        'probe_lot_number', b.probe_lot_number, 'machine_frequency', b.machine_frequency,
        'tolerance_rating', b.tolerance_rating, 'reaction_type', b.reaction_type,
        'reaction_notes', b.reaction_notes, 'caution_for_next_session', b.caution_for_next_session,
        'caution_note', b.caution_note
      ) order by b.sort_order, b.id)
      from public.session_blocks b
      where b.session_id = p_session_id and b.deleted_at is null
    ), '[]'::jsonb),
    'electrolysis_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id, 'block_id', e.block_id, 'area', e.area, 'mode', e.mode,
        'observation_chips', e.observation_chips, 'comments', e.comments,
        'hairs_treated', e.hairs_treated, 'minutes_performed', e.minutes_performed,
        'created_at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by e.created_at, e.id)
      from public.electrolysis_entries e
      where e.session_id = p_session_id and e.deleted_at is null
    ), '[]'::jsonb),
    'laser_entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'zone', l.zone, 'session_number', l.session_number,
        'equipment_params', l.equipment_params, 'observation_notes', l.observation_notes,
        'ejection_results', l.ejection_results,
        'created_at', to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by l.created_at, l.id)
      from public.laser_entries l
      where l.session_id = p_session_id and l.deleted_at is null
    ), '[]'::jsonb),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ti.id, 'session_block_id', ti.session_block_id,
        'storage_bucket', ti.storage_bucket, 'storage_path', ti.storage_path,
        'content_type', ti.content_type, 'size_bytes', ti.size_bytes,
        'practitioner_note', ti.practitioner_note,
        'created_at', to_char(ti.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      ) order by ti.created_at, ti.id)
      from public.treatment_images ti
      where ti.session_id = p_session_id and ti.deleted_at is null
    ), '[]'::jsonb)
  );
$$;

revoke execute on function public.build_session_snapshot(uuid) from anon, authenticated, public;

-- ===========================================================================
-- 5. Finalized-record write guards (DB-enforced; ALL roles; NO bypass).
-- ===========================================================================
-- Once a session is finalized (or void), ordinary runtime paths cannot mutate the
-- signed clinical aggregate. There is intentionally NO service-role /
-- auth.uid()-null / GUC escape hatch: any future recovery must be a separate
-- narrow, attributable RPC. The finalize RPC itself needs no bypass because it acts
-- on a DRAFT (old.record_status='draft' at the flip), and never writes children.
create or replace function public.guard_finalized_clinical_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_new_status text;
  v_msg constant text :=
    'This clinical record is finalized and read-only. Corrections/amendments (a later phase) preserve the original.';
begin
  -- --- sessions ---------------------------------------------------------------
  if tg_table_name = 'sessions' then
    if tg_op = 'DELETE' then
      -- No finalized clinical record (or any session with a snapshot) may be hard-deleted.
      if old.record_status in ('finalized', 'void')
         or exists (select 1 from public.clinical_record_snapshots cs where cs.session_id = old.id) then
        raise exception 'This clinical record is finalized and cannot be deleted (retraction/void is a later phase).'
          using errcode = 'check_violation';
      end if;
      return old;
    end if;
    -- UPDATE: on a finalized/void session, freeze everything EXCEPT the operational
    -- fields that are deliberately not part of the signed record and not in the
    -- snapshot: price_paid_cents, appointment_id, treatment_plan_id.
    if old.record_status in ('finalized', 'void') then
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
        if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
      end if;
      return new;
    else
      -- UPDATE: block if the current OR the target session is finalized (covers
      -- metadata edits, soft-delete, and reassignment into/out of a finalized session).
      if old.session_id is not null then
        select s.record_status into v_status from public.sessions s where s.id = old.session_id;
        if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
      end if;
      if new.session_id is not null and new.session_id is distinct from old.session_id then
        select s.record_status into v_new_status from public.sessions s where s.id = new.session_id;
        if v_new_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
      end if;
      return new;
    end if;
  end if;

  -- --- child clinical tables (session_blocks / electrolysis_entries / laser_entries) ---
  if tg_op = 'DELETE' then
    select s.record_status into v_status from public.sessions s where s.id = old.session_id;
    if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    return old;
  elsif tg_op = 'INSERT' then
    select s.record_status into v_status from public.sessions s where s.id = new.session_id;
    if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    return new;
  else
    select s.record_status into v_status from public.sessions s where s.id = old.session_id;
    if v_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    if new.session_id is distinct from old.session_id then
      select s.record_status into v_new_status from public.sessions s where s.id = new.session_id;
      if v_new_status in ('finalized', 'void') then raise exception '%', v_msg using errcode = 'check_violation'; end if;
    end if;
    return new;
  end if;
end;
$$;

drop trigger if exists sessions_guard_finalized on public.sessions;
create trigger sessions_guard_finalized
  before update or delete on public.sessions
  for each row execute function public.guard_finalized_clinical_write();

drop trigger if exists session_blocks_guard_finalized on public.session_blocks;
create trigger session_blocks_guard_finalized
  before insert or update or delete on public.session_blocks
  for each row execute function public.guard_finalized_clinical_write();

drop trigger if exists electrolysis_entries_guard_finalized on public.electrolysis_entries;
create trigger electrolysis_entries_guard_finalized
  before insert or update or delete on public.electrolysis_entries
  for each row execute function public.guard_finalized_clinical_write();

drop trigger if exists laser_entries_guard_finalized on public.laser_entries;
create trigger laser_entries_guard_finalized
  before insert or update or delete on public.laser_entries
  for each row execute function public.guard_finalized_clinical_write();

drop trigger if exists treatment_images_guard_finalized on public.treatment_images;
create trigger treatment_images_guard_finalized
  before insert or update or delete on public.treatment_images
  for each row execute function public.guard_finalized_clinical_write();

-- ===========================================================================
-- 6. Practitioner attribution retention (BEFORE DELETE on practitioners).
-- ===========================================================================
-- Deactivation stays allowed. Hard deletion is rejected ONLY when the practitioner
-- is referenced by a FINALIZED clinical record (finalized_by / practitioner_id /
-- performed_by_practitioner_id) or any snapshot — so historical attribution
-- survives account deletion, without globally blocking draft-only cleanup.
create or replace function public.guard_practitioner_finalized_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (select 1 from public.clinical_record_snapshots cs where cs.finalized_by = old.id)
     or exists (
       select 1 from public.sessions s
       where s.record_status in ('finalized', 'void')
         and (s.finalized_by = old.id
              or s.practitioner_id = old.id
              or s.performed_by_practitioner_id = old.id)
     ) then
    raise exception
      'Cannot delete a practitioner referenced by a finalized clinical record. Deactivate the practitioner instead.'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end;
$$;

drop trigger if exists practitioners_block_finalized_delete on public.practitioners;
create trigger practitioners_block_finalized_delete
  before delete on public.practitioners
  for each row execute function public.guard_practitioner_finalized_refs();

-- ===========================================================================
-- 7. Trusted finalization RPC (atomic, idempotent, concurrency-safe).
-- ===========================================================================
-- expected_record_version is kept in the signature for future compare-and-set
-- correction behavior. At INITIAL finalization it must equal 1 and the session
-- version is NOT incremented (session.record_version stays 1; snapshot.version_no=1;
-- current_snapshot_id -> version 1).
create or replace function public.finalize_session(
  p_session_id uuid,
  p_expected_record_version integer
)
returns table (snapshot_id uuid, version_no integer, content_hash text, already_finalized boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_status text;
  v_origin text;
  v_version integer;
  v_flag boolean;
  v_actor uuid;
  v_actor_name text;
  v_snapshot jsonb;
  v_hash text;
  v_snap_id uuid;
  v_snap_ver integer;
begin
  -- Lock the session row: serializes concurrent finalizes -> exactly one winner.
  -- Ownership via is_studio_member (studio derived from the row, never the caller).
  select s.studio_id, s.record_status, s.record_origin, s.record_version
    into v_studio, v_status, v_origin, v_version
  from public.sessions s
  where s.id = p_session_id
    and s.deleted_at is null
    and public.is_studio_member(s.studio_id)
  for update;
  if not found then
    raise exception 'Session not found or not accessible' using errcode = 'check_violation';
  end if;

  -- Idempotency FIRST (studio-locked above, so this can never reveal another
  -- studio's snapshot): a repeat call returns THIS session's existing snapshot,
  -- inserts nothing, regardless of current flag state.
  if v_status = 'finalized' then
    select cs.id, cs.version_no, cs.content_hash
      into v_snap_id, v_snap_ver, v_hash
    from public.clinical_record_snapshots cs
    where cs.session_id = p_session_id
    order by cs.version_no desc
    limit 1;
    return query select v_snap_id, v_snap_ver, v_hash, true;
    return;
  end if;

  -- Feature flag enforced INSIDE the RPC (studio-scoped; app checks are UX-only).
  select st.clinical_finalization_enabled into v_flag
  from public.studios st where st.id = v_studio;
  if not coalesce(v_flag, false) then
    raise exception 'Clinical finalization is not enabled for this studio' using errcode = 'check_violation';
  end if;

  -- Actor = the caller's OWN active practitioner in THIS studio (server-derived).
  select p.id, p.display_name into v_actor, v_actor_name
  from public.practitioners p
  where p.user_id = auth.uid() and p.active = true and p.studio_id = v_studio
  limit 1;
  if v_actor is null then
    raise exception 'Caller is not an active practitioner in this studio' using errcode = 'check_violation';
  end if;

  -- Eligibility: native drafts only. Legacy/void/other are never finalizable here.
  if v_origin <> 'native' then
    raise exception 'Only native records can be finalized (record_origin=%)', v_origin using errcode = 'check_violation';
  end if;
  if v_status <> 'draft' then
    raise exception 'Session is not a draft (status=%)', v_status using errcode = 'check_violation';
  end if;

  -- Compare-and-set: at initial finalization the expected version must be 1.
  if p_expected_record_version is null or p_expected_record_version <> v_version then
    raise exception 'Record version conflict (expected %, actual %)',
      p_expected_record_version, v_version using errcode = 'check_violation';
  end if;

  -- Minimum charting: >= 1 live block AND >= 1 live entry (electrolysis in a live
  -- block, or laser in this session). A block with no entry is NOT sufficient;
  -- photos/notes/aftercare/appointment/price/timestamps alone are NOT sufficient.
  if not exists (
    select 1 from public.session_blocks b
    where b.session_id = p_session_id and b.deleted_at is null
  ) then
    raise exception 'Cannot finalize: the session has no treatment area (block).' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1
    from public.electrolysis_entries e
    join public.session_blocks b on b.id = e.block_id and b.deleted_at is null
    where e.session_id = p_session_id and e.deleted_at is null
    union all
    select 1
    from public.laser_entries l
    where l.session_id = p_session_id and l.deleted_at is null
  ) then
    raise exception 'Cannot finalize: the session has no treatment pass/reading in a live area.' using errcode = 'check_violation';
  end if;

  -- Canonical snapshot + deterministic SHA-256 content hash.
  v_snapshot := public.build_session_snapshot(p_session_id);
  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');

  -- Airtight min-charting on the PERSISTED ARTIFACT. Only the session row is
  -- FOR UPDATE-locked; child tables are not, so under READ COMMITTED a concurrent
  -- soft-delete of the last entry could slip between the checks above and this
  -- insert, yielding an EMPTY finalized snapshot. Re-validate the exact jsonb that
  -- is about to be stored (an in-memory value — immune to further concurrency), so
  -- a finalized clinical record can NEVER be empty. Belt-and-suspenders with the
  -- table checks above (which give the precise "in a live block" error early).
  if coalesce(jsonb_array_length(v_snapshot->'blocks'), 0) < 1
     or (coalesce(jsonb_array_length(v_snapshot->'electrolysis_entries'), 0)
         + coalesce(jsonb_array_length(v_snapshot->'laser_entries'), 0)) < 1 then
    raise exception
      'Cannot finalize: the snapshot has no treatment area/pass (content changed during finalization).'
      using errcode = 'check_violation';
  end if;

  -- Insert the immutable snapshot (version 1). The append-only trigger allows
  -- INSERT; nothing (not even this owner) may later UPDATE/DELETE it.
  insert into public.clinical_record_snapshots
    (studio_id, session_id, version_no, snapshot, content_hash, hash_algorithm,
     canonicalization_version, finalized_by, finalized_at, attestation_text,
     signed, backfilled, record_origin)
  values
    (v_studio, p_session_id, 1, v_snapshot, v_hash, 'sha256',
     1, v_actor, now(),
     'I confirm this accurately reflects the treatment performed. Finalized by '
       || v_actor_name || ' (' || v_actor::text || ') at ' || now()::text || '.',
     true, false, 'native')
  returning id into v_snap_id;

  -- Flip the session to finalized. record_version stays 1 (no increment at initial
  -- finalization; increments are reserved for future correction versions). OLD is
  -- still 'draft' here, so the finalized-write guard allows this transition.
  update public.sessions
     set record_status = 'finalized',
         finalized_at = now(),
         finalized_by = v_actor,
         current_snapshot_id = v_snap_id
   where id = p_session_id;

  -- Attributable finalization audit event (studio/actor-bound; NO PHI).
  insert into public.session_audit (session_id, edited_by_practitioner_id, field, old_value, new_value)
  values (p_session_id, v_actor, 'record_status', 'draft', 'finalized');

  return query select v_snap_id, 1, v_hash, false;
end;
$$;

revoke execute on function public.finalize_session(uuid, integer) from anon, public;
grant execute on function public.finalize_session(uuid, integer) to authenticated;
