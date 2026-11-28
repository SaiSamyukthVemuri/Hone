-- ===========================================================================
-- CLIENT NOTE DRAFTS — 0399 (HON-130)
-- ===========================================================================
--
-- WHY A SEPARATE TABLE. Consultation and skin/hair notes are APPEND-ONLY rows in
-- client_clinical_notes (a revision inserts a NEW row; one revision per note). Autosaving
-- into that table would write a permanent clinical history row per pause. A DRAFT is
-- therefore a transient, author-private row that only ever holds text on its way to the
-- real record. The clinical record, its append-only rules, its finalization rules and its
-- RLS are not touched by this migration. Budget context is one overwrite row per client;
-- its draft lives here too and the real row is still written only by its own action.
--
-- OWNER KEY. One draft per (practitioner_id, client_id, kind, target):
--   kind    consultation | skin_hair_analysis | budget
--   target  'new' (a note not yet saved), the id of the note being revised, or 'current'
--           (budget). studio_id is derived from the client by trigger, never trusted.
--
-- ORDERING. `revision` is a compare-and-set counter. save_client_note_draft() updates only
-- WHERE revision = the caller's expected revision, so an older save can never overwrite
-- newer text; a mismatch returns the stored draft instead of writing.
--
-- RETENTION AND VISIBILITY ARE ONE-LINE CHANGES (undecided, see HON-130):
--   * retention:  public.client_note_draft_retention()  (Sam, 28 Nov 2026: 14 days from the last edit)
--   * visibility: the three policies below are AUTHOR-ONLY (practitioner row whose user is
--     the caller). Widening to the studio means changing the `using` of the select policy.
-- Expired drafts are invisible to reads at once and removed by the author's next save.
--
-- WRITES ONLY THROUGH DEFINER COMMANDS (save_/discard_client_note_draft), each with a pinned
-- search_path, taking studio and practitioner from the SESSION. authenticated holds SELECT
-- only (author-only RLS). service_role holds no table privilege: its ONLY entry is
-- sweep_client_note_drafts() (retention), which returns a count and never returns text.
-- ONE TRANSACTION (Sam, 28 Nov 2026): saving the real note or budget row CLEARS the matching draft in the same transaction,
-- by an AFTER INSERT (notes) / AFTER INSERT OR UPDATE (budget) trigger. The application's add/revise/budget commands, their
-- INSERT/UPSERT, the existing triggers, attribution, the one-revision index and the verified read-back are byte-for-byte unchanged.
-- If the clear raises, the whole save rolls back and the person's text stays in the editor. "Clear" sets fields to NULL, bumps the
-- revision and marks the row cleared, so no draft text survives even if the row does, and a late in-flight autosave cannot
-- resurrect it (its compare-and-set fails).
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.client_note_draft_retention()
returns interval
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select interval '14 days' $$;

-- A redundant unique key on the clinical notes table so a draft's revise-target can be a COMPOSITE FOREIGN KEY pinned to the same
-- client, studio and kind. `id` is already the primary key, so this index can never conflict with existing data and changes no behaviour.
create unique index if not exists client_clinical_notes_id_client_studio_kind_key
  on public.client_clinical_notes (id, client_id, studio_id, kind);

-- DATABASE-SIDE SWITCH. Autosave is OFF unless a studio is listed here, so "off" means off even for a user calling the save
-- command directly with their own token. Empty by default in every environment. Writable only by service_role (or the migration
-- owner); authenticated holds NO privilege on it, and the save command (definer) is the only reader besides service_role.
create table if not exists public.client_note_draft_enabled_studios (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  enabled_at timestamptz not null default now()
);
alter table public.client_note_draft_enabled_studios enable row level security;

create table if not exists public.client_note_drafts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null,
  practitioner_id uuid not null,
  kind text not null,
  target text not null default 'new',
  -- Set exactly when target is a note id; the composite FK below pins it to the same client, studio and kind.
  target_note_id uuid,
  -- The draft's field values: {"body": "...", "areas": [...]} for notes,
  -- {"budget_level": "...", "budget_notes": "..."} for budget. Bounded below.
  -- NULL only on a CLEARED row (the real record was saved): no draft text survives a clear.
  fields jsonb default '{}'::jsonb,
  revision integer not null default 1,
  -- Per-tab writer token: a retry of a write whose response was lost (same writer, same fields) is an acknowledged success, not a conflict.
  writer uuid,
  -- Set when the real record was saved: the draft's text is emptied, revision bumped, and every stale write fails. Swept later.
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + public.client_note_draft_retention()),
  constraint client_note_drafts_client_studio_fkey
    foreign key (client_id, studio_id) references public.clients (id, studio_id) on delete cascade,
  constraint client_note_drafts_practitioner_studio_fkey
    foreign key (practitioner_id, studio_id) references public.practitioners (id, studio_id) on delete cascade,
  constraint client_note_drafts_target_note_fkey
    foreign key (target_note_id, client_id, studio_id, kind)
    references public.client_clinical_notes (id, client_id, studio_id, kind) on delete cascade,
  constraint client_note_drafts_target_note_check
    check (
      (target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') = (target_note_id is not null)
      and (target_note_id is null or target = target_note_id::text)
    ),
  constraint client_note_drafts_kind_check
    check (kind in ('consultation', 'skin_hair_analysis', 'budget')),
  constraint client_note_drafts_target_check
    check (
      (kind = 'budget' and target = 'current')
      or (kind <> 'budget' and (target = 'new' or target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    ),
  constraint client_note_drafts_fields_object_check check (jsonb_typeof(fields) = 'object'),
  constraint client_note_drafts_fields_size_check check (length(fields::text) <= 60000),
  -- The final note's own ceilings: body 20000 characters (MAX_BODY_LENGTH), at most 40 areas, budget notes 20000.
  constraint client_note_drafts_text_caps_check check (
    coalesce(length(fields->>'body'), 0) <= 20000
    and coalesce(length(fields->>'budget_notes'), 0) <= 20000
    and (jsonb_typeof(fields->'areas') is distinct from 'array' or jsonb_array_length(fields->'areas') <= 40)
  ),
  -- Only the keys the editor itself sends: a note draft holds body/areas/occurred_at, a budget draft budget_level/budget_notes. Nothing else can be stored.
  constraint client_note_drafts_field_keys_check check (
    fields is null
    or case when kind = 'budget'
         then (fields - array['budget_level', 'budget_notes']) = '{}'::jsonb
         else (fields - array['body', 'areas', 'occurred_at']) = '{}'::jsonb
       end
  ),
  -- Value shapes behind those keys: budget_level at most 40 characters, every area at most 200 (the sanitiser's own caps).
  constraint client_note_drafts_value_caps_check check (
    coalesce(length(fields->>'budget_level'), 0) <= 40
    and coalesce(length(fields->>'occurred_at'), 0) <= 40
    and (jsonb_typeof(fields->'areas') is distinct from 'array'
         or not jsonb_path_exists(fields, '$.areas[*] ? (@.type() != "string" || @ like_regex "^.{201}")'))
  ),
  constraint client_note_drafts_revision_check check (revision >= 1),
  constraint client_note_drafts_null_only_when_cleared_check check (fields is not null or cleared_at is not null),
  constraint client_note_drafts_owner_key unique (practitioner_id, client_id, kind, target)
);

create index if not exists client_note_drafts_studio_idx on public.client_note_drafts (studio_id);
create index if not exists client_note_drafts_expiry_idx on public.client_note_drafts (expires_at);
-- The sweep's two predicates (14 days from the last edit; cleared rows after a day) each get an index, so the nightly pass never scans the table.
create index if not exists client_note_drafts_updated_idx on public.client_note_drafts (updated_at);
create index if not exists client_note_drafts_cleared_idx on public.client_note_drafts (cleared_at) where cleared_at is not null;

-- Studio comes from the client, never from the caller (dual-membership practitioners satisfy
-- is_studio_member for two studios, so an RLS predicate alone cannot stop a wrong-studio row).
create or replace function public.client_note_drafts_set_studio_id()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  select studio_id into new.studio_id from public.clients where id = new.client_id;
  if new.studio_id is null then
    raise exception 'client_note_drafts.client_id % does not reference an existing clients row', new.client_id;
  end if;
  return new;
end;
$$;

drop trigger if exists client_note_drafts_set_studio_id on public.client_note_drafts;
create trigger client_note_drafts_set_studio_id
  before insert or update on public.client_note_drafts
  for each row execute function public.client_note_drafts_set_studio_id();

-- Timestamps and expiry are database-controlled; the key and creation time never change.
create or replace function public.client_note_drafts_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.expires_at := now() + public.client_note_draft_retention();
    new.revision := 1;
    return new;
  end if;
  if new.client_id is distinct from old.client_id
     or new.practitioner_id is distinct from old.practitioner_id
     or new.kind is distinct from old.kind
     or new.target is distinct from old.target
     or new.created_at is distinct from old.created_at then
    raise exception 'client_note_drafts key and created_at are immutable' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  new.expires_at := now() + public.client_note_draft_retention();
  return new;
end;
$$;

drop trigger if exists client_note_drafts_guard on public.client_note_drafts;
create trigger client_note_drafts_guard
  before insert or update on public.client_note_drafts
  for each row execute function public.client_note_drafts_guard();

-- Per-practitioner cap on live drafts (INSERT only: a clear or an update never counts against it).
create or replace function public.client_note_drafts_cap()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if (select count(*) from public.client_note_drafts d where d.practitioner_id = new.practitioner_id and d.cleared_at is null) >= 200 then
    raise exception 'too many drafts for this practitioner' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists client_note_drafts_cap on public.client_note_drafts;
create trigger client_note_drafts_cap
  before insert on public.client_note_drafts
  for each row execute function public.client_note_drafts_cap();

alter table public.client_note_drafts enable row level security;

-- AUTHOR-ONLY READS: studio membership AND the caller's own active practitioner row.
-- There is deliberately NO insert/update/delete policy: writes go through the commands below.
drop policy if exists "client_note_drafts_author_select" on public.client_note_drafts;
create policy "client_note_drafts_author_select"
  on public.client_note_drafts for select to authenticated
  using (
    client_note_drafts.expires_at > now()
    and client_note_drafts.cleared_at is null
    and public.is_studio_member(client_note_drafts.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_note_drafts.practitioner_id
        and p.studio_id = client_note_drafts.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

-- COMPARE-AND-SET WRITE (SECURITY DEFINER, pinned search_path). It re-proves everything RLS would:
-- studio membership, the caller's own active practitioner row, and that the client is in the studio.
--   status ok        written; revision is the new one
--   status conflict  stored revision differs from p_expected_revision; fields = the CALLER'S OWN stored draft
--   status gone      p_expected_revision > 0 but no draft exists
--   status cleared   the real record was saved (draft cleared) or the revised note already has its revision: stop writing
--   status disabled  the studio is not in client_note_draft_enabled_studios (autosave is off); nothing is stored
--   status refused   not an active practitioner of this studio, or the client is not in it
-- The row looked up is always the caller's own (the key includes practitioner_id), so a conflict can never return
-- another author's text.
create or replace function public.save_client_note_draft(
  p_studio_id uuid,
  p_client_id uuid,
  p_kind text,
  p_target text,
  p_fields jsonb,
  p_expected_revision integer,
  p_writer uuid
)
returns table (status text, revision integer, fields jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner uuid;
  v_row public.client_note_drafts%rowtype;
begin
  if (select auth.uid()) is null then
    return query select 'refused'::text, 0, '{}'::jsonb, null::timestamptz;
    return;
  end if;
  select p.id into v_practitioner
  from public.practitioners p
  where p.studio_id = p_studio_id and p.user_id = (select auth.uid()) and p.active
    and public.is_studio_member(p_studio_id);
  if v_practitioner is null
     or not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    return query select 'refused'::text, 0, '{}'::jsonb, null::timestamptz;
    return;
  end if;
  -- The switch comes AFTER the membership check, so a non-member always gets 'refused' and never learns whether a studio has drafts on.
  -- Nothing is stored for a studio that is not enabled. Closed code, no side effect.
  if not exists (select 1 from public.client_note_draft_enabled_studios e where e.studio_id = p_studio_id) then
    return query select 'disabled'::text, 0, '{}'::jsonb, null::timestamptz;
    return;
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'invalid expected revision' using errcode = 'invalid_parameter_value';
  end if;

  -- A revise target that already has its revision can no longer be drafted against.
  if p_kind <> 'budget' and p_target <> 'new'
     and exists (select 1 from public.client_clinical_notes n where n.supersedes_note_id = p_target::uuid) then
    return query select 'cleared'::text, 0, '{}'::jsonb, null::timestamptz;
    return;
  end if;

  -- An expired draft of this key is removed first so it never blocks (or resurrects into) a new one.
  delete from public.client_note_drafts d
  where d.practitioner_id = v_practitioner and d.client_id = p_client_id
    and d.kind = p_kind and d.target = p_target and d.expires_at <= now();

  if p_expected_revision = 0 then
    begin
      insert into public.client_note_drafts as d (client_id, practitioner_id, studio_id, kind, target, target_note_id, fields, writer)
      values (p_client_id, v_practitioner, p_studio_id, p_kind, p_target,
              case when p_target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_target::uuid end, p_fields, p_writer)
      returning * into v_row;
      return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at;
      return;
    exception when unique_violation then
      null; -- a racing first save: fall through to the conflict / reuse path below
    end;
    -- A CLEARED row of this key (record saved earlier) is reused for a genuinely new draft.
    update public.client_note_drafts d
       set fields = p_fields, revision = d.revision + 1, writer = p_writer, cleared_at = null
     where d.practitioner_id = v_practitioner and d.client_id = p_client_id
       and d.kind = p_kind and d.target = p_target and d.cleared_at is not null
    returning d.* into v_row;
    if found then
      return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at;
      return;
    end if;
  else
    update public.client_note_drafts d
       set fields = p_fields, revision = d.revision + 1, writer = p_writer
     where d.practitioner_id = v_practitioner and d.client_id = p_client_id
       and d.kind = p_kind and d.target = p_target and d.revision = p_expected_revision
       and d.cleared_at is null
    returning d.* into v_row;
    if found then
      return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at;
      return;
    end if;
  end if;

  select d.* into v_row from public.client_note_drafts d
  where d.practitioner_id = v_practitioner and d.client_id = p_client_id
    and d.kind = p_kind and d.target = p_target;
  if not found then
    return query select 'gone'::text, 0, '{}'::jsonb, null::timestamptz;
  elsif v_row.cleared_at is not null and p_expected_revision > 0 then
    return query select 'cleared'::text, v_row.revision, '{}'::jsonb, null::timestamptz;
  elsif v_row.writer is not null and v_row.writer = p_writer and v_row.fields = p_fields then
    -- A retry of a write that already applied (its response was lost): acknowledged success, not a conflict.
    return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at;
  elsif v_row.cleared_at is not null then
    return query select 'gone'::text, 0, '{}'::jsonb, null::timestamptz;
  else
    return query select 'conflict'::text, v_row.revision, v_row.fields, v_row.updated_at;
  end if;
end;
$$;

-- Discard: the caller's own draft only.
create or replace function public.discard_client_note_draft(
  p_studio_id uuid,
  p_client_id uuid,
  p_kind text,
  p_target text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner uuid;
  v_n integer;
begin
  select p.id into v_practitioner
  from public.practitioners p
  where p.studio_id = p_studio_id and p.user_id = (select auth.uid()) and p.active
    and public.is_studio_member(p_studio_id);
  if v_practitioner is null then
    return false;
  end if;
  delete from public.client_note_drafts d
  where d.practitioner_id = v_practitioner and d.client_id = p_client_id
    and d.studio_id = p_studio_id and d.kind = p_kind and d.target = p_target;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- WORST CASE, stated plainly: the save and the clear are one transaction, so no saved text is orphaned; an ABANDONED draft survives until 14 days after its last edit.
-- RETENTION SWEEP. Owner: service_role only, called by the scheduled route /api/cron/sweep-note-drafts (CRON_SECRET). Deletes by updated_at against
-- the retention value; returns a COUNT only. Never reads or returns draft text; never touches clinical or budget tables.
create or replace function public.sweep_client_note_drafts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  -- Small batches that SKIP LOCKED rows, so the sweep never waits on (or deadlocks with) an autosave or a Save.
  loop
    delete from public.client_note_drafts d
    where d.id in (
      select x.id from public.client_note_drafts x
      where x.updated_at < now() - public.client_note_draft_retention()
         or (x.cleared_at is not null and x.cleared_at < now() - interval '1 day')
      order by x.id
      limit 200
      for update skip locked
    );
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
    exit when v_n = 0 or v_total >= 20000;
  end loop;
  return v_total;
end;
$$;

-- SAME-TRANSACTION CLEAR (Sam: one transaction; Insurance C1/C2/C5).
-- Keyed ONLY from NEW (never auth.uid()): the saved row's author, client, kind and revise target. SECURITY DEFINER with an EMPTY
-- search_path and every object schema-qualified; EXECUTE revoked by name below. It clears at most one row by the unique key and
-- returns NEW untouched. It must never fail for data reasons: it changes no key column, and no CHECK, cap or BEFORE UPDATE on drafts
-- rejects a clear (cap and target checks are INSERT-only; the guard allows key-preserving updates). Any unexpected failure is raised
-- under the DISTINCT SQLSTATE 'HN130' (never 23505, which the revise path maps to stale_revision), so it surfaces as a generic failure.
create or replace function public.client_note_drafts_clear_on_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.client_note_drafts d
     set fields = null, revision = d.revision + 1, cleared_at = pg_catalog.now(), writer = null
   where d.practitioner_id = new.practitioner_id and d.client_id = new.client_id and d.kind = new.kind
     and d.target = coalesce(new.supersedes_note_id::text, 'new') and d.cleared_at is null;
  return new;
exception when others then
  raise exception 'note draft could not be cleared' using errcode = 'HN130';
end;
$$;

drop trigger if exists client_note_drafts_clear_on_note on public.client_clinical_notes;
create trigger client_note_drafts_clear_on_note
  after insert on public.client_clinical_notes
  for each row execute function public.client_note_drafts_clear_on_note();

-- Budget: keyed on NEW.updated_by_practitioner_id plus the client; kind 'budget', target 'current' only.
create or replace function public.client_note_drafts_clear_on_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.client_note_drafts d
     set fields = null, revision = d.revision + 1, cleared_at = pg_catalog.now(), writer = null
   where d.practitioner_id = new.updated_by_practitioner_id and d.client_id = new.client_id
     and d.kind = 'budget' and d.target = 'current' and d.cleared_at is null;
  return new;
exception when others then
  raise exception 'note draft could not be cleared' using errcode = 'HN130';
end;
$$;

drop trigger if exists client_note_drafts_clear_on_budget on public.client_budget_context;
create trigger client_note_drafts_clear_on_budget
  after insert or update on public.client_budget_context
  for each row execute function public.client_note_drafts_clear_on_budget();

-- PRIVILEGES: revoke everything by name (public, anon, authenticated, service_role), then grant exactly what is intended.
revoke all on public.client_note_draft_enabled_studios from public, anon, authenticated, service_role;
grant select, insert, delete on public.client_note_draft_enabled_studios to service_role;
revoke all on public.client_note_drafts from public, anon, authenticated, service_role;
grant select on public.client_note_drafts to authenticated;

revoke all privileges on function public.client_note_drafts_set_studio_id() from public, anon, authenticated, service_role;
revoke all privileges on function public.client_note_drafts_guard() from public, anon, authenticated, service_role;
revoke all privileges on function public.client_note_drafts_cap() from public, anon, authenticated, service_role;
revoke all privileges on function public.client_note_drafts_clear_on_note() from public, anon, authenticated, service_role;
revoke all privileges on function public.client_note_drafts_clear_on_budget() from public, anon, authenticated, service_role;
revoke all privileges on function public.client_note_draft_retention() from public, anon, service_role;
-- RLS and column defaults evaluate this as the CALLER, so authenticated needs EXECUTE (it returns a constant).
grant execute on function public.client_note_draft_retention() to authenticated;
revoke all privileges on function public.save_client_note_draft(uuid, uuid, text, text, jsonb, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_client_note_draft(uuid, uuid, text, text, jsonb, integer, uuid) to authenticated;
revoke all privileges on function public.discard_client_note_draft(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_client_note_draft(uuid, uuid, text, text) to authenticated;
revoke all privileges on function public.sweep_client_note_drafts()
  from public, anon, authenticated, service_role;
grant execute on function public.sweep_client_note_drafts() to service_role;

commit;
