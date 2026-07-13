-- ---------------------------------------------------------------------------
-- Migration 0126: client_clinical_notes — dedicated dated CONSULTATION notes +
-- SKIN/HAIR ANALYSIS clinical records (Willow PR A).
--
-- Two clearly-separate clinical record kinds in ONE dated, append-only table
-- (kind = 'consultation' | 'skin_hair_analysis'). These are dated clinical
-- entries, NOT two overwriteable client columns:
--   * Creating a note inserts a new row.
--   * A correction/revision inserts a NEW row linked via supersedes_note_id.
--   * The original is never overwritten (append-only; in-place UPDATE is blocked
--     for every role by a trigger) and never silently removed.
--   * The "latest" of each kind = the newest NON-superseded row.
--
-- ADDITIVE + NON-DESTRUCTIVE. This migration does NOT migrate, copy, reinterpret,
-- or delete data from clients.notes, clients.skin_notes, client_personal_notes,
-- sessions.session_notes, sessions.next_session_note, intake practitioner notes,
-- treatment comments, or observation chips. NO backfill. It does NOT touch
-- clinical finalization/correction flags. Repo/hosted max was 0125; this is 0126.
--
-- Tenant isolation is enforced in the DATABASE (not only the app): studio_id is
-- trigger-derived from the parent client (anti-spoof, the 0035 pattern); same-
-- studio composite FKs use the 0032 companion uniques; RLS limits reads to studio
-- members and inserts to a member attributing a note to THEIR OWN practitioner.
-- ---------------------------------------------------------------------------

create table if not exists public.client_clinical_notes (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null,
  -- Denormalized for RLS; ALWAYS trigger-derived from the parent client below so
  -- a caller cannot attach a note under a different studio than its client.
  studio_id          uuid not null,
  practitioner_id    uuid not null,                 -- authoring practitioner (attribution)
  kind               text not null
                       check (kind in ('consultation', 'skin_hair_analysis')),
  body               text not null,
  -- Optional canonical treatment-area tags (skin/hair analysis may reference one
  -- or more existing areas). Optional; free-text `body` remains the source of
  -- detail. NO per-area laterality here (that is PR C).
  areas              text[] not null default '{}'::text[],
  -- Clinical event time (backdatable); distinct from created_at (row insert time).
  occurred_at        timestamptz not null default now(),
  -- When set, THIS row is a revision/correction of that note (same client, studio,
  -- and kind — validated by the trigger). The superseded row stays in history.
  supersedes_note_id uuid,
  created_at         timestamptz not null default now(),

  constraint client_clinical_notes_body_nonempty check (length(btrim(body)) > 0),

  -- Same-studio structural integrity via the 0032 companion uniques. Both CASCADE
  -- so a client / studio / practitioner removal tears these rows down cleanly (no
  -- RESTRICT ordering block); same-studio-at-write is additionally enforced by the
  -- trigger + RLS. A practitioner is studio-bound and the row is append-only, so
  -- the (practitioner_id, studio_id) pairing can never later drift.
  constraint client_clinical_notes_client_same_studio
    foreign key (client_id, studio_id)
    references public.clients (id, studio_id) on delete cascade,
  constraint client_clinical_notes_practitioner_same_studio
    foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete cascade,
  constraint client_clinical_notes_supersedes_fk
    foreign key (supersedes_note_id)
    references public.client_clinical_notes (id) on delete set null
);

-- Optimistic concurrency: at most ONE revision may supersede a given note. Two
-- concurrent revisions of the same (already-superseded) note → the second insert
-- violates this unique → surfaced to the practitioner as a stale-revision conflict
-- (newer clinical information is never silently replaced).
create unique index if not exists client_clinical_notes_supersedes_uniq
  on public.client_clinical_notes (supersedes_note_id)
  where supersedes_note_id is not null;

-- Latest-by-kind + dated history reads.
create index if not exists client_clinical_notes_latest_idx
  on public.client_clinical_notes (studio_id, client_id, kind, occurred_at desc, created_at desc);
create index if not exists client_clinical_notes_client_idx
  on public.client_clinical_notes (client_id);
create index if not exists client_clinical_notes_practitioner_idx
  on public.client_clinical_notes (practitioner_id);

-- BEFORE INSERT: (1) derive studio_id from the parent client, overwriting any
-- caller value (anti-spoof, same shape as client_personal_notes 0035); (2) if this
-- is a revision, require the superseded note to be the SAME client + studio + kind.
-- Runs as INVOKER, so RLS hides other studios' clients/notes → a cross-studio
-- client_id or supersedes_note_id resolves to "not found" and is rejected.
create or replace function public.client_clinical_notes_before_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_super  public.client_clinical_notes%rowtype;
begin
  select studio_id into v_studio from public.clients where id = new.client_id;
  if v_studio is null then
    raise exception 'client_clinical_notes.client_id % does not reference a visible clients row', new.client_id;
  end if;
  new.studio_id := v_studio;

  if new.supersedes_note_id is not null then
    select * into v_super from public.client_clinical_notes where id = new.supersedes_note_id;
    if not found then
      raise exception 'supersedes_note_id % not found', new.supersedes_note_id;
    end if;
    if v_super.client_id <> new.client_id
       or v_super.studio_id <> new.studio_id
       or v_super.kind <> new.kind then
      raise exception 'a revision must supersede a note of the same client, studio, and kind';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists client_clinical_notes_before_insert on public.client_clinical_notes;
create trigger client_clinical_notes_before_insert
  before insert on public.client_clinical_notes
  for each row execute function public.client_clinical_notes_before_insert();

-- APPEND-ONLY: no in-place UPDATE by ANY role (a correction is a NEW superseding
-- row, never an overwrite of prior clinical content). DELETE is intentionally NOT
-- blocked here so a parent client/studio/practitioner CASCADE can tear the rows
-- down; browser roles get neither UPDATE nor DELETE (RLS + REVOKE below).
create or replace function public.client_clinical_notes_no_update()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'client_clinical_notes is append-only; record a revision (supersedes_note_id) instead of editing a saved note';
end;
$$;

drop trigger if exists client_clinical_notes_no_update on public.client_clinical_notes;
create trigger client_clinical_notes_no_update
  before update on public.client_clinical_notes
  for each row execute function public.client_clinical_notes_no_update();

-- RLS. Studio members READ their studio's notes; a member may INSERT only a note
-- for a client in their studio, attributed to THEIR OWN active practitioner in
-- that studio. NO update/delete policy (append-only). Portal / public-booking /
-- email / unauthenticated roles get nothing.
alter table public.client_clinical_notes enable row level security;

drop policy if exists "client_clinical_notes_member_select" on public.client_clinical_notes;
create policy "client_clinical_notes_member_select"
  on public.client_clinical_notes for select to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "client_clinical_notes_author_insert" on public.client_clinical_notes;
create policy "client_clinical_notes_author_insert"
  on public.client_clinical_notes for insert to authenticated
  with check (
    public.is_studio_member(studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = practitioner_id
        and p.studio_id = studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

-- Grants: authenticated may SELECT + INSERT (RLS-gated); UPDATE/DELETE/TRUNCATE
-- revoked (append-only). anon gets nothing. service_role is narrow (SELECT/INSERT;
-- the append-only trigger still blocks any UPDATE even for service_role).
grant select, insert on public.client_clinical_notes to authenticated;
revoke update, delete, truncate on public.client_clinical_notes from authenticated;
revoke all on public.client_clinical_notes from anon;
grant select, insert on public.client_clinical_notes to service_role;
