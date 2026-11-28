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
-- by an AFTER INSERT (notes) / AFTER INSERT OR UPDATE (budget) trigger. The application now saves through two SECURITY INVOKER wrappers
-- (add_client_clinical_note, upsert_client_budget_context) that run the SAME insert / upsert with the caller's own rights and hand the draft
-- generation to the triggers in a transaction-local setting. The tables, their existing triggers, attribution, RLS, the one-revision index and
-- the application's verified read-back are unchanged; the wrappers add no privilege.
-- If the clear raises, the whole save rolls back and the person's text stays in the editor. "Clear" sets fields to NULL, bumps the
-- revision and marks the row cleared, so no draft text survives even if the row does, and a late in-flight autosave cannot
-- resurrect it (its compare-and-set fails). A Save whose draft lifecycle already ended is refused with SQLSTATE HN131 (see the notes trigger).
-- ROLLBACK ORDER: the down file leaves the two wrappers in place (they hold no data and work without the triggers), so a database rollback
-- while the new application is live cannot stop note or budget saves. Roll the APPLICATION back first, then the down file; emergency only.
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
  -- DRAFT IDENTITY (HON-130 design, Privacy YES / Insurance final1701). `generation` is the client-minted uuid of ONE draft lifecycle and is set
  -- exactly while the row is LIVE. When a lifecycle ends (Save or Discard) the row becomes a TOMBSTONE: text NULL, revision bumped, generation
  -- NULL and `ended_generation` = the lifecycle that ended. The row is never deleted by Save or Discard (only by the sweep), so a revision number
  -- is never reused and a stale tab or a late first autosave can never touch a newer draft.
  generation uuid,
  ended_generation uuid,
  -- Set when the real record was saved or the draft was discarded: the draft's text is emptied, revision bumped, and every stale write fails. Swept later.
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
  -- A tombstone holds NO text, whatever wrote it.
  constraint client_note_drafts_tombstone_text_free_check check (cleared_at is null or fields is null),
  -- Exactly one identity per state: a live row has a generation and no ended one; a tombstone has no live generation.
  constraint client_note_drafts_state_check check (
    (cleared_at is null and generation is not null and ended_generation is null)
    or (cleared_at is not null and generation is null)
  ),
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
  -- A TOMBSTONE insert (cleared_at set, written by the clear triggers inside a record's own save) is never capped: the clear must not fail.
  if new.cleared_at is null
     and (select count(*) from public.client_note_drafts d where d.practitioner_id = new.practitioner_id and d.cleared_at is null) >= 200 then
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
--   status conflict  the stored draft is live but differs (another revision, or ANOTHER lifecycle's generation); fields/generation = the CALLER'S OWN stored draft
--   status gone      p_expected_revision > 0 but no draft exists
--   status cleared   this lifecycle is over (the record was saved or the draft discarded), or the revised note already has its revision: stop writing. NEVER carries text.
--   status disabled  the studio is not in client_note_draft_enabled_studios (autosave is off); nothing is stored
--   status refused   not an active practitioner of this studio, or the client is not in it
-- The row looked up is always the caller's own (the key includes practitioner_id), so a result can never carry another author's text.
-- DECISION TABLE (generation G = p_generation). Every branch is ONE conditional statement, so a lock wait re-evaluates it on the committed row:
--   no row, expected 0                      insert live (G)                                  ok
--   live (G), expected = revision           update, revision + 1                              ok
--   live (G), same writer and same fields   a retry whose response was lost                   ok
--   live (other generation), anything       never touched                                     conflict
--   tombstone ended_generation = G          that lifecycle is over                            cleared
--   tombstone, other/NULL ended, expected 0 a genuinely new lifecycle: revive (G), rev + 1    ok
--   tombstone, expected > 0                 a stale writer                                    cleared
create or replace function public.save_client_note_draft(
  p_studio_id uuid,
  p_client_id uuid,
  p_kind text,
  p_target text,
  p_fields jsonb,
  p_expected_revision integer,
  p_writer uuid,
  p_generation uuid
)
returns table (status text, revision integer, fields jsonb, updated_at timestamptz, generation uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner uuid;
  v_row public.client_note_drafts%rowtype;
  v_try integer := 0;
begin
  if (select auth.uid()) is null then
    return query select 'refused'::text, 0, '{}'::jsonb, null::timestamptz, null::uuid;
    return;
  end if;
  select p.id into v_practitioner
  from public.practitioners p
  where p.studio_id = p_studio_id and p.user_id = (select auth.uid()) and p.active
    and public.is_studio_member(p_studio_id);
  if v_practitioner is null
     or not exists (select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id) then
    return query select 'refused'::text, 0, '{}'::jsonb, null::timestamptz, null::uuid;
    return;
  end if;
  -- The switch comes AFTER the membership check, so a non-member always gets 'refused' and never learns whether a studio has drafts on.
  -- Nothing is stored for a studio that is not enabled. Closed code, no side effect.
  if not exists (select 1 from public.client_note_draft_enabled_studios e where e.studio_id = p_studio_id) then
    return query select 'disabled'::text, 0, '{}'::jsonb, null::timestamptz, null::uuid;
    return;
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_generation is null then
    raise exception 'invalid draft write' using errcode = 'invalid_parameter_value';
  end if;

  -- A revise target that already has its revision can no longer be drafted against. Returns NO text and touches no row.
  if p_kind <> 'budget' and p_target <> 'new'
     and exists (select 1 from public.client_clinical_notes n where n.supersedes_note_id = p_target::uuid) then
    return query select 'cleared'::text, 0, '{}'::jsonb, null::timestamptz, null::uuid;
    return;
  end if;

  -- An expired row of this key is removed first so it never blocks a new draft. A stale tab that still holds the old row's revision is
  -- stopped by its generation, never by the revision, so reusing a revision number here cannot let it overwrite.
  delete from public.client_note_drafts d
  where d.practitioner_id = v_practitioner and d.client_id = p_client_id
    and d.kind = p_kind and d.target = p_target and d.expires_at <= pg_catalog.now();

  loop
    v_try := v_try + 1;
    if p_expected_revision = 0 then
      insert into public.client_note_drafts as d (client_id, practitioner_id, studio_id, kind, target, target_note_id, fields, writer, generation)
      values (p_client_id, v_practitioner, p_studio_id, p_kind, p_target,
              case when p_target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_target::uuid end,
              p_fields, p_writer, p_generation)
      on conflict (practitioner_id, client_id, kind, target) do nothing
      returning * into v_row;
      if found then
        return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at, v_row.generation;
        return;
      end if;
      -- A row exists. A tombstone of ANOTHER lifecycle is a genuinely new draft: revive it (revision continues, never repeats). A revival is a
      -- NEW live draft, so it counts against the 200 live-draft cap exactly as an insert does. (Only a draft write can hit this: a clinical
      -- Save only ever turns a row into a tombstone, which is exempt, so a Save never fails on the cap.)
      if exists (select 1 from public.client_note_drafts d
                 where d.practitioner_id = v_practitioner and d.client_id = p_client_id and d.kind = p_kind and d.target = p_target
                   and d.cleared_at is not null and d.ended_generation is distinct from p_generation)
         and (select count(*) from public.client_note_drafts d where d.practitioner_id = v_practitioner and d.cleared_at is null) >= 200 then
        raise exception 'too many drafts for this practitioner' using errcode = 'check_violation';
      end if;
      update public.client_note_drafts d
         set fields = p_fields, revision = d.revision + 1, writer = p_writer, generation = p_generation,
             ended_generation = null, cleared_at = null
       where d.practitioner_id = v_practitioner and d.client_id = p_client_id and d.kind = p_kind and d.target = p_target
         and d.cleared_at is not null and d.ended_generation is distinct from p_generation
      returning d.* into v_row;
      if found then
        return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at, v_row.generation;
        return;
      end if;
    else
      update public.client_note_drafts d
         set fields = p_fields, revision = d.revision + 1, writer = p_writer
       where d.practitioner_id = v_practitioner and d.client_id = p_client_id and d.kind = p_kind and d.target = p_target
         and d.cleared_at is null and d.generation = p_generation and d.revision = p_expected_revision
      returning d.* into v_row;
      if found then
        return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at, v_row.generation;
        return;
      end if;
    end if;

    select d.* into v_row from public.client_note_drafts d
    where d.practitioner_id = v_practitioner and d.client_id = p_client_id and d.kind = p_kind and d.target = p_target;
    if not found then
      -- Expected 0 and the row vanished between the statements (a sweep): try the insert again. Expected > 0: it is gone.
      if p_expected_revision > 0 or v_try >= 3 then
        return query select 'gone'::text, 0, '{}'::jsonb, null::timestamptz, null::uuid;
        return;
      end if;
    elsif v_row.cleared_at is not null then
      -- This lifecycle ended (ended_generation = p_generation), or a stale writer believed a draft was live. Terminal, no text.
      return query select 'cleared'::text, v_row.revision, '{}'::jsonb, null::timestamptz, null::uuid;
      return;
    elsif v_row.generation = p_generation and v_row.writer is not null and v_row.writer = p_writer and v_row.fields = p_fields then
      -- A retry of a write that already applied (its response was lost): acknowledged success, not a conflict.
      return query select 'ok'::text, v_row.revision, v_row.fields, v_row.updated_at, v_row.generation;
      return;
    else
      return query select 'conflict'::text, v_row.revision, v_row.fields, v_row.updated_at, v_row.generation;
      return;
    end if;
  end loop;
end;
$$;

-- Discard: the caller's own LIVE draft of exactly this lifecycle, turned into a text-free tombstone IN THE SAME STATEMENT (the text is nulled
-- there, never left behind). UPDATE only: it never inserts, it works with the switch off, and a generation that is not the live one changes nothing.
create or replace function public.discard_client_note_draft(
  p_studio_id uuid,
  p_client_id uuid,
  p_kind text,
  p_target text,
  p_generation uuid
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
  if v_practitioner is null or p_generation is null then
    return false;
  end if;
  update public.client_note_drafts d
     set fields = null, revision = d.revision + 1, writer = null,
         ended_generation = d.generation, generation = null, cleared_at = pg_catalog.now()
   where d.practitioner_id = v_practitioner and d.client_id = p_client_id
     and d.studio_id = p_studio_id and d.kind = p_kind and d.target = p_target
     and d.cleared_at is null and d.generation = p_generation;
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

-- SAME-TRANSACTION CLEAR (Sam: one transaction; Insurance C1/C2/C5; D1: ONLY the saving practitioner's own row, every kind).
-- Keyed ONLY from NEW (never auth.uid()): the saved row's author, client, kind and revise target. SECURITY DEFINER with an EMPTY
-- search_path and every object schema-qualified; EXECUTE revoked by name below. It clears at most one row, the author's own, by the unique key.
-- `ended_generation` is the generation the Save NAMED (the transaction-local setting `hone.draft_generation`, set by the save wrapper), else the
-- live row's OWN generation; so a retried Save of the generation that ended it is refused. Parsed safely: absent or invalid gives NULL and
-- never fails a clinical Save.
-- DOUBLE SAVE (D3): a Save whose generation already ended (another window saved the same draft first) is refused with the closed SQLSTATE
-- 'HN131' and the whole insert rolls back, so one draft can never create two notes. The row is locked FOR UPDATE and re-read after any lock wait.
-- It must never fail for data reasons otherwise: it changes no key column and no CHECK, cap or BEFORE UPDATE on drafts rejects a clear
-- (the cap is INSERT-only and exempts tombstones). Any other failure is raised under the DISTINCT SQLSTATE 'HN130' (never 23505, which the
-- revise path maps to stale_revision), so it surfaces as a generic failure.
create or replace function public.client_note_drafts_clear_on_note()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target text := coalesce(new.supersedes_note_id::text, 'new');
  v_set uuid;
  v_row public.client_note_drafts%rowtype;
  v_id uuid;
  v_try integer := 0;
  v_create boolean;
begin
  begin
    v_set := nullif(pg_catalog.current_setting('hone.draft_generation', true), '')::uuid;
  exception when others then
    v_set := null;
  end;
  -- Rows are CREATED only for an ENABLED studio (autosave off leaves no row at all) and hold no text, only ids and a revision.
  v_create := new.kind in ('consultation', 'skin_hair_analysis')
    and exists (select 1 from public.client_note_draft_enabled_studios e where e.studio_id = new.studio_id);
  loop
    v_try := v_try + 1;
    select d.* into v_row from public.client_note_drafts d
    where d.practitioner_id = new.practitioner_id and d.client_id = new.client_id and d.kind = new.kind and d.target = v_target
    for update;
    if found then
      if v_row.cleared_at is not null and v_set is not null and v_row.ended_generation = v_set then
        raise exception 'note draft already ended' using errcode = 'HN131';
      end if;
      update public.client_note_drafts d
         set fields = null, revision = d.revision + 1, cleared_at = pg_catalog.now(), writer = null, generation = null,
             ended_generation = case when v_row.cleared_at is null then coalesce(v_set, v_row.generation) else coalesce(v_row.ended_generation, v_set) end
       where d.id = v_row.id;
      exit;
    elsif v_create then
      insert into public.client_note_drafts as d (studio_id, client_id, practitioner_id, kind, target, target_note_id, fields, writer, cleared_at, ended_generation)
      values (new.studio_id, new.client_id, new.practitioner_id, new.kind, v_target, new.supersedes_note_id, null, null, pg_catalog.now(), v_set)
      on conflict (practitioner_id, client_id, kind, target) do nothing
      returning d.id into v_id;
      exit when found;
      if v_try >= 3 then
        raise exception 'note draft could not be cleared' using errcode = 'HN130';
      end if;
    else
      exit;
    end if;
  end loop;
  return new;
exception
  when sqlstate 'HN131' then
    raise;
  when others then
    raise exception 'note draft could not be cleared' using errcode = 'HN130';
end;
$$;

drop trigger if exists client_note_drafts_clear_on_note on public.client_clinical_notes;
create trigger client_note_drafts_clear_on_note
  after insert on public.client_clinical_notes
  for each row execute function public.client_note_drafts_clear_on_note();

-- Budget: keyed on NEW.updated_by_practitioner_id plus the client; kind 'budget', target 'current' only. Same identity rule, but NO double-save
-- refusal: a budget is one overwrite row, so a repeated save creates no duplicate record.
create or replace function public.client_note_drafts_clear_on_budget()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set uuid;
  v_row public.client_note_drafts%rowtype;
  v_id uuid;
  v_try integer := 0;
  v_create boolean;
begin
  begin
    v_set := nullif(pg_catalog.current_setting('hone.draft_generation', true), '')::uuid;
  exception when others then
    v_set := null;
  end;
  v_create := exists (select 1 from public.client_note_draft_enabled_studios e where e.studio_id = new.studio_id);
  loop
    v_try := v_try + 1;
    select d.* into v_row from public.client_note_drafts d
    where d.practitioner_id = new.updated_by_practitioner_id and d.client_id = new.client_id and d.kind = 'budget' and d.target = 'current'
    for update;
    if found then
      update public.client_note_drafts d
         set fields = null, revision = d.revision + 1, cleared_at = pg_catalog.now(), writer = null, generation = null,
             ended_generation = case when v_row.cleared_at is null then coalesce(v_set, v_row.generation) else coalesce(v_row.ended_generation, v_set) end
       where d.id = v_row.id;
      exit;
    elsif v_create then
      insert into public.client_note_drafts as d (studio_id, client_id, practitioner_id, kind, target, fields, writer, cleared_at, ended_generation)
      values (new.studio_id, new.client_id, new.updated_by_practitioner_id, 'budget', 'current', null, null, pg_catalog.now(), v_set)
      on conflict (practitioner_id, client_id, kind, target) do nothing
      returning d.id into v_id;
      exit when found;
      if v_try >= 3 then
        raise exception 'note draft could not be cleared' using errcode = 'HN130';
      end if;
    else
      exit;
    end if;
  end loop;
  return new;
exception when others then
  raise exception 'note draft could not be cleared' using errcode = 'HN130';
end;
$$;

drop trigger if exists client_note_drafts_clear_on_budget on public.client_budget_context;
create trigger client_note_drafts_clear_on_budget
  after insert or update on public.client_budget_context
  for each row execute function public.client_note_drafts_clear_on_budget();

-- SAVE WRAPPERS (SECURITY INVOKER; D2, Privacy condition 2). The note and budget actions used a direct table insert / upsert; these two commands
-- are the SAME writes with ONE addition: they hand the draft generation to the clear triggers through a TRANSACTION-LOCAL setting. They run with
-- the CALLER'S rights, so RLS, the append-only history, the studio-derive and attribution triggers and the one-revision index decide exactly as
-- before; nothing here is elevated. Studio and practitioner come from the SESSION (the client's own studio and the caller's active practitioner
-- row there), never from an argument. Errors are closed codes with no text: 42501 when the client or the practitioner row is not available to the
-- caller; every other failure is the table's own (23505 stays the revision conflict). The generation is optional: NULL leaves the old behaviour.
create or replace function public.add_client_clinical_note(
  p_client_id uuid,
  p_kind text,
  p_body text,
  p_areas text[],
  p_occurred_at timestamptz,
  p_supersedes_note_id uuid,
  p_generation uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_practitioner uuid;
  v_id uuid;
begin
  select c.studio_id into v_studio from public.clients c where c.id = p_client_id;
  if v_studio is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  select p.id into v_practitioner from public.practitioners p
  where p.studio_id = v_studio and p.user_id = (select auth.uid()) and p.active;
  if v_practitioner is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('hone.draft_generation', coalesce(p_generation::text, ''), true);
  insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id)
  values (p_client_id, v_studio, v_practitioner, p_kind, p_body, coalesce(p_areas, '{}'::text[]),
          coalesce(p_occurred_at, pg_catalog.now()), p_supersedes_note_id)
  returning id into v_id;
  perform pg_catalog.set_config('hone.draft_generation', '', true);
  return v_id;
end;
$$;

create or replace function public.upsert_client_budget_context(
  p_client_id uuid,
  p_budget_level text,
  p_budget_notes text,
  p_generation uuid default null
)
returns void
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_practitioner uuid;
begin
  select c.studio_id into v_studio from public.clients c where c.id = p_client_id;
  if v_studio is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  select p.id into v_practitioner from public.practitioners p
  where p.studio_id = v_studio and p.user_id = (select auth.uid()) and p.active;
  if v_practitioner is null then
    raise exception 'not available' using errcode = '42501';
  end if;
  perform pg_catalog.set_config('hone.draft_generation', coalesce(p_generation::text, ''), true);
  insert into public.client_budget_context as b (client_id, studio_id, budget_level, budget_notes, updated_by_practitioner_id)
  values (p_client_id, v_studio, p_budget_level, coalesce(p_budget_notes, ''), v_practitioner)
  on conflict (client_id) do update
     set studio_id = excluded.studio_id, budget_level = excluded.budget_level, budget_notes = excluded.budget_notes,
         updated_by_practitioner_id = excluded.updated_by_practitioner_id;
  perform pg_catalog.set_config('hone.draft_generation', '', true);
end;
$$;

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
revoke all privileges on function public.save_client_note_draft(uuid, uuid, text, text, jsonb, integer, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_client_note_draft(uuid, uuid, text, text, jsonb, integer, uuid, uuid) to authenticated;
revoke all privileges on function public.discard_client_note_draft(uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_client_note_draft(uuid, uuid, text, text, uuid) to authenticated;
revoke all privileges on function public.add_client_clinical_note(uuid, text, text, text[], timestamptz, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.add_client_clinical_note(uuid, text, text, text[], timestamptz, uuid, uuid) to authenticated;
revoke all privileges on function public.upsert_client_budget_context(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_client_budget_context(uuid, text, text, uuid) to authenticated;
revoke all privileges on function public.sweep_client_note_drafts()
  from public, anon, authenticated, service_role;
grant execute on function public.sweep_client_note_drafts() to service_role;

commit;
