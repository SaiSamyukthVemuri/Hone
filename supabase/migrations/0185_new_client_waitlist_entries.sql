-- ===========================================================================
-- NEW-CLIENT WAITLIST — DURABLE, STUDIO-SCOPED RECORD (WAIT-02) — 0185
-- ===========================================================================
--
-- THE DEFECT. WAIT-01 shipped as emergency admission control: a studio in
-- waitlist mode diverts NEW clients away from slot selection and the request
-- is delivered as an EMAIL. Provider acceptance is the commit point, so the
-- studio's operational record is an inbox. An inbox cannot be counted, ordered,
-- deduplicated, corrected, scoped to a tenant, or exported, and a message that
-- is filtered, deleted or missed is a lead that silently never existed.
--
-- THIS FILE MOVES THE COMMIT POINT INTO THE DATABASE. After WAIT-02, "joined
-- the waitlist" means "a row is committed here". Email becomes notification.
--
-- WHAT A ROW IS, AND IS NOT. A waiting person is a PROSPECT, not a client.
-- Nothing here creates or references a `clients` row, an appointment, an
-- intake, a session, a portal account or a clinical record, and there is no
-- code path in this release that can. WAITING != CLIENT is the whole point:
-- the previous emergency release was explicitly built to avoid manufacturing
-- client records for people who have only asked to be contacted.
--
-- NOT `public.waitlist` (0004). That table is the Hone MARKETING early-access
-- list: globally unique email, no studio ownership, anonymous INSERT policy. It
-- is a different product concept with a different tenancy model, and merging
-- the two would give one studio's prospect list global email uniqueness across
-- every other studio. This table is created alongside it, not on top of it.
--
-- WHAT THIS FILE DOES NOT DO. No invitation token, no queue position, no
-- ranking, no capacity model, no "safe to invite N", no automatic release, no
-- appointment creation. Those are WAIT-03 / ADMIT-01..03 and none of their
-- state is representable here.
--
-- Re-runnable: create-if-not-exists / drop-if-exists throughout.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------
-- TENANCY IS THE FIRST PROPERTY, NOT A FILTER. Every row belongs to exactly
-- one studio by NOT NULL FK, and every index, policy, grant and command below
-- is scoped by that column. There is deliberately NO global uniqueness of any
-- kind: the same person may legitimately be waiting at two unrelated studios,
-- and one studio's list must never constrain, reveal or deduplicate against
-- another's.
--
-- email_normalized IS A GENERATED COLUMN, NOT AN APPLICATION CONVENTION.
-- The duplicate rule depends on normalized contact identity, so the
-- normalization is defined ONCE, here, at the authority that enforces the
-- rule. An application-side `.toLowerCase()` is a second implementation of the
-- same law that can drift from it; a stored generated column cannot. The
-- submitted `email` is kept verbatim beside it so the presentation value is
-- never lost to normalization.
create table if not exists public.new_client_waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,

  -- BOUNDED CONTACT. Exactly the three fields the public WAIT-01 form
  -- collects, and nothing else. No free-text clinical note, no AI score, no
  -- cached rank, no position number, no practitioner-authored commentary: this
  -- is a contact record for someone who is not yet a client, and every column
  -- that would invite treating it as a clinical record is deliberately absent.
  name text not null,
  email text not null,
  email_normalized text generated always as (lower(btrim(email))) stored,
  phone text,

  -- LIFECYCLE. `converted` is DECLARED VOCABULARY with no writer in this
  -- release. Conversion means "this person became a real client through the
  -- normal authoritative booking flow" — a transition the waitlist record must
  -- never manufacture for itself. No safe atomic hook into that flow exists
  -- yet, so the transition trigger below permits waiting -> removed ONLY, and
  -- the columns that would carry conversion EVIDENCE (converted_at, the client
  -- relation) are deliberately not created: a nullable column no path can fill
  -- is a promise, not a record. The vocabulary is fixed now so the product law
  -- is stated once; the slice that actually performs a conversion adds its own
  -- evidence columns and relaxes the transition rule explicitly.
  status text not null default 'waiting',

  -- PROVENANCE. One legal value today. It exists so that when a second entry
  -- route appears (a studio adding someone by hand, an import), rows written
  -- BEFORE it are already correctly attributed instead of being retroactively
  -- guessed at. Bounded by CHECK, never free text.
  source text not null default 'public_booking',

  -- SERVER-OWNED TIME. Both are forced by the BEFORE INSERT trigger below
  -- rather than defaulted: `default now()` only applies when the caller omits
  -- the column, and the only writer is a SECURITY DEFINER command whose author
  -- could otherwise supply a joined_at and reorder the queue.
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- REMOVAL EVIDENCE. A removed entry is a terminal TRANSITION, never a
  -- DELETE: "who was waiting and what happened to them" is the operational
  -- history the inbox could not keep. Both columns are null while waiting and
  -- both are required once removed (CHECK below).
  removed_at timestamptz,
  -- ACTOR column, studio-scoped by composite FK per the 0179 actor-FK
  -- doctrine. A simple FK to practitioners(id) would let a removal be
  -- attributed to a practitioner from ANOTHER studio; dual membership is
  -- exactly the configuration behind the 0181 production incident. ON DELETE
  -- RESTRICT because attribution is durable, matching every other 0179 actor
  -- column. Practitioners are deactivated (`active = false`), not deleted.
  removed_by_practitioner_id uuid,

  constraint new_client_waitlist_entries_removed_by_same_studio_fk
    foreign key (removed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- The lifecycle vocabulary. Three terminal-or-active states, nothing else.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_status_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_status_check
  check (status in ('waiting', 'removed', 'converted'));

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_source_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_source_check
  check (source in ('public_booking'));

-- BOUNDED PUBLIC INPUT, ENFORCED AT THE AUTHORITY. These mirror the ceilings
-- the public form and the server validator already apply, and they are
-- restated here because the application's copy of a bound is a courtesy, not a
-- guarantee — the database is the only layer a forged or future caller cannot
-- route around. The email shape is the same conservative pattern the rest of
-- the project uses for public email input; it is a sanity bound, not an
-- RFC 5322 parser.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_name_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_name_check
  check (length(btrim(name)) between 1 and 120);

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_email_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_email_check
  check (
    length(email) <= 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  );

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_phone_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_phone_check
  check (phone is null or length(btrim(phone)) between 1 and 40);

-- REMOVAL EVIDENCE IS ALL-OR-NOTHING. A `removed` row without a timestamp and
-- an actor is an unexplained disappearance; a waiting row carrying removal
-- evidence is a contradiction. Both are unrepresentable.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_removal_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_removal_evidence_check
  check (
    (status = 'removed'
      and removed_at is not null
      and removed_by_practitioner_id is not null)
    or
    (status <> 'removed'
      and removed_at is null
      and removed_by_practitioner_id is null)
  );

-- ---------------------------------------------------------------------------
-- THE DUPLICATE LAW
-- ---------------------------------------------------------------------------
-- ONE ACTIVE WAITING ENTRY PER NORMALIZED EMAIL PER STUDIO.
--
-- Email is the identity component, and ONLY email. The WAIT-01 form collects
-- name, email and an OPTIONAL phone that is a plain contact string — no E.164
-- coercion, no dedupe, no match against `clients`. Two people can share a
-- household phone, one person can submit with and without one, and an
-- unnormalized phone cannot be compared safely. Widening the identity to a
-- field the product does not normalize would merge distinct people; that is a
-- worse failure than an occasional duplicate, so the rule is the narrowest one
-- the collected data actually supports.
--
-- SCOPED TO STATUS. Only `waiting` rows participate, so a person who was
-- removed can rejoin later and their history is preserved rather than
-- overwritten.
--
-- SCOPED TO STUDIO. studio_id is the leading column. Remove it and the same
-- person could not be waiting at two unrelated studios — a cross-tenant
-- coupling with no product meaning.
--
-- This index is also the CONCURRENCY primitive: `join_new_client_waitlist`
-- below infers ON CONFLICT against it, so two simultaneous identical
-- submissions resolve inside ONE atomic statement instead of racing between a
-- read and a write.
create unique index if not exists new_client_waitlist_entries_one_waiting_per_email
  on public.new_client_waitlist_entries (studio_id, email_normalized)
  where status = 'waiting';

-- The operator queue read: one studio, one status, oldest first, id as the
-- deterministic tie-break. Column order matches the ORDER BY exactly so the
-- bounded page read is an index scan rather than a sort.
create index if not exists new_client_waitlist_entries_queue_idx
  on public.new_client_waitlist_entries (studio_id, status, joined_at, id);

-- ---------------------------------------------------------------------------
-- TRIGGERS
-- ---------------------------------------------------------------------------
-- Reuses the existing public.set_updated_at() helper (0015).
drop trigger if exists new_client_waitlist_entries_set_updated_at
  on public.new_client_waitlist_entries;
create trigger new_client_waitlist_entries_set_updated_at
  before update on public.new_client_waitlist_entries
  for each row execute function public.set_updated_at();

-- QUEUE ORDER IS DATABASE TIME, NOT CALLER TIME.
--
-- `default now()` is not a guarantee — a default applies only when the caller
-- OMITS the column. joined_at is the ordering key of the entire operator
-- surface, so a caller able to supply it could insert itself at the head of
-- someone else's queue. Both timestamps are OVERWRITTEN here rather than
-- rejected: there is no prior value to protect on an insert.
create or replace function public.new_client_waitlist_entries_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.joined_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists new_client_waitlist_entries_server_timestamps
  on public.new_client_waitlist_entries;
create trigger new_client_waitlist_entries_server_timestamps
  before insert on public.new_client_waitlist_entries
  for each row execute function public.new_client_waitlist_entries_server_timestamps();

-- THE ONLY LEGAL UPDATE IS waiting -> removed.
--
-- Identity, tenancy, contact and provenance are all frozen after insert, and
-- the lifecycle is a one-way door. Three separate things this closes:
--
--   1. A ROW CANNOT CHANGE STUDIOS. studio_id is mutable in PostgreSQL like
--      any other column, and the queue read filters on it, so an UPDATE that
--      moved a row would hand one studio's prospect to another.
--   2. LIFECYCLE HISTORY CANNOT BE REWRITTEN. removed -> waiting would
--      resurrect an entry the studio deliberately closed, and any path to
--      `converted` would let a record claim a client relationship that the
--      booking flow never created. `converted` therefore has NO legal
--      transition in this release; the slice that performs real conversions
--      replaces this function and states its own rule.
--      REMOVAL EVIDENCE IS PART OF THAT HISTORY. Guarding only the status
--      COLUMN would leave a hole: an UPDATE on an already-removed row that
--      leaves `status` alone changes no guarded field, satisfies the
--      all-or-nothing CHECK, and satisfies the composite FK for any
--      same-studio practitioner — so "who removed this, and when" could be
--      rewritten while the file called it durable attribution. That is the
--      0183 failure shape exactly: a contract stated in prose and enforced
--      over a narrower set than the prose describes. The two evidence columns
--      may therefore change ONLY in the same statement that performs the legal
--      waiting -> removed transition.
--   3. CONTACT CORRECTION IS OUT OF SCOPE, LOUDLY. V1 ships no edit surface,
--      so rather than leaving name/email/phone quietly mutable through a
--      future accidental writer, they are frozen. Adding correction is then an
--      explicit change to this trigger with its own audit decision, not a
--      silent capability someone discovers.
--
-- Rejected, never silently corrected: a silent correction hides both a caller
-- bug and an attack.
create or replace function public.new_client_waitlist_entries_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.joined_at is distinct from old.joined_at
     or new.source is distinct from old.source then
    raise exception
      'new_client_waitlist_entries: id, studio_id, joined_at and source are immutable'
      using errcode = 'check_violation';
  end if;

  if new.name is distinct from old.name
     or new.email is distinct from old.email
     or new.phone is distinct from old.phone then
    raise exception
      'new_client_waitlist_entries: contact details are immutable in this release; there is no correction command yet'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status
     and not (old.status = 'waiting' and new.status = 'removed') then
    raise exception
      'new_client_waitlist_entries: the only permitted status transition is waiting -> removed (attempted % -> %)',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Removal evidence is WRITE-ONCE, at the moment of removal. Outside that one
  -- transition neither column may move — not to a different practitioner, not
  -- to a different time, and not back to NULL.
  if not (old.status = 'waiting' and new.status = 'removed')
     and (new.removed_at is distinct from old.removed_at
          or new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id) then
    raise exception
      'new_client_waitlist_entries: removal evidence is recorded once, by the waiting -> removed transition, and cannot be rewritten afterwards'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists new_client_waitlist_entries_transition_guard
  on public.new_client_waitlist_entries;
create trigger new_client_waitlist_entries_transition_guard
  before update on public.new_client_waitlist_entries
  for each row execute function public.new_client_waitlist_entries_transition_guard();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- READ-ONLY, OWNER-ONLY, AND ONLY FOR YOUR OWN STUDIO.
--
-- There is exactly ONE policy and it is a SELECT policy. No insert, update or
-- delete policy exists for any role, so even if a table grant were widened by
-- mistake, RLS would still refuse the write: the two capabilities have to fail
-- together for a browser-reachable write to appear.
--
-- OWNER, not member. This table is a list of contactable people who are not
-- clients, so it is the narrowest existing authority that fits: `/settings/
-- booking`, the surface that governs public new-client intake, is already
-- owner-only. Widening to members later is additive and reversible; starting
-- wide is neither.
alter table public.new_client_waitlist_entries enable row level security;

drop policy if exists "new_client_waitlist_entries_owner_select"
  on public.new_client_waitlist_entries;
create policy "new_client_waitlist_entries_owner_select"
  on public.new_client_waitlist_entries for select to authenticated
  -- Fully qualified. 0126 wrote the equivalent clause with a bare column name
  -- and PostgreSQL resolved it to the wrong relation, degrading the check to a
  -- tautology that 0127 had to repair in production.
  using (public.is_studio_owner(new_client_waitlist_entries.studio_id));

-- ---------------------------------------------------------------------------
-- COMMAND 1 — PUBLIC JOIN
-- ---------------------------------------------------------------------------
-- ONE ATOMIC STATEMENT DECIDES THE OUTCOME.
--
-- The forbidden shape is read -> "no row" -> insert: two concurrent submissions
-- both read nothing and both insert, and the invariant is enforced (or not) by
-- luck and by whichever error the loser happens to raise. Here the INSERT ...
-- ON CONFLICT DO NOTHING against the partial unique index IS the decision.
-- Exactly one concurrent caller inserts; the other inserts nothing, and
-- PostgreSQL makes it WAIT on the in-flight speculative insertion first, so by
-- the time it reads back under a fresh READ COMMITTED snapshot the winner's row
-- is committed and visible.
--
-- The bounded second attempt covers the one remaining interleaving: the
-- conflicting transaction ABORTED after we waited on it, or its row was
-- removed between our statements. One retry resolves it; two failures in a row
-- report `unknown` rather than guessing, because telling a visitor they joined
-- a waitlist that holds no row is the failure this whole release exists to end.
--
-- VALIDATION AND NORMALIZATION HAPPEN HERE. The command does not trust the
-- caller to have trimmed, lowercased or bounded anything.
--
-- WHAT THIS COMMAND CANNOT DO. It writes exactly one table. It creates no
-- client, appointment, intake, session or notification row, and it holds no
-- privilege that would let it: it is the SELECT on `studios` plus the INSERT
-- here, and nothing else.
create or replace function public.join_new_client_waitlist(
  p_studio_id uuid,
  p_name      text,
  p_email     text,
  p_phone     text
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_max_attempts constant integer := 2;

  v_name    text := btrim(coalesce(p_name, ''));
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_id      uuid;
  v_attempt integer := 0;
begin
  -- Bounded input first, so junk never reaches a lookup or an index.
  if v_name = ''
     or length(v_name) > 120
     or v_email = ''
     or length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (v_phone is not null and length(v_phone) > 40) then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

  -- The studio is a SERVER fact by the time this runs (the caller resolved it
  -- from the public slug), but an id that no longer exists must come back as a
  -- closed result code rather than a foreign-key exception: an exception is
  -- indistinguishable from "the insert may have committed", and the caller
  -- would have to report an unconfirmed outcome for a request that certainly
  -- did not land.
  if p_studio_id is null
     or not exists (select 1 from public.studios s where s.id = p_studio_id) then
    return query select 'studio_not_found'::text, null::uuid;
    return;
  end if;

  while v_attempt < c_max_attempts loop
    v_attempt := v_attempt + 1;
    v_id := null;

    insert into public.new_client_waitlist_entries (studio_id, name, email, phone)
    values (p_studio_id, v_name, v_email, v_phone)
    on conflict (studio_id, email_normalized) where status = 'waiting'
    do nothing
    returning id into v_id;

    if v_id is not null then
      return query select 'created'::text, v_id;
      return;
    end if;

    select e.id into v_id
      from public.new_client_waitlist_entries e
     where e.studio_id       = p_studio_id
       and e.email_normalized = v_email
       and e.status          = 'waiting'
     limit 1;

    if v_id is not null then
      return query select 'already_waiting'::text, v_id;
      return;
    end if;
  end loop;

  return query select 'unknown'::text, null::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 2 — OPERATOR REMOVAL
-- ---------------------------------------------------------------------------
-- REMOVAL IS A TRANSITION THE DATABASE PERFORMS, NOT A WRITE THE BROWSER
-- REQUESTS.
--
-- `authenticated` holds SELECT and nothing else on this table, so there is no
-- direct-DML route to removal at all. Authority is re-derived here from
-- (studio_id, actor user id): the caller supplies a user id its own session
-- already authenticated, and NEVER a role. A non-member and a non-owner are
-- refused before the entry is looked at, so this command cannot be used to
-- probe another studio's list, and the entry lookup is scoped by BOTH id and
-- studio so a cross-studio id is simply "not found" rather than "forbidden".
--
-- The row is locked FOR UPDATE before the transition so two concurrent
-- removals produce one removal and one `already_removed`, not two writes
-- racing over the actor and timestamp.
create or replace function public.remove_new_client_waitlist_entry(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_practitioner_id uuid;
  v_role            text;
  v_status          text;
begin
  if p_studio_id is null or p_entry_id is null or p_actor_user_id is null then
    return 'invalid_input';
  end if;

  select p.id, p.role
    into v_practitioner_id, v_role
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id   = p_actor_user_id
     and p.active    = true
   limit 1;

  if v_practitioner_id is null then
    return 'not_a_member';
  end if;
  if v_role <> 'owner' then
    return 'not_owner';
  end if;

  select e.status
    into v_status
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id
     and e.studio_id = p_studio_id
     for update;

  if v_status is null then
    return 'not_found';
  end if;
  if v_status = 'removed' then
    return 'already_removed';
  end if;
  if v_status <> 'waiting' then
    return 'not_waiting';
  end if;

  update public.new_client_waitlist_entries
     set status                     = 'removed',
         removed_at                 = now(),
         removed_by_practitioner_id = v_practitioner_id
   where id        = p_entry_id
     and studio_id = p_studio_id
     and status    = 'waiting';

  return 'removed';
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- Supabase's ALTER DEFAULT PRIVILEGES grants to anon, authenticated AND
-- service_role at create time, and PostgreSQL grants to PUBLIC, so every role
-- is REVOKED BY NAME and only the intended privilege is granted back. 0183
-- stated its contract as an allowlist but enforced it as a denylist, and
-- PostgreSQL 17's MAINTAIN survived because no by-name revoke list could have
-- named it; 0184 had to repair that in production. REVOKE ALL first is the
-- form that cannot fail by enumeration.
--
-- TABLE
--   authenticated : SELECT only, RLS-gated to the studio's own OWNER. Every
--                   write goes through a command, so there is no DML to grant.
--   anon          : NOTHING. The public join runs server-side through the
--                   service-role client; an anonymous browser can neither read
--                   a row nor enumerate the table.
--   service_role  : NOTHING ON THE TABLE. It holds EXECUTE on the two commands
--                   and nothing more, so even the server's most privileged
--                   client cannot dump this table's contact details directly.
revoke all on public.new_client_waitlist_entries
  from public, anon, authenticated, service_role;
grant select on public.new_client_waitlist_entries to authenticated;

-- FUNCTIONS. Both are server-side commands invoked by the application's
-- service-role client; neither is callable from a browser session of any kind.
-- Written as literal statements, never a DO-block with format(), because the
-- grant guards read them textually.
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from public;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from anon;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from authenticated;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from service_role;

revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;

grant execute on function public.join_new_client_waitlist(uuid, text, text, text) to service_role;
grant execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

-- The trigger functions are SECURITY INVOKER and `returns trigger`, so they can
-- only ever run as triggers and an EXECUTE grant on one is inert (PostgreSQL
-- raises 0A000 on a direct call). Revoked from all four grantees anyway,
-- exactly as 0184 does, so the API surface states that fact rather than
-- carrying create-time defaults that mean nothing.
revoke all privileges on function public.new_client_waitlist_entries_server_timestamps()
  from public, anon, authenticated, service_role;

revoke all privileges on function public.new_client_waitlist_entries_transition_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- COMMENTS
-- ---------------------------------------------------------------------------
comment on table public.new_client_waitlist_entries is
  'DURABLE, STUDIO-SCOPED new-client waitlist (WAIT-02). A row is a PROSPECT who asked to be contacted, NOT a client: joining creates no client, appointment, intake, session or portal account, and no code path in this release can. Replaces the WAIT-01 email inbox as the operational record — a committed row IS "joined the waitlist"; email is notification only. Distinct from public.waitlist (0004), which is the Hone marketing early-access list with global email uniqueness and no studio ownership. No queue position, ranking, invitation or capacity state is stored or implied.';

comment on column public.new_client_waitlist_entries.email_normalized is
  'lower(btrim(email)), generated and stored by the DATABASE. This is the identity component of the duplicate rule, so the normalization lives at the authority that enforces it rather than in an application helper that can drift from it. The submitted email is preserved verbatim in `email`.';

comment on column public.new_client_waitlist_entries.status is
  'waiting | removed | converted. `converted` is declared vocabulary with NO writer in this release: conversion happens through the normal authoritative booking flow, which the waitlist record must never manufacture, and the columns carrying conversion evidence belong to the slice that performs it. The transition trigger permits waiting -> removed ONLY.';

comment on column public.new_client_waitlist_entries.joined_at is
  'Server-assigned at INSERT by trigger, never accepted from the caller. This is the ordering key of the operator queue (joined_at, id), so a caller able to supply it could insert ahead of people already waiting.';

comment on column public.new_client_waitlist_entries.removed_by_practitioner_id is
  'The OWNER who removed this entry, verified inside remove_new_client_waitlist_entry from (studio_id, authenticated user id) — never supplied by the caller. Studio-scoped by composite FK per the 0179 actor doctrine so a removal cannot be attributed to a practitioner from another studio. WRITE-ONCE: together with removed_at it may change only in the statement that performs the waiting -> removed transition, so attribution cannot be rewritten afterwards by the table owner or by a future definer command.';

comment on function public.join_new_client_waitlist(uuid, text, text, text) is
  'Public new-client waitlist join. THE COMMIT POINT for WAIT-02. Atomic on the studio-scoped partial unique index: concurrent identical submissions yield exactly one `created` and one `already_waiting`, never two rows and never a raised unique violation. Returns created | already_waiting | invalid_input | studio_not_found | unknown. Validates and normalizes its own input. Writes exactly one table. service_role only.';

comment on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) is
  'Operator removal: waiting -> removed, with the actor and timestamp recorded. Re-derives studio membership AND owner role from (studio_id, actor user id); the caller never supplies a role. The entry is scoped by (id, studio_id) so a cross-studio id is not found. Never deletes. Returns removed | already_removed | not_waiting | not_found | not_a_member | not_owner | invalid_input. service_role only.';

commit;
