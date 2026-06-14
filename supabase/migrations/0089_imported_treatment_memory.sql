-- Migration 0089: Imported Treatment Memory schema (PR #252).
--
-- A SAFE DESTINATION for historical treatment memory migrated from
-- paper cards, Jane, Fresha, Square, GlossGenius, Mangomint,
-- spreadsheets, or mixed notes. This is deliberately SEPARATE from the
-- live charting tables (sessions / session_blocks / electrolysis_entries
-- / laser_entries): imported history is messy, may be incomplete, may
-- have unparsed dates and shorthand, is manually typed or batch-pasted
-- during onboarding, and must NOT be treated as charted-live-in-Hone
-- clinical records. Writing paper/Jane rows into `sessions` is wrong:
-- `sessions.practitioner_id` is NOT NULL, `sessions.modality` is
-- CHECK-constrained to ('electrolysis','laser'), `started_at` defaults
-- to now(), and sessions drive forward-looking/clinical surfaces and
-- per-block charting. None of that fits flat historical import rows.
--
-- This migration is SCHEMA + READ-MODEL ONLY. It adds no importer UI,
-- no CSV/TSV parser, no OCR, no AI extraction, no image upload, no
-- third-party API sync. It stores NO raw CSV/TSV, NO file contents, NO
-- paper scans, NO uploaded images, NO OCR output, NO external provider
-- payloads -- only structured-ish text columns the future importer maps
-- into, plus a freeform imported_note.
--
-- Three tables:
--   * import_batches                       -- the unit of void/correction
--   * imported_treatment_memories          -- the durable imported rows
--   * imported_treatment_memory_audit_events -- append-only audit trail
--
-- Correction posture: imports are migration/editing data. Bad imports,
-- duplicate pastes, wrong column mappings, and typos are EXPECTED during
-- onboarding. So the schema supports OWNER correction via SOFT VOIDING
-- (voided_at / voided_by / void_reason), never uncontrolled hard delete.
-- No table grants a DELETE policy, so normal authenticated users (owner
-- included) cannot hard-delete imported history or batches.
--
-- RLS (studio-scoped, mirroring the project's is_studio_member /
-- is_studio_owner helpers from 0001):
--   import_batches / imported_treatment_memories
--     SELECT  any active studio member   (is_studio_member)
--     INSERT  studio owner only          (is_studio_owner)   -- migration
--     UPDATE  studio owner only          (is_studio_owner)   -- void/correct
--     DELETE  nobody (no policy)
--   imported_treatment_memory_audit_events
--     SELECT  any active studio member   (is_studio_member)
--     (no insert/update/delete policy: rows are written ONLY by the
--      SECURITY DEFINER trigger below; append-only, tamper-proof for
--      every normal authenticated client.)
--
-- Additive, re-runnable: every object uses if (not) exists / drop-if-
-- exists. No payment/auth changes. No public/anon grants. Live payments
-- remain disabled.

-- 1. import_batches -----------------------------------------------------------

create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  -- Where this batch came from. Constrained to a small known set so the
  -- future importer + UI can label provenance reliably.
  source_type text not null default 'other'
    check (source_type in (
      'paper_card',
      'jane',
      'fresha',
      'spreadsheet',
      'other'
    )),
  source_system text,
  source_label text,
  row_count integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Soft-void: a whole batch can be voided (the unit of correction when a
  -- paste goes wrong) without hard-deleting anything.
  voided_at timestamptz,
  voided_by uuid references auth.users(id) on delete set null,
  void_reason text,
  updated_at timestamptz not null default now()
);

create index if not exists import_batches_studio_idx
  on public.import_batches (studio_id, created_at desc);

-- 2. imported_treatment_memories ----------------------------------------------

create table if not exists public.imported_treatment_memories (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  -- client_id is REQUIRED: the future importer must resolve or create the
  -- client BEFORE writing imported memory (conservative matching is a
  -- PR #253 concern; this schema does not weaken it to nullable).
  client_id uuid not null
    references public.clients(id) on delete cascade,
  -- import_batch_id is REQUIRED and on delete RESTRICT: the batch is the
  -- void/rollback unit and must not be orphaned. Voiding is soft (columns
  -- below), never a hard delete of the parent batch.
  import_batch_id uuid not null
    references public.import_batches(id) on delete restrict,
  source_type text not null default 'other'
    check (source_type in (
      'paper_card',
      'jane',
      'fresha',
      'spreadsheet',
      'other'
    )),
  source_system text,
  source_label text,
  source_row_number integer,
  -- occurred_on: a CLEAN parsed visit date. occurred_on_text preserves
  -- the messy original date text when it could not be parsed.
  occurred_on date,
  occurred_on_text text,
  -- Text-heavy on purpose: imported paper/export data may not match Hone's
  -- structured charting format, so we preserve the practitioner's original
  -- wording rather than forcing structured clinical values in V1.
  treatment_area_text text,
  modality text,
  method_or_machine text,
  probe_type text,
  probe_size text,
  probe_lot text,
  tolerance_text text,
  reaction_text text,
  caution_note text,
  next_visit_note text,
  aftercare_marked boolean,
  imported_note text,
  imported_by uuid references auth.users(id) on delete set null,
  imported_at timestamptz not null default now(),
  -- Soft-void (per-row); the importer also sets these on every row of a
  -- voided batch.
  voided_at timestamptz,
  voided_by uuid references auth.users(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Read-helper ordering: newest visit first (occurred_on desc nulls last),
-- scoped by studio + client.
create index if not exists imported_treatment_memories_studio_client_idx
  on public.imported_treatment_memories (studio_id, client_id, occurred_on desc);
-- Batch void/lookup.
create index if not exists imported_treatment_memories_batch_idx
  on public.imported_treatment_memories (import_batch_id);

-- 3. imported_treatment_memory_audit_events -----------------------------------
--
-- A DEDICATED append-only audit trail for the import domain. It mirrors
-- the record_keeping_audit_events pattern (PR #206 / migration 0086) but
-- is a separate table so this migration touches NOTHING in the Record
-- Keeping audit infrastructure (no widening of its CHECKs, no edit to its
-- generic trigger function, which references created_by_practitioner_id
-- that the import tables do not have).

create table if not exists public.imported_treatment_memory_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  record_type text not null
    check (record_type in (
      'import_batch',
      'imported_treatment_memory'
    )),
  record_id uuid not null,
  action text not null
    check (action in (
      'created',
      'updated'
    )),
  changed_fields text[] not null default '{}',
  changes jsonb not null default '{}'::jsonb,
  actor_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  actor_user_id uuid,
  actor_display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists imported_treatment_memory_audit_events_studio_idx
  on public.imported_treatment_memory_audit_events (studio_id, created_at desc);
create index if not exists imported_treatment_memory_audit_events_record_idx
  on public.imported_treatment_memory_audit_events (record_type, record_id, created_at desc);

-- 4. updated_at triggers (reuse public.set_updated_at from 0015) ---------------

drop trigger if exists import_batches_set_updated_at on public.import_batches;
create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

drop trigger if exists imported_treatment_memories_set_updated_at
  on public.imported_treatment_memories;
create trigger imported_treatment_memories_set_updated_at
  before update on public.imported_treatment_memories
  for each row execute function public.set_updated_at();

-- 5. RLS ----------------------------------------------------------------------

alter table public.import_batches enable row level security;
drop policy if exists "import_batches: members select" on public.import_batches;
create policy "import_batches: members select"
  on public.import_batches for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "import_batches: owner insert" on public.import_batches;
create policy "import_batches: owner insert"
  on public.import_batches for insert to authenticated
  with check (public.is_studio_owner(studio_id));
drop policy if exists "import_batches: owner update" on public.import_batches;
create policy "import_batches: owner update"
  on public.import_batches for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));
-- No DELETE policy: imported batches cannot be hard-deleted by any normal
-- authenticated user. Correction is soft voiding (UPDATE, owner-only).

alter table public.imported_treatment_memories enable row level security;
drop policy if exists "imported_treatment_memories: members select"
  on public.imported_treatment_memories;
create policy "imported_treatment_memories: members select"
  on public.imported_treatment_memories for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "imported_treatment_memories: owner insert"
  on public.imported_treatment_memories;
create policy "imported_treatment_memories: owner insert"
  on public.imported_treatment_memories for insert to authenticated
  with check (public.is_studio_owner(studio_id));
drop policy if exists "imported_treatment_memories: owner update"
  on public.imported_treatment_memories;
create policy "imported_treatment_memories: owner update"
  on public.imported_treatment_memories for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));
-- No DELETE policy (same posture as import_batches).

alter table public.imported_treatment_memory_audit_events
  enable row level security;
-- SELECT only. Deliberately NO insert/update/delete/for-all policy: the
-- trail is append-only and is written ONLY by the SECURITY DEFINER
-- trigger function below.
drop policy if exists "imported_treatment_memory_audit_events: members select"
  on public.imported_treatment_memory_audit_events;
create policy "imported_treatment_memory_audit_events: members select"
  on public.imported_treatment_memory_audit_events for select to authenticated
  using (public.is_studio_member(studio_id));

-- 6. Audit trigger ------------------------------------------------------------
--
-- Diff-and-insert, mirroring public.record_keeping_audit_row() (0086):
-- SECURITY DEFINER + empty search_path; computes a changed-field diff
-- (excluding identity/timestamp columns) and inserts one append-only
-- event. Reuses the existing public.record_keeping_audit_actor() helper
-- (auth.uid() -> active practitioner in the studio); the definer function
-- runs as its owner, so the helper's revoked-from-authenticated EXECUTE
-- does not block it. Never stores a full row snapshot.

create or replace function public.imported_treatment_memory_audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record_type text;
  v_changed text[] := '{}';
  v_changes jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_actor_id uuid;
  v_actor_name text;
  v_skip constant text[] := array[
    'id','studio_id','created_at','updated_at'
  ];
begin
  v_record_type := case tg_table_name
    when 'import_batches' then 'import_batch'
    when 'imported_treatment_memories' then 'imported_treatment_memory'
  end;
  if v_record_type is null then
    return new;
  end if;

  select a.practitioner_id, a.display_name
    into v_actor_id, v_actor_name
  from public.record_keeping_audit_actor(new.studio_id) a;

  if tg_op = 'INSERT' then
    insert into public.imported_treatment_memory_audit_events
      (studio_id, record_type, record_id, action, changed_fields, changes,
       actor_practitioner_id, actor_user_id, actor_display_name)
    values
      (new.studio_id, v_record_type, new.id, 'created', '{}', '{}'::jsonb,
       v_actor_id, auth.uid(), v_actor_name);
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);
  for v_key in select jsonb_object_keys(v_new) loop
    if v_key = any(v_skip) then
      continue;
    end if;
    if v_old -> v_key is distinct from v_new -> v_key then
      v_changed := v_changed || v_key;
      v_changes := v_changes || jsonb_build_object(
        v_key,
        jsonb_build_object('old', v_old -> v_key, 'new', v_new -> v_key)
      );
    end if;
  end loop;
  if array_length(v_changed, 1) is null then
    return new;
  end if;

  insert into public.imported_treatment_memory_audit_events
    (studio_id, record_type, record_id, action, changed_fields, changes,
     actor_practitioner_id, actor_user_id, actor_display_name)
  values
    (new.studio_id, v_record_type, new.id, 'updated', v_changed, v_changes,
     v_actor_id, auth.uid(), v_actor_name);
  return new;
end;
$$;

drop trigger if exists import_batches_audit on public.import_batches;
create trigger import_batches_audit
  after insert or update on public.import_batches
  for each row execute function public.imported_treatment_memory_audit_row();

drop trigger if exists imported_treatment_memories_audit
  on public.imported_treatment_memories;
create trigger imported_treatment_memories_audit
  after insert or update on public.imported_treatment_memories
  for each row execute function public.imported_treatment_memory_audit_row();

-- The definer function must run ONLY via the triggers above; revoke
-- direct EXECUTE so no normal role can invoke it as an RPC. (Trigger
-- firing checks privileges at trigger-creation time, not call time, so
-- the triggers keep working after the revoke.)
revoke execute on function public.imported_treatment_memory_audit_row()
  from public, anon, authenticated;

-- 7. Privilege-layer hardening ------------------------------------------------
--
-- RLS does NOT gate TRUNCATE, and Supabase grants ALL on public tables to
-- anon/authenticated by default. Without this, the "no hard delete /
-- soft-void only" posture and the "append-only, tamper-proof" audit trail
-- could be bypassed at the privilege layer (e.g. TRUNCATE the audit table,
-- or TRUNCATE import_batches CASCADE -- which is NOT stopped by the per-row
-- `on delete restrict` FK). Revoke TRUNCATE + DELETE on all three tables so
-- no normal authenticated user can hard-delete imported history; correction
-- stays soft voiding (owner UPDATE) only. The audit table additionally
-- revokes INSERT + UPDATE so it is writable ONLY by the SECURITY DEFINER
-- trigger above (which runs as the table owner and is unaffected by these
-- revokes). The owner/postgres role retains all privileges (admin path).
revoke truncate, delete on
  public.import_batches,
  public.imported_treatment_memories,
  public.imported_treatment_memory_audit_events
  from anon, authenticated;
revoke insert, update on public.imported_treatment_memory_audit_events
  from anon, authenticated;
