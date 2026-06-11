-- Migration 0086: append-only audit trail for Record Keeping (PR #206).
--
-- Audits, via database TRIGGERS (not app code, so a normal
-- authenticated client cannot skip or forge events):
--   * record_keeping_sterile_items        created / updated
--   * record_keeping_disinfectants        created / updated
--   * record_keeping_exposure_incidents   created / updated
--   * sessions.aftercare_and_risks_explained_at
--                                         aftercare_marked / aftercare_cleared
--   * session_blocks.probe_lot_number     probe_lot_updated (only that
--                                         column; unrelated block edits
--                                         never write an event)
--
-- Immutability model:
--   * record_keeping_audit_events has RLS with a single studio-scoped
--     SELECT policy. There is NO insert, NO update, NO delete, and NO
--     for-all policy for authenticated users, so the trail is
--     append-only and tamper-proof for every normal app user.
--   * Rows are inserted ONLY by the three trigger functions below.
--     They are SECURITY DEFINER (owner-run, so the insert clears RLS)
--     with `set search_path = ''` and fully qualified references;
--     each function does exactly one thing: compute a diff of the row
--     that fired the trigger and insert one audit event. They read
--     nothing else and expose nothing.
--   * Actor resolution inside the trigger: auth.uid() mapped to the
--     studio's practitioners row (same mapping the project's RLS
--     helpers have used since 0001). Service-role writes have no
--     auth.uid(); creates fall back to the row's
--     created_by_practitioner_id, aftercare falls back to
--     aftercare_and_risks_explained_by.
--
-- Honest limits (documented, not hidden): the service-role key and
-- the database owner can bypass any in-database control; that is true
-- of every table in the project and is the standard Supabase posture.
-- For all NORMAL authenticated clients the trail cannot be skipped,
-- forged, edited, or deleted.
--
-- Audit content rules: diffs only (changed field names + old/new for
-- those fields), never full row snapshots; id/studio_id/created_at/
-- updated_at/created_by are excluded from diffs; no payment data, no
-- secrets. Additive only; no backfill; no payment/auth tables; no
-- public grants. Re-runnable throughout.

-- 1. Audit events table -------------------------------------------------------

create table if not exists public.record_keeping_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  record_type text not null
    check (record_type in (
      'sterile_item',
      'disinfectant',
      'exposure_incident',
      'session_aftercare',
      'session_block_probe_lot'
    )),
  record_id uuid not null,
  action text not null
    check (action in (
      'created',
      'updated',
      'aftercare_marked',
      'aftercare_cleared',
      'probe_lot_updated'
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

create index if not exists record_keeping_audit_events_studio_idx
  on public.record_keeping_audit_events (studio_id, created_at desc);
create index if not exists record_keeping_audit_events_record_idx
  on public.record_keeping_audit_events (record_type, record_id, created_at desc);

alter table public.record_keeping_audit_events enable row level security;
-- SELECT only. Deliberately NO insert/update/delete/for-all policy:
-- normal authenticated users can read their studio's trail and can
-- never write to it; only the security-definer trigger functions
-- below insert rows.
drop policy if exists "record_keeping_audit_events: members select"
  on public.record_keeping_audit_events;
create policy "record_keeping_audit_events: members select"
  on public.record_keeping_audit_events for select to authenticated
  using (public.is_studio_member(studio_id));

-- 2. Shared actor resolution --------------------------------------------------

-- Narrow helper: maps the calling JWT's auth.uid() to the acting
-- practitioner row within one studio. SECURITY DEFINER + empty
-- search_path; reads only public.practitioners; returns at most one
-- (id, name) pair and exposes nothing else.
create or replace function public.record_keeping_audit_actor(p_studio_id uuid)
returns table (practitioner_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(trim(p.display_name), ''), p.email)
  from public.practitioners p
  where p.user_id = auth.uid()
    and p.studio_id = p_studio_id
    and p.active = true
  limit 1;
$$;

-- 3. Logbook tables: created / updated ----------------------------------------

-- Generic diff-and-insert for the three record_keeping_* tables.
-- Diffs exclude identity/audit columns; an UPDATE that changes no
-- business field (e.g. an unchanged form resubmit, where only
-- updated_at moved) writes NO event.
create or replace function public.record_keeping_audit_row()
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
    'id','studio_id','created_at','updated_at','created_by_practitioner_id'
  ];
begin
  v_record_type := case tg_table_name
    when 'record_keeping_sterile_items' then 'sterile_item'
    when 'record_keeping_disinfectants' then 'disinfectant'
    when 'record_keeping_exposure_incidents' then 'exposure_incident'
  end;
  if v_record_type is null then
    return new;
  end if;

  select a.practitioner_id, a.display_name
    into v_actor_id, v_actor_name
  from public.record_keeping_audit_actor(new.studio_id) a;

  if tg_op = 'INSERT' then
    insert into public.record_keeping_audit_events
      (studio_id, record_type, record_id, action, changed_fields, changes,
       actor_practitioner_id, actor_user_id, actor_display_name)
    values
      (new.studio_id, v_record_type, new.id, 'created', '{}', '{}'::jsonb,
       coalesce(v_actor_id, new.created_by_practitioner_id), auth.uid(),
       v_actor_name);
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

  insert into public.record_keeping_audit_events
    (studio_id, record_type, record_id, action, changed_fields, changes,
     actor_practitioner_id, actor_user_id, actor_display_name)
  values
    (new.studio_id, v_record_type, new.id, 'updated', v_changed, v_changes,
     v_actor_id, auth.uid(), v_actor_name);
  return new;
end;
$$;

drop trigger if exists record_keeping_sterile_items_audit
  on public.record_keeping_sterile_items;
create trigger record_keeping_sterile_items_audit
  after insert or update on public.record_keeping_sterile_items
  for each row execute function public.record_keeping_audit_row();

drop trigger if exists record_keeping_disinfectants_audit
  on public.record_keeping_disinfectants;
create trigger record_keeping_disinfectants_audit
  after insert or update on public.record_keeping_disinfectants
  for each row execute function public.record_keeping_audit_row();

drop trigger if exists record_keeping_exposure_incidents_audit
  on public.record_keeping_exposure_incidents;
create trigger record_keeping_exposure_incidents_audit
  after insert or update on public.record_keeping_exposure_incidents
  for each row execute function public.record_keeping_audit_row();

-- 4. Sessions: aftercare marked / cleared -------------------------------------

create or replace function public.record_keeping_audit_session_aftercare()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
begin
  if old.aftercare_and_risks_explained_at
     is not distinct from new.aftercare_and_risks_explained_at then
    return new;
  end if;

  select a.practitioner_id, a.display_name
    into v_actor_id, v_actor_name
  from public.record_keeping_audit_actor(new.studio_id) a;

  insert into public.record_keeping_audit_events
    (studio_id, record_type, record_id, action, changed_fields, changes,
     actor_practitioner_id, actor_user_id, actor_display_name, metadata)
  values
    (new.studio_id, 'session_aftercare', new.id,
     case when new.aftercare_and_risks_explained_at is not null
       then 'aftercare_marked' else 'aftercare_cleared' end,
     array['aftercare_and_risks_explained_at'],
     jsonb_build_object('aftercare_and_risks_explained_at',
       jsonb_build_object(
         'old', to_jsonb(old.aftercare_and_risks_explained_at),
         'new', to_jsonb(new.aftercare_and_risks_explained_at))),
     coalesce(v_actor_id, new.aftercare_and_risks_explained_by),
     auth.uid(), v_actor_name,
     jsonb_build_object('client_id', new.client_id));
  return new;
end;
$$;

drop trigger if exists sessions_aftercare_audit on public.sessions;
create trigger sessions_aftercare_audit
  after update of aftercare_and_risks_explained_at on public.sessions
  for each row execute function public.record_keeping_audit_session_aftercare();

-- 5. Session blocks: probe lot updated ----------------------------------------

-- Only the probe_lot_number column is audited; the UPDATE trigger is
-- scoped to that column AND guarded with a WHEN clause, so unrelated
-- treatment-area edits never write an event. INSERTs audit only when
-- a lot was actually recorded.
create or replace function public.record_keeping_audit_probe_lot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_actor_name text;
  v_old text;
begin
  v_old := case when tg_op = 'INSERT' then null else old.probe_lot_number end;
  select a.practitioner_id, a.display_name
    into v_actor_id, v_actor_name
  from public.record_keeping_audit_actor(new.studio_id) a;

  insert into public.record_keeping_audit_events
    (studio_id, record_type, record_id, action, changed_fields, changes,
     actor_practitioner_id, actor_user_id, actor_display_name, metadata)
  values
    (new.studio_id, 'session_block_probe_lot', new.id, 'probe_lot_updated',
     array['probe_lot_number'],
     jsonb_build_object('probe_lot_number',
       jsonb_build_object('old', to_jsonb(v_old),
                          'new', to_jsonb(new.probe_lot_number))),
     v_actor_id, auth.uid(), v_actor_name,
     jsonb_build_object('session_id', new.session_id));
  return new;
end;
$$;

drop trigger if exists session_blocks_probe_lot_audit_insert
  on public.session_blocks;
create trigger session_blocks_probe_lot_audit_insert
  after insert on public.session_blocks
  for each row
  when (new.probe_lot_number is not null)
  execute function public.record_keeping_audit_probe_lot();

drop trigger if exists session_blocks_probe_lot_audit_update
  on public.session_blocks;
create trigger session_blocks_probe_lot_audit_update
  after update of probe_lot_number on public.session_blocks
  for each row
  when (old.probe_lot_number is distinct from new.probe_lot_number)
  execute function public.record_keeping_audit_probe_lot();

-- 6. Lock down direct execution of the definer functions -----------------------

-- Postgres grants EXECUTE on new functions to PUBLIC by default.
-- These four functions must run ONLY via the triggers above (trigger
-- firing checks function privileges at trigger-creation time, not at
-- call time, so revoking EXECUTE does not affect the triggers), and
-- the actor helper must not be callable as an RPC by clients. After
-- these revokes, no normal role can invoke any of them directly;
-- audit insertion stays trigger-owned and append-only.

revoke execute on function public.record_keeping_audit_actor(uuid)
  from public, anon, authenticated;
revoke execute on function public.record_keeping_audit_row()
  from public, anon, authenticated;
revoke execute on function public.record_keeping_audit_session_aftercare()
  from public, anon, authenticated;
revoke execute on function public.record_keeping_audit_probe_lot()
  from public, anon, authenticated;
