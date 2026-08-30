-- ===========================================================================
-- NEW-CLIENT WAITLIST — PRIVATE INVITATION LIFECYCLE (WAIT-03) — 0188
-- ===========================================================================
--
-- WHAT WAIT-02 LEFT UNBUILT. 0185 moved the commit point for "joined the
-- waitlist" off an email inbox and onto a committed row. It deliberately
-- stopped there: no invitation token, no queue claim, no TTL, no conversion.
-- Its transition guard permits `waiting -> removed` and NOTHING ELSE, and its
-- status CHECK admits only waiting/removed/converted -- so every state this
-- release needs is refused twice over, and no application role holds INSERT or
-- UPDATE on the table to route around either refusal. That is why this is a
-- migration and not application code.
--
-- WHAT AN INVITATION IS, AND IS NOT. An invitation grants a prospect the
-- OPPORTUNITY to choose a legal consultation slot. It is NOT an appointment,
-- and NOTHING here creates one: the redeem command writes exactly two tables
-- and holds no privilege that could reach `appointments`. Booking remains the
-- canonical public appointment authority (0170). Conversion is recorded
-- AFTERWARDS, explicitly, by its own command.
--
-- SMS STOP IS NOT WAITLIST REMOVAL. Nothing in this file couples a messaging
-- opt-out to a lifecycle transition. A prospect who stops messages keeps their
-- place; removal is an explicit operator transition and always has been.
--
-- WHY A CHILD TABLE AND NOT COLUMNS. An entry may be invited, expire, be
-- requeued and be invited AGAIN. Columns on the entry hold exactly one
-- invitation, so a re-invite would overwrite the previous one's evidence --
-- the failure 0185 designed against when it made removal evidence write-once.
-- The entry therefore carries only CURRENT-CYCLE state; the durable, append-
-- only provenance lives in public.new_client_waitlist_invitations.
--
-- NO AUTOMATIC ANYTHING. No timer, no sweep, no background release, no
-- admission logic, and no claim that inviting N is safe. Every transition in
-- this file is performed by an explicit, authenticated operator command.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. THE ENTRIES TABLE MUST BECOME FK-REFERENCEABLE BY (id, studio_id)
-- ---------------------------------------------------------------------------
-- The invitation child below is tied to its entry by a COMPOSITE key so an
-- invitation can never reference an entry belonging to another studio. A plain
-- FK to (id) would permit exactly that. `clients` and `practitioners` already
-- carry their (id, studio_id) unique constraints for the same reason (0179);
-- this table was created with a bare PRIMARY KEY (id) and needs one added.
-- ADDED CONDITIONALLY, NOT drop-then-add. The invitation table's composite FK
-- DEPENDS on this constraint, so a `drop constraint if exists` re-run fails
-- with "cannot drop ... because other objects depend on it" -- the migration
-- would apply once and then refuse forever. Existence is tested instead.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.new_client_waitlist_entries'::regclass
       and conname  = 'new_client_waitlist_entries_id_studio_id_unique'
  ) then
    alter table public.new_client_waitlist_entries
      add constraint new_client_waitlist_entries_id_studio_id_unique unique (id, studio_id);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. THE LIFECYCLE VOCABULARY
-- ---------------------------------------------------------------------------
-- waiting   -- in the pool, not spoken for
-- claimed   -- exclusively held by one operator for invitation
-- invited   -- a live token exists
-- converted -- became a client through the canonical booking authority
-- expired   -- the invitation's TTL lapsed; recorded explicitly, never by a timer
-- released  -- the claim/invitation was explicitly invalidated
-- removed   -- terminal operator removal (0185)
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_status_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_status_check
  check (status in ('waiting','claimed','invited','converted','expired','released','removed'));

-- ---------------------------------------------------------------------------
-- 3. CURRENT-CYCLE EVIDENCE
-- ---------------------------------------------------------------------------
-- Actor and relation columns are studio-scoped by COMPOSITE FK per the 0179
-- actor-FK doctrine: a simple FK to practitioners(id) would let a claim be
-- attributed to a practitioner from ANOTHER studio, which is the exact
-- configuration behind the 0181 production incident.
alter table public.new_client_waitlist_entries
  add column if not exists claimed_at                 timestamptz,
  add column if not exists claimed_by_practitioner_id uuid,
  add column if not exists invited_at                 timestamptz,
  add column if not exists expired_at                 timestamptz,
  add column if not exists released_at                timestamptz,
  add column if not exists converted_at               timestamptz,
  add column if not exists converted_client_id        uuid;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_claimed_by_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_claimed_by_same_studio_fk
  foreign key (claimed_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_converted_client_same_studio_fk;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_converted_client_same_studio_fk
  foreign key (converted_client_id, studio_id)
  references public.clients (id, studio_id) on delete restrict;

-- EVIDENCE IS ALL-OR-NOTHING PER STATE. A state that does not carry the
-- evidence its own name asserts is an unexplained record; a state carrying
-- evidence it has not earned is a contradiction. Both are unrepresentable.
-- `released` deliberately does NOT constrain the claim/invite columns: a
-- release can arrive from claimed, invited or expired, and the evidence of
-- what was released is preserved rather than blanked.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_cycle_evidence_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_cycle_evidence_check
  check (
    case status
      when 'waiting' then
        claimed_at is null and claimed_by_practitioner_id is null
        and invited_at is null and expired_at is null and released_at is null
        and converted_at is null and converted_client_id is null
      when 'claimed' then
        claimed_at is not null and claimed_by_practitioner_id is not null
        and invited_at is null and expired_at is null and released_at is null
        and converted_at is null and converted_client_id is null
      when 'invited' then
        claimed_at is not null and claimed_by_practitioner_id is not null
        and invited_at is not null and expired_at is null and released_at is null
        and converted_at is null and converted_client_id is null
      when 'converted' then
        claimed_at is not null and claimed_by_practitioner_id is not null
        and invited_at is not null
        and converted_at is not null and converted_client_id is not null
        and expired_at is null and released_at is null
      when 'expired' then
        claimed_at is not null and claimed_by_practitioner_id is not null
        and invited_at is not null and expired_at is not null
        and released_at is null
        and converted_at is null and converted_client_id is null
      when 'released' then
        released_at is not null
        and converted_at is null and converted_client_id is null
      when 'removed' then
        converted_at is null and converted_client_id is null
      else false
    end
  );

-- ---------------------------------------------------------------------------
-- 4. THE DUPLICATE LAW, WIDENED TO EVERY ACTIVE STATE
-- ---------------------------------------------------------------------------
-- 0185's index was `WHERE status = 'waiting'`, which was complete while
-- `waiting` was the only active state. It is NOT complete now: a claimed or
-- invited entry would LEAVE the index, so the same person could submit the
-- public form again and hold two live places at once -- and then be claimed
-- and invited twice.
--
-- THIS INDEX AND COMMAND 1 BELOW ARE ATOMICALLY COUPLED. Widening the index
-- alone is WORSE than leaving it: `join_new_client_waitlist` infers its
-- arbiter as `where status = 'waiting'` (which still resolves, because that
-- predicate is implied BY the wider one) and then READS BACK with
-- `and e.status = 'waiting'`. Against a claimed row the insert is suppressed
-- AND the read-back finds nothing, so the command falls through to 'unknown'
-- -- telling a real visitor their join failed, which is the precise outcome
-- 0185 exists to prevent. The command is therefore replaced in this same
-- migration, and neither change may be shipped without the other.
drop index if exists public.new_client_waitlist_entries_one_waiting_per_email;
create unique index if not exists new_client_waitlist_entries_one_active_per_email
  on public.new_client_waitlist_entries (studio_id, email_normalized)
  where status in ('waiting','claimed','invited');

-- ---------------------------------------------------------------------------
-- 5. THE INVITATION RECORD
-- ---------------------------------------------------------------------------
-- APPEND-ONLY PROVENANCE. Rows are never deleted and never rewritten; the
-- terminal timestamps are write-once. "Who was invited, when, by whom, and
-- what happened to it" is the operational history the entry row cannot keep
-- across re-invitation.
--
-- NO PLAINTEXT TOKEN, EVER. Only the SHA-256 hex digest is stored. The raw
-- value is returned ONCE by the issuing command and lives in no column, no
-- log and no index -- the 0090/0091 doctrine, where the raw cancellation
-- token was ultimately dropped from storage entirely.
create table if not exists public.new_client_waitlist_invitations (
  id            uuid primary key default gen_random_uuid(),
  studio_id     uuid not null references public.studios(id) on delete cascade,
  entry_id      uuid not null,

  -- SHA-256 hex of the raw token. Never the raw token.
  token_hash    text not null,

  -- SERVER-OWNED TIME. Both are forced by the BEFORE INSERT trigger below
  -- rather than defaulted: `default now()` only applies when the caller omits
  -- the column, and the only writer is a SECURITY DEFINER command whose author
  -- could otherwise backdate an issue or extend an expiry.
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null,

  issued_by_practitioner_id uuid not null,

  -- TERMINAL EVIDENCE. Exactly one of these may ever be set; whichever is set
  -- makes the token permanently unusable.
  redeemed_at   timestamptz,
  expired_at    timestamptz,
  released_at   timestamptz,

  constraint new_client_waitlist_invitations_entry_same_studio_fk
    foreign key (entry_id, studio_id)
    references public.new_client_waitlist_entries (id, studio_id) on delete cascade,

  constraint new_client_waitlist_invitations_issuer_same_studio_fk
    foreign key (issued_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict
);

-- TOKEN SHAPE. 64 lowercase hex characters, i.e. a SHA-256 digest and nothing
-- else. A short, non-hex or uppercase value cannot be stored at all.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_token_hash_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_token_hash_check
  check (token_hash ~ '^[a-f0-9]{64}$');

-- BOUNDED TTL, ENFORCED AT THE AUTHORITY.
-- Product ruling: default 72 hours, HARD MAXIMUM 7 days. A later per-studio
-- setting may NARROW the window; exceeding this ceiling requires a new product
-- decision and therefore a new migration. The ceiling lives here because the
-- application's copy of a bound is a courtesy, not a guarantee.
--
-- NOTE: this constraint also fires on UPDATE, so an existing invitation's
-- `expires_at` cannot be quietly pushed outward -- there is no silent renewal
-- or extension. Expiry is recorded by setting `expired_at`, never by moving
-- `expires_at`.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_ttl_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_ttl_check
  check (expires_at > issued_at and expires_at <= issued_at + interval '7 days');

-- AT MOST ONE TERMINAL OUTCOME. A row cannot be both redeemed and released.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_one_outcome_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_one_outcome_check
  check (
    (redeemed_at is not null)::int
    + (expired_at is not null)::int
    + (released_at is not null)::int <= 1
  );

-- A TOKEN IS GLOBALLY UNIQUE. Redemption looks a token up by hash alone, so
-- two invitations must never share one, in this studio or any other.
create unique index if not exists new_client_waitlist_invitations_token_hash_uniq
  on public.new_client_waitlist_invitations (token_hash);

-- NO DUPLICATE ACTIVE INVITATION. At most one LIVE invitation per entry, so a
-- second invitation cannot be issued while one is outstanding -- the structural
-- half of "no silent renewal".
create unique index if not exists new_client_waitlist_invitations_one_live_per_entry
  on public.new_client_waitlist_invitations (entry_id)
  where redeemed_at is null and expired_at is null and released_at is null;

create index if not exists new_client_waitlist_invitations_studio_issued_idx
  on public.new_client_waitlist_invitations (studio_id, issued_at desc, id);

-- ---------------------------------------------------------------------------
-- 6. INVITATION TRIGGERS
-- ---------------------------------------------------------------------------
create or replace function public.new_client_waitlist_invitations_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Issue time is the server's, never the caller's.
  new.issued_at := now();
  return new;
end;
$$;

drop trigger if exists new_client_waitlist_invitations_server_timestamps
  on public.new_client_waitlist_invitations;
create trigger new_client_waitlist_invitations_server_timestamps
  before insert on public.new_client_waitlist_invitations
  for each row execute function public.new_client_waitlist_invitations_server_timestamps();

-- APPEND-ONLY. Identity, tenancy, the token and the window are frozen after
-- insert; the three terminal timestamps are WRITE-ONCE. Without the write-once
-- half, a redeemed invitation could be quietly un-redeemed and replayed.
create or replace function public.new_client_waitlist_invitations_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.studio_id is distinct from old.studio_id
     or new.entry_id is distinct from old.entry_id
     or new.token_hash is distinct from old.token_hash
     or new.issued_at is distinct from old.issued_at
     or new.expires_at is distinct from old.expires_at
     or new.issued_by_practitioner_id is distinct from old.issued_by_practitioner_id then
    raise exception
      'new_client_waitlist_invitations: identity, tenancy, token and validity window are immutable; there is no renewal or extension'
      using errcode = 'check_violation';
  end if;

  if (old.redeemed_at is not null and new.redeemed_at is distinct from old.redeemed_at)
     or (old.expired_at is not null and new.expired_at is distinct from old.expired_at)
     or (old.released_at is not null and new.released_at is distinct from old.released_at) then
    raise exception
      'new_client_waitlist_invitations: a terminal outcome is recorded once and cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists new_client_waitlist_invitations_append_only
  on public.new_client_waitlist_invitations;
create trigger new_client_waitlist_invitations_append_only
  before update on public.new_client_waitlist_invitations
  for each row execute function public.new_client_waitlist_invitations_append_only();

-- PROVENANCE SURVIVES. An invitation is never deleted; its history is the
-- audit record. (Entry deletion cascades, but no entry-delete path exists.)
create or replace function public.new_client_waitlist_invitations_no_delete()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'new_client_waitlist_invitations: invitations are append-only provenance and are never deleted'
    using errcode = 'check_violation';
end;
$$;

drop trigger if exists new_client_waitlist_invitations_no_delete
  on public.new_client_waitlist_invitations;
create trigger new_client_waitlist_invitations_no_delete
  before delete on public.new_client_waitlist_invitations
  for each row execute function public.new_client_waitlist_invitations_no_delete();

-- ---------------------------------------------------------------------------
-- 7. THE ENTRY TRANSITION GUARD, REPLACED
-- ---------------------------------------------------------------------------
-- 0185 anticipated this replacement in its own text: `converted` had no legal
-- transition there, and it said the slice that performs real conversions
-- "replaces this function and states its own rule". This is that rule.
--
-- CARRIED FORWARD VERBATIM from 0185, because none of it stopped being true:
-- identity and tenancy are immutable, contact details are immutable (there is
-- still no correction command), and removal evidence is write-once.
--
-- THE REMOVAL RULING IS STRUCTURAL HERE. A CLAIMED or INVITED entry has NO
-- edge to `removed`. To remove such a prospect an operator must first RELEASE
-- (or expire) the active claim/invitation -- a transition that invalidates the
-- token in the same statement -- and only then remove. It is therefore
-- impossible to remove someone while a usable token for them is outstanding.
--
-- EVIDENCE CANNOT BE REWRITTEN IN PLACE. If `status` does not change, no
-- evidence column may change either. Guarding only the status column would
-- leave the 0183 hole: an UPDATE that leaves `status` alone changes no guarded
-- field and could quietly re-attribute a claim or move a conversion.
create or replace function public.new_client_waitlist_entries_transition_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
  v_legal boolean;
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

  if new.status is distinct from old.status then
    v_legal := (old.status, new.status) in (
      ('waiting',  'claimed'),
      ('waiting',  'removed'),
      ('claimed',  'invited'),
      ('claimed',  'released'),
      ('invited',  'converted'),
      ('invited',  'expired'),
      ('invited',  'released'),
      ('expired',  'released'),
      ('expired',  'waiting'),
      ('expired',  'removed'),
      ('released', 'waiting'),
      ('released', 'removed')
    );

    if not v_legal then
      raise exception
        'new_client_waitlist_entries: illegal lifecycle transition % -> % (a claimed or invited entry must be released or expired before removal)',
        old.status, new.status
        using errcode = 'check_violation';
    end if;
  else
    -- Status unchanged: the record is frozen. Nothing may be re-attributed,
    -- re-timed, or quietly reverted to NULL.
    if new.claimed_at is distinct from old.claimed_at
       or new.claimed_by_practitioner_id is distinct from old.claimed_by_practitioner_id
       or new.invited_at is distinct from old.invited_at
       or new.expired_at is distinct from old.expired_at
       or new.released_at is distinct from old.released_at
       or new.converted_at is distinct from old.converted_at
       or new.converted_client_id is distinct from old.converted_client_id
       or new.removed_at is distinct from old.removed_at
       or new.removed_by_practitioner_id is distinct from old.removed_by_practitioner_id then
      raise exception
        'new_client_waitlist_entries: lifecycle evidence changes only in the statement that performs a legal transition'
        using errcode = 'check_violation';
    end if;
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
-- 8. SHARED AUTHORITY RESOLUTION
-- ---------------------------------------------------------------------------
-- Every operator command below re-derives authority from (studio_id, actor
-- user id). The caller supplies a user id its own session already
-- authenticated, and NEVER a role. Written once so eight commands cannot drift
-- from each other.
create or replace function public.new_client_waitlist_resolve_owner(
  p_studio_id     uuid,
  p_actor_user_id uuid
)
returns table (practitioner_id uuid, code text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id   uuid;
  v_role text;
begin
  if p_studio_id is null or p_actor_user_id is null then
    return query select null::uuid, 'invalid_input'::text;
    return;
  end if;

  select p.id, p.role
    into v_id, v_role
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id   = p_actor_user_id
     and p.active    = true
   limit 1;

  if v_id is null then
    return query select null::uuid, 'not_a_member'::text;
    return;
  end if;
  if v_role <> 'owner' then
    return query select null::uuid, 'not_owner'::text;
    return;
  end if;

  return query select v_id, 'ok'::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 1 — PUBLIC JOIN, REPLACED (coupled to the widened index, section 4)
-- ---------------------------------------------------------------------------
-- Signature and ACL are BYTE-IDENTICAL to 0185. Exactly two things change, and
-- they must change together with the index:
--   * the ON CONFLICT arbiter predicate now names the same active set as the
--     index it infers;
--   * the read-back now looks for any ACTIVE row, not only a `waiting` one.
-- Without the second change a prospect who re-submits while claimed or invited
-- is told 'unknown' -- that they failed to join a list they are already on.
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
  if v_name = ''
     or length(v_name) > 120
     or v_email = ''
     or length(v_email) > 254
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (v_phone is not null and length(v_phone) > 40) then
    return query select 'invalid_input'::text, null::uuid;
    return;
  end if;

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
    on conflict (studio_id, email_normalized) where status in ('waiting','claimed','invited')
    do nothing
    returning id into v_id;

    if v_id is not null then
      return query select 'created'::text, v_id;
      return;
    end if;

    select e.id into v_id
      from public.new_client_waitlist_entries e
     where e.studio_id        = p_studio_id
       and e.email_normalized = v_email
       and e.status in ('waiting','claimed','invited')
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
-- COMMAND 2 — ATOMIC EXACT-N CLAIM
-- ---------------------------------------------------------------------------
-- Claims up to N waiting entries in QUEUE ORDER, in ONE statement.
--
-- `FOR UPDATE SKIP LOCKED` is the whole concurrency argument. Two operators
-- claiming 5 each at the same instant receive DISJOINT sets: the second skips
-- the rows the first has locked rather than blocking on them or -- far worse --
-- waiting and then re-reading rows that are already spoken for. The guarded
-- `and t.status = 'waiting'` in the UPDATE is the second line of defence for
-- the row that was committed between the candidate scan and the write.
--
-- THIS IS NOT A "SAFE TO INVITE N" CLAIM. It moves exactly the number of rows
-- the operator asked for, in the order they joined, and reports how many it
-- actually got. Nothing here models capacity, and nothing infers that N is a
-- responsible number to invite.
create or replace function public.claim_new_client_waitlist_entries(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_count         integer
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid;
    return;
  end if;

  if p_count is null or p_count < 1 or p_count > 100 then
    return query select 'invalid_count'::text, null::uuid;
    return;
  end if;

  return query
  with candidates as (
    select e.id
      from public.new_client_waitlist_entries e
     where e.studio_id = p_studio_id
       and e.status    = 'waiting'
     order by e.joined_at, e.id
     limit p_count
     for update skip locked
  ),
  claimed as (
    update public.new_client_waitlist_entries t
       set status                     = 'claimed',
           claimed_at                 = now(),
           claimed_by_practitioner_id = v_actor
      from candidates c
     where t.id        = c.id
       and t.studio_id = p_studio_id
       and t.status    = 'waiting'
    returning t.id
  )
  select 'claimed'::text, claimed.id from claimed;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 3 — CLAIM ONE NAMED ENTRY
-- ---------------------------------------------------------------------------
-- The targeted counterpart of COMMAND 2, for an operator acting on a specific
-- person rather than the head of the queue. The guarded UPDATE is the decision:
-- two concurrent callers produce exactly one 'claimed' and one 'not_waiting'.
create or replace function public.claim_new_client_waitlist_entry(
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
  v_actor uuid;
  v_code  text;
  v_hit   uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  update public.new_client_waitlist_entries
     set status                     = 'claimed',
         claimed_at                 = now(),
         claimed_by_practitioner_id = v_actor
   where id        = p_entry_id
     and studio_id = p_studio_id
     and status    = 'waiting'
  returning id into v_hit;

  if v_hit is not null then return 'claimed'; end if;

  if not exists (select 1 from public.new_client_waitlist_entries e
                  where e.id = p_entry_id and e.studio_id = p_studio_id) then
    return 'not_found';
  end if;
  return 'not_waiting';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 4 — ISSUE AN INVITATION
-- ---------------------------------------------------------------------------
-- Generates 256 bits from the CSPRNG, stores ONLY its SHA-256 digest, and
-- returns the raw token exactly once to its caller. The raw value is never
-- written to any column.
--
-- TTL: default 72 hours, hard ceiling 7 days (the CHECK in section 5 is the
-- authority; this bound is the same number stated where the caller can see it).
-- There is no renewal path: issuing while a live invitation exists is refused
-- by the one-live-per-entry index AND by the explicit check below.
--
-- pgcrypto is schema-qualified because SECURITY DEFINER pins search_path to
-- `pg_catalog, pg_temp`; an unqualified digest() would not resolve.
create or replace function public.issue_new_client_waitlist_invitation(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid,
  p_ttl_hours     integer default 72
)
returns table (result text, raw_token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor   uuid;
  v_code    text;
  v_status  text;
  v_raw     text;
  v_hash    text;
  v_ttl     integer := coalesce(p_ttl_hours, 72);
  v_expires timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::text, null::timestamptz; return;
  end if;
  if p_entry_id is null then
    return query select 'invalid_input'::text, null::text, null::timestamptz; return;
  end if;
  -- 1 hour .. 7 days. Out of range is REFUSED, never silently clamped: a
  -- clamped TTL is a window the caller did not ask for and cannot see.
  if v_ttl < 1 or v_ttl > 168 then
    return query select 'invalid_ttl'::text, null::text, null::timestamptz; return;
  end if;

  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  if v_status is null then
    return query select 'not_found'::text, null::text, null::timestamptz; return;
  end if;
  if v_status <> 'claimed' then
    return query select 'not_claimed'::text, null::text, null::timestamptz; return;
  end if;

  if exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.entry_id = p_entry_id
       and i.redeemed_at is null and i.expired_at is null and i.released_at is null
  ) then
    return query select 'already_invited'::text, null::text, null::timestamptz; return;
  end if;

  v_raw     := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash    := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  v_expires := now() + make_interval(hours => v_ttl);

  insert into public.new_client_waitlist_invitations
    (studio_id, entry_id, token_hash, expires_at, issued_by_practitioner_id)
  values
    (p_studio_id, p_entry_id, v_hash, v_expires, v_actor);

  update public.new_client_waitlist_entries
     set status = 'invited', invited_at = now()
   where id = p_entry_id and studio_id = p_studio_id and status = 'claimed';

  return query select 'invited'::text, v_raw, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 5 — REDEEM AN INVITATION
-- ---------------------------------------------------------------------------
-- ONE STATEMENT DECIDES. The guarded UPDATE is the decision: concurrent
-- redemptions of the same token produce exactly one winner, and every invalid
-- case -- replayed, expired, released, forged -- produces the SAME zero-row
-- outcome and therefore the SAME result code. The caller cannot distinguish
-- them, so this command is not an oracle for which tokens ever existed.
--
-- TTL IS EVALUATED HERE, against server time, inside the same statement that
-- consumes the token. There is no read-then-decide window in which an expiry
-- could pass.
--
-- WHAT THIS DOES NOT DO: it creates no appointment, no client, no intake and
-- no session, and holds no privilege that could. It returns the studio and
-- entry so the caller may show legal consultation slots; the booking itself
-- remains the canonical public appointment authority's job.
create or replace function public.redeem_new_client_waitlist_invitation(
  p_raw_token text
)
returns table (result text, studio_id uuid, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_entry  uuid;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  update public.new_client_waitlist_invitations i
     set redeemed_at = now()
   where i.token_hash  = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.expires_at  > now()
  returning i.studio_id, i.entry_id into v_studio, v_entry;

  if v_studio is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  return query select 'redeemed'::text, v_studio, v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 6 — EXPIRE  |  COMMAND 7 — RELEASE
-- ---------------------------------------------------------------------------
-- Both invalidate the live invitation IN THE SAME STATEMENT that moves the
-- entry, so a token is never usable after its entry has left `invited`. That
-- is what makes the removal ruling enforceable rather than procedural: an
-- entry cannot reach `removed` without passing through one of these.
--
-- Neither is automatic. There is no sweep and no timer anywhere in this file;
-- an expired-by-the-clock invitation simply stops redeeming (COMMAND 5 checks
-- `expires_at > now()`), and an operator records that fact explicitly here.
create or replace function public.expire_new_client_waitlist_invitation(
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
  v_actor uuid;
  v_code  text;
  v_hit   uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  update public.new_client_waitlist_invitations i
     set expired_at = now()
   where i.entry_id = p_entry_id
     and i.studio_id = p_studio_id
     and i.redeemed_at is null and i.expired_at is null and i.released_at is null;

  update public.new_client_waitlist_entries
     set status = 'expired', expired_at = now()
   where id = p_entry_id and studio_id = p_studio_id and status = 'invited'
  returning id into v_hit;

  if v_hit is null then return 'not_invited'; end if;
  return 'expired';
end;
$$;

create or replace function public.release_new_client_waitlist_entry(
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
  v_actor uuid;
  v_code  text;
  v_hit   uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  -- Invalidate any live invitation FIRST, in the same transaction.
  update public.new_client_waitlist_invitations i
     set released_at = now()
   where i.entry_id = p_entry_id
     and i.studio_id = p_studio_id
     and i.redeemed_at is null and i.expired_at is null and i.released_at is null;

  update public.new_client_waitlist_entries
     set status = 'released', released_at = now()
   where id = p_entry_id and studio_id = p_studio_id
     and status in ('claimed','invited','expired')
  returning id into v_hit;

  if v_hit is null then return 'not_releasable'; end if;
  return 'released';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 8 — REQUEUE  |  COMMAND 9 — RECORD CONVERSION
-- ---------------------------------------------------------------------------
-- Requeue returns a released or expired prospect to the pool and CLEARS the
-- cycle evidence, because `waiting` asserts no claim and no invitation. The
-- durable history of what happened to them is not lost: it lives in the
-- append-only invitation rows.
create or replace function public.requeue_new_client_waitlist_entry(
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
  v_actor uuid;
  v_code  text;
  v_hit   uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  update public.new_client_waitlist_entries
     set status                     = 'waiting',
         claimed_at                 = null,
         claimed_by_practitioner_id = null,
         invited_at                 = null,
         expired_at                 = null,
         released_at                = null
   where id = p_entry_id and studio_id = p_studio_id
     and status in ('released','expired')
  returning id into v_hit;

  if v_hit is null then return 'not_requeueable'; end if;
  return 'requeued';
end;
$$;

-- CONVERSION IS RECORDED, NEVER MANUFACTURED. This command does not create a
-- client and cannot: it records that a client which the canonical booking
-- authority already created corresponds to this prospect. The composite FK
-- refuses a client from another studio.
create or replace function public.record_new_client_waitlist_conversion(
  p_studio_id uuid,
  p_entry_id  uuid,
  p_client_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_hit uuid;
begin
  if p_studio_id is null or p_entry_id is null or p_client_id is null then
    return 'invalid_input';
  end if;

  if not exists (select 1 from public.clients c
                  where c.id = p_client_id and c.studio_id = p_studio_id) then
    return 'client_not_found';
  end if;

  update public.new_client_waitlist_entries
     set status              = 'converted',
         converted_at        = now(),
         converted_client_id = p_client_id
   where id = p_entry_id and studio_id = p_studio_id and status = 'invited'
  returning id into v_hit;

  if v_hit is null then return 'not_invited'; end if;
  return 'converted';
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 10 — OPERATOR REMOVAL, REPLACED
-- ---------------------------------------------------------------------------
-- 0185's body refused anything that was not `waiting` with 'not_waiting'. Left
-- unchanged, it would have gone partially inoperative the moment this release
-- added `claimed` and `invited`: an owner could not remove those entries at
-- all, and the refusal would have looked like a bug rather than a rule.
--
-- The removal ruling is enforced here AND structurally by the transition guard:
-- claimed/invited have no edge to `removed`, so this command names the
-- releasable states explicitly and tells the caller what to do instead.
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
  v_actor  uuid;
  v_code   text;
  v_status text;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  if v_status is null then return 'not_found'; end if;
  if v_status = 'removed' then return 'already_removed'; end if;

  -- The ruling, stated as a distinguishable result code so the UI can tell the
  -- operator to release first rather than reporting a generic failure.
  if v_status in ('claimed','invited') then return 'release_required'; end if;
  if v_status = 'converted' then return 'not_removable'; end if;

  update public.new_client_waitlist_entries
     set status                     = 'removed',
         removed_at                 = now(),
         removed_by_practitioner_id = v_actor
   where id = p_entry_id
     and studio_id = p_studio_id
     and status in ('waiting','released','expired');

  return 'removed';
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------
-- READ-ONLY, OWNER-ONLY, OWN STUDIO -- the same shape 0185 gave the entries
-- table. Exactly ONE policy and it is a SELECT policy: no insert, update or
-- delete policy exists for any role, so a widened table grant alone still
-- could not produce a browser-reachable write. The two would have to fail
-- together.
--
-- The predicate is FULLY QUALIFIED. 0126 wrote the equivalent clause with a
-- bare column name, PostgreSQL resolved it against the wrong relation, and the
-- check silently degraded to a tautology that 0127 had to repair in production.
alter table public.new_client_waitlist_invitations enable row level security;

drop policy if exists "new_client_waitlist_invitations_owner_select"
  on public.new_client_waitlist_invitations;
create policy "new_client_waitlist_invitations_owner_select"
  on public.new_client_waitlist_invitations for select to authenticated
  using (public.is_studio_owner(new_client_waitlist_invitations.studio_id));

-- ---------------------------------------------------------------------------
-- 10. GRANTS
-- ---------------------------------------------------------------------------
-- REVOKE ALL FIRST, THEN GRANT BACK BY NAME. Supabase's ALTER DEFAULT
-- PRIVILEGES grants EXECUTE to anon, authenticated AND service_role at
-- function-create time, and PostgreSQL grants to PUBLIC. 0183 stated its
-- contract as an allowlist but enforced it as a denylist, so PostgreSQL 17's
-- MAINTAIN -- a privilege no by-name revoke list written earlier could have
-- named -- survived into production and 0184 had to repair it. REVOKE ALL is
-- the only form that cannot fail by enumeration.
--
-- The token hash never leaves the database through this grant: `authenticated`
-- can SELECT the invitation row, but the raw token exists only in the single
-- return value of COMMAND 4 and is stored nowhere.
revoke all on public.new_client_waitlist_invitations from public;
revoke all on public.new_client_waitlist_invitations from anon;
revoke all on public.new_client_waitlist_invitations from authenticated;
revoke all on public.new_client_waitlist_invitations from service_role;
grant select on public.new_client_waitlist_invitations to authenticated;

-- COMMANDS: service_role ONLY. The browser is `anon` on the public path and
-- `authenticated` on the operator path; neither holds EXECUTE on any command
-- here, so every transition goes through a server action holding the service
-- key. Each signature is revoked from all four grantees by name before its one
-- grant, so the grant guards can read the contract textually.
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from public;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from anon;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from authenticated;
revoke execute on function public.join_new_client_waitlist(uuid, text, text, text) from service_role;
grant  execute on function public.join_new_client_waitlist(uuid, text, text, text) to service_role;

revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;
grant  execute on function public.remove_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

revoke execute on function public.claim_new_client_waitlist_entries(uuid, uuid, integer) from public;
revoke execute on function public.claim_new_client_waitlist_entries(uuid, uuid, integer) from anon;
revoke execute on function public.claim_new_client_waitlist_entries(uuid, uuid, integer) from authenticated;
revoke execute on function public.claim_new_client_waitlist_entries(uuid, uuid, integer) from service_role;
grant  execute on function public.claim_new_client_waitlist_entries(uuid, uuid, integer) to service_role;

revoke execute on function public.claim_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke execute on function public.claim_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke execute on function public.claim_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke execute on function public.claim_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;
grant  execute on function public.claim_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from public;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from anon;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from authenticated;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from service_role;
grant  execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) to service_role;

revoke execute on function public.redeem_new_client_waitlist_invitation(text) from public;
revoke execute on function public.redeem_new_client_waitlist_invitation(text) from anon;
revoke execute on function public.redeem_new_client_waitlist_invitation(text) from authenticated;
revoke execute on function public.redeem_new_client_waitlist_invitation(text) from service_role;
grant  execute on function public.redeem_new_client_waitlist_invitation(text) to service_role;

revoke execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from public;
revoke execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from anon;
revoke execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from authenticated;
revoke execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from service_role;
grant  execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) to service_role;

revoke execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;
grant  execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

revoke execute on function public.requeue_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke execute on function public.requeue_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke execute on function public.requeue_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke execute on function public.requeue_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;
grant  execute on function public.requeue_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

revoke execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from public;
revoke execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from anon;
revoke execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from authenticated;
revoke execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from service_role;
grant  execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) to service_role;

-- INTERNAL ONLY, GRANTED TO NOBODY. The authority helper is called from inside
-- SECURITY DEFINER bodies (which run as the function owner), and the trigger
-- functions only ever run as triggers -- an EXECUTE grant on one is inert
-- (PostgreSQL does not check EXECUTE when firing a trigger), so the grant is
-- removed rather than relied upon.
revoke all privileges on function public.new_client_waitlist_resolve_owner(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all privileges on function public.new_client_waitlist_entries_transition_guard()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.new_client_waitlist_invitations_server_timestamps()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.new_client_waitlist_invitations_append_only()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.new_client_waitlist_invitations_no_delete()
  from public, anon, authenticated, service_role;

commit;
