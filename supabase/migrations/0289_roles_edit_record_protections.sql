-- 0289_roles_edit_record_protections (HELD, unapplied everywhere; claimed by Team; NQ-11 / NQ-12, Sam 3 Nov 2026)
--
-- clin.edit_records stays studio-wide On/Off (NQ-11). Editing OFF must block ALL covered chart writes, including direct calls and open pages.
-- This migration builds the protections BEFORE the key is marked enforced (NQ-12); the TypeScript catalog stays `not_yet` until the DB proof
-- passes and the reviews clear.
--
-- DESIGN (a technical deviation from the wording "the write commands call has_studio_permission themselves", for a stated reason):
--   Three of the eight chart tables have NO command in front of them (treatment_plans, treatment_plan_stages, client_clinical_notes are written
--   by direct table DML through RLS), and the other five (sessions, session_blocks, session_block_areas, electrolysis_entries, laser_entries)
--   are written by about fourteen SECURITY DEFINER commands (0169 already revoked direct DML on those five). Rewriting fourteen long command
--   bodies would risk regressions in clinical writes and still leave the three direct-DML tables open. Row triggers on the TABLES are the one
--   choke point every path crosses (a command, a direct call, an old tab): they run inside the same transaction as the write, and auth.uid() is
--   unchanged inside a SECURITY DEFINER command, so the check sees the real caller. The commands are NOT rewritten.
--
-- WHAT IT ADDS
--   1. public.chart_revisions: append-only history (before/after image of every insert, update and delete on the eight chart tables, who,
--      when). Removal is a versioned edit: a soft delete is an UPDATE whose before-image is kept; the one hard delete that exists (a plan
--      stage) keeps its before-image. History starts at this migration; earlier edits are NOT reconstructed.
--   2. chart_write_guard(): BEFORE INSERT/UPDATE/DELETE on the eight tables. For an end user (auth.uid() is not null) it requires
--      has_studio_permission(studio, 'clin.edit_records', client) and refuses with SQLSTATE 42501 'edit_records_required'. System paths
--      (service role, cron, migrations: auth.uid() is null) are not end users and are not checked here. A sessions UPDATE that changes only the
--      price is exempt (pricing is a different key, not_yet).
--   3. chart_attribution_guard(): BEFORE UPDATE. sessions.practitioner_id and sessions.performed_by_practitioner_id, treatment_plans.created_by_
--      practitioner_id and client_clinical_notes.practitioner_id cannot be rewritten, except inside the performer correction command below
--      or the existing trusted finalized-record correction (0120's transaction-local hone.correction_session_id), both of which leave a record.
--   4. public.session_performer_corrections (append-only) and public.correct_session_performer(): replaces the overwrite. The original
--      attribution stays in history; the correction records who, when and why. public.set_session_performer keeps its signature and grant but may only make the FIRST
--      attribution; changing or clearing an existing performer is refused and points to the correction command.
--
-- WHAT IT DOES NOT DO: no source column is dropped; no existing command body is changed; no data is backfilled; nothing is granted to anon or
-- service_role. A row whose studio cannot be resolved (a cascade from a parent being deleted) is not checked and not logged: documented limit.
begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Append-only history
-- ---------------------------------------------------------------------------
create table public.chart_revisions (
  id            bigint generated always as identity primary key,
  studio_id     uuid not null,
  client_id     uuid,
  table_name    text not null check (table_name in ('sessions','session_blocks','session_block_areas','electrolysis_entries','laser_entries','treatment_plans','treatment_plan_stages','client_clinical_notes')),
  row_id        uuid not null,
  op            text not null check (op in ('insert','update','delete')),
  changed_by    uuid,            -- auth.uid(); null = a system path
  changed_at    timestamptz not null default now(),
  before_image  jsonb,
  after_image   jsonb
);
create index chart_revisions_row_idx on public.chart_revisions (table_name, row_id, id);
create index chart_revisions_studio_idx on public.chart_revisions (studio_id, id desc);

create or replace function public.chart_revisions_append_only()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'chart_revisions_is_append_only' using errcode = '55000';
end;
$$;
create trigger chart_revisions_no_update_delete before update or delete on public.chart_revisions
  for each row execute function public.chart_revisions_append_only();
create trigger chart_revisions_no_truncate before truncate on public.chart_revisions
  for each statement execute function public.chart_revisions_append_only();

alter table public.chart_revisions enable row level security;
revoke all on public.chart_revisions from public, anon, authenticated, service_role;
-- Reading history needs the VIEW key (not the edit key): the history is chart content.
grant select on public.chart_revisions to authenticated;
create policy chart_revisions_view on public.chart_revisions for select to authenticated
  using (public.has_studio_permission(studio_id, 'clin.view_records', client_id));

-- ---------------------------------------------------------------------------
-- 2) Scope resolution: which studio and client does a chart row belong to?
-- ---------------------------------------------------------------------------
create or replace function public.chart_scope(p_table text, p_row jsonb)
returns table (studio_id uuid, client_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_table in ('sessions', 'treatment_plans', 'client_clinical_notes') then
    return query select (p_row ->> 'studio_id')::uuid, (p_row ->> 'client_id')::uuid;
  elsif p_table = 'session_blocks' then
    return query select s.studio_id, s.client_id from public.sessions s where s.id = (p_row ->> 'session_id')::uuid;
  elsif p_table = 'session_block_areas' then
    return query select s.studio_id, s.client_id from public.session_blocks b join public.sessions s on s.id = b.session_id
                  where b.id = (p_row ->> 'session_block_id')::uuid;
  elsif p_table in ('electrolysis_entries', 'laser_entries') then
    return query select s.studio_id, s.client_id from public.sessions s where s.id = (p_row ->> 'session_id')::uuid;
  elsif p_table = 'treatment_plan_stages' then
    return query select (p_row ->> 'studio_id')::uuid, p.client_id from public.treatment_plans p where p.id = (p_row ->> 'plan_id')::uuid;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) The edit-key guard (BEFORE) and the history writer (AFTER)
-- ---------------------------------------------------------------------------
create or replace function public.chart_write_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_studio uuid;
  v_client uuid;
begin
  if auth.uid() is not null then
    -- Pricing is its own key (not_yet): a sessions UPDATE that changes only the price is not a chart edit.
    if tg_table_name = 'sessions' and tg_op = 'UPDATE'
       and (to_jsonb(new) - 'price_paid_cents') = (to_jsonb(old) - 'price_paid_cents') then
      return new;
    end if;
    -- An update or delete is authorised against the row AS IT STANDS (a move into another studio is refused by the lineage triggers).
    v_row := case when tg_op = 'INSERT' then to_jsonb(new) else to_jsonb(old) end;
    select c.studio_id, c.client_id into v_studio, v_client from public.chart_scope(tg_table_name, v_row) c;
    if v_studio is not null and not public.has_studio_permission(v_studio, 'clin.edit_records', v_client) then
      raise exception 'edit_records_required' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.chart_revision_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_after  jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_studio uuid;
  v_client uuid;
begin
  if tg_op = 'UPDATE' and v_before = v_after then return null; end if;
  select c.studio_id, c.client_id into v_studio, v_client from public.chart_scope(tg_table_name, coalesce(v_after, v_before)) c;
  if v_studio is null then return null; end if;   -- a cascade whose parent is already gone: documented limit
  insert into public.chart_revisions (studio_id, client_id, table_name, row_id, op, changed_by, before_image, after_image)
  values (v_studio, v_client, tg_table_name, coalesce((v_after ->> 'id')::uuid, (v_before ->> 'id')::uuid), lower(tg_op), auth.uid(), v_before, v_after);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Attribution is never rewritten (outside the recorded correction paths)
-- ---------------------------------------------------------------------------
create or replace function public.chart_attribution_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_changed boolean := false;
begin
  if tg_table_name = 'sessions' then
    -- FIRST attribution (performed_by NULL -> a practitioner) is not a rewrite; every later change is.
    v_changed := new.practitioner_id is distinct from old.practitioner_id
              or (new.performed_by_practitioner_id is distinct from old.performed_by_practitioner_id
                  and old.performed_by_practitioner_id is not null);
    if v_changed
       and coalesce(current_setting('hone.performer_correction', true), '') <> old.id::text
       and coalesce(current_setting('hone.correction_session_id', true), '') <> old.id::text then
      raise exception 'attribution_is_not_rewritable' using errcode = '55000';
    end if;
  elsif tg_table_name = 'treatment_plans' then
    -- ON DELETE SET NULL (a practitioner row removed) is the one allowed change: it erases nothing but the link.
    if new.created_by_practitioner_id is distinct from old.created_by_practitioner_id and new.created_by_practitioner_id is not null then
      raise exception 'attribution_is_not_rewritable' using errcode = '55000';
    end if;
  elsif tg_table_name = 'client_clinical_notes' then
    if new.practitioner_id is distinct from old.practitioner_id then
      raise exception 'attribution_is_not_rewritable' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['sessions','session_blocks','session_block_areas','electrolysis_entries','laser_entries','treatment_plans','treatment_plan_stages','client_clinical_notes']
  loop
    execute format('create trigger chart_write_guard_trg before insert or update or delete on public.%I for each row execute function public.chart_write_guard()', t);
    execute format('create trigger chart_revision_write_trg after insert or update or delete on public.%I for each row execute function public.chart_revision_write()', t);
  end loop;
end $$;
create trigger chart_attribution_guard_sessions before update on public.sessions for each row execute function public.chart_attribution_guard();
create trigger chart_attribution_guard_plans before update on public.treatment_plans for each row execute function public.chart_attribution_guard();
create trigger chart_attribution_guard_notes before update on public.client_clinical_notes for each row execute function public.chart_attribution_guard();

-- ---------------------------------------------------------------------------
-- 5) Performer CORRECTION (replaces the overwrite). Original attribution stays in chart_revisions; each correction records who, when, why.
-- ---------------------------------------------------------------------------
create table public.session_performer_corrections (
  id                    bigint generated always as identity primary key,
  studio_id             uuid not null,
  session_id            uuid not null references public.sessions(id) on delete restrict,
  previous_performer_id uuid,
  new_performer_id      uuid,
  corrected_by          uuid not null,     -- auth.uid()
  corrected_at          timestamptz not null default now(),
  reason                text not null
);
create index session_performer_corrections_session_idx on public.session_performer_corrections (session_id, id);
create trigger session_performer_corrections_no_update_delete before update or delete on public.session_performer_corrections
  for each row execute function public.chart_revisions_append_only();
create trigger session_performer_corrections_no_truncate before truncate on public.session_performer_corrections
  for each statement execute function public.chart_revisions_append_only();
alter table public.session_performer_corrections enable row level security;
revoke all on public.session_performer_corrections from public, anon, authenticated, service_role;
grant select on public.session_performer_corrections to authenticated;
create policy session_performer_corrections_view on public.session_performer_corrections for select to authenticated
  using (public.has_studio_permission(studio_id, 'clin.view_records', (select s.client_id from public.sessions s where s.id = session_id)));

create or replace function public.correct_session_performer(
  p_session_id uuid, p_client_id uuid, p_performer_id uuid, p_reason text
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_studio uuid;
  v_prev uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.uid() is null then raise exception 'not_signed_in' using errcode = '42501'; end if;
  if v_reason = '' or lower(v_reason) in ('n/a', 'na', 'none', 'no', '-', '.', 'x') then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  v_studio := public.assert_session_writable(p_session_id, p_client_id);
  if not public.has_studio_permission(v_studio, 'clin.edit_records', p_client_id) then
    raise exception 'edit_records_required' using errcode = '42501';
  end if;
  if p_performer_id is not null then
    perform 1 from public.practitioners p where p.id = p_performer_id and p.studio_id = v_studio and p.active;
    if not found then raise exception 'performer_not_in_studio' using errcode = 'check_violation'; end if;
  end if;
  select s.performed_by_practitioner_id into v_prev from public.sessions s where s.id = p_session_id and s.studio_id = v_studio for update;
  if v_prev is not distinct from p_performer_id then return false; end if;
  perform set_config('hone.performer_correction', p_session_id::text, true);
  update public.sessions set performed_by_practitioner_id = p_performer_id where id = p_session_id and studio_id = v_studio;
  perform set_config('hone.performer_correction', '', true);
  insert into public.session_performer_corrections (studio_id, session_id, previous_performer_id, new_performer_id, corrected_by, reason)
  values (v_studio, p_session_id, v_prev, p_performer_id, auth.uid(), v_reason);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Grants. Supabase's default privileges grant EXECUTE to anon, authenticated AND service_role at create time: revoke all three by name,
--    then grant only what is meant to be called.
-- ---------------------------------------------------------------------------
revoke all on function public.chart_revisions_append_only() from public, anon, authenticated, service_role;
revoke all on function public.chart_scope(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.chart_write_guard() from public, anon, authenticated, service_role;
revoke all on function public.chart_revision_write() from public, anon, authenticated, service_role;
revoke all on function public.chart_attribution_guard() from public, anon, authenticated, service_role;
revoke all on function public.correct_session_performer(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke execute on function public.correct_session_performer(uuid, uuid, uuid, text) from public;
revoke execute on function public.correct_session_performer(uuid, uuid, uuid, text) from anon;
revoke execute on function public.correct_session_performer(uuid, uuid, uuid, text) from service_role;
revoke execute on function public.correct_session_performer(uuid, uuid, uuid, text) from authenticated;
grant execute on function public.correct_session_performer(uuid, uuid, uuid, text) to authenticated;
-- The 0167 overwrite command keeps its signature and its authenticated-only grant (applied contract; its ACL tests stay true). Its body now
-- allows only the FIRST attribution of a session; changing or clearing an existing performer is a CORRECTION and goes through
-- correct_session_performer, which keeps the original and records who, when and why. The authorisation and refusal shapes are unchanged.
create or replace function public.set_session_performer(
  p_session_id   uuid,
  p_client_id    uuid,
  p_performer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_prev uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_performer_id is not null then
    perform 1 from public.practitioners p
      where p.id = p_performer_id and p.studio_id = v_studio_id;
    if not found then
      raise exception 'Practitioner not found in this studio.' using errcode = 'check_violation';
    end if;
  end if;

  select s.performed_by_practitioner_id into v_prev from public.sessions s where s.id = p_session_id and s.studio_id = v_studio_id;
  if v_prev is not distinct from p_performer_id then return; end if;
  if v_prev is not null then
    raise exception 'Use correct_session_performer to change an existing performer.' using errcode = 'check_violation';
  end if;

  update public.sessions s
     set performed_by_practitioner_id = p_performer_id
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from public;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from anon;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from service_role;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from authenticated;
grant execute on function public.set_session_performer(uuid, uuid, uuid) to authenticated;

commit;
