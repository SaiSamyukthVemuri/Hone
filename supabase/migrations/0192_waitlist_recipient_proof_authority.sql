-- ---------------------------------------------------------------------------
-- 0192 — WAIT-03B RECIPIENT-PROOF AUTHORITY (B1 … B1.5c)
-- ---------------------------------------------------------------------------
--
-- WHAT THIS IS. The accepted WAIT-03B database authority, landed as one
-- migration. It was developed and proven as four UNNUMBERED prototypes under
-- docs/proposed/prototypes/ (B1 scoped offer + allowance, B2's two DB
-- dependencies, B1.5 recipient proof, B1.5b/c the proof gate). Proving a
-- prototype on a disposable database is not numbered-chain proof, so the
-- authority is restated here, in its FINAL accepted shape, and proven again
-- against the real chain.
--
-- THIS FILE WRITES THE END STATE, NOT THE HISTORY. The prototype sequence
-- created a bare-token `decline_(text)`, a three-argument
-- `complete_waitlist_invitation_proof(text,text,integer)` and a read-only
-- `validate_waitlist_invitation_proof(text,text)` and then removed all three.
-- Replaying that inside one transaction would create three bearer-reachable or
-- caller-authoritative surfaces and drop them again in the same breath. They
-- are therefore never created; the matching `drop … if exists` statements are
-- kept so this migration also CONVERGES a database on which a prototype was
-- applied by hand. On a fresh chain they are no-ops.
--
-- THE TWO CAPABILITIES THIS SLICE KEEPS APART, which is the whole point:
--   A. POSSESSION of the invitation URL  -> may VIEW the offer, may REQUEST proof.
--   B. VERIFIED RECIPIENT capability     -> may BOOK or DECLINE this invitation.
-- Holding the bearer URL alone can do neither B thing. The gate lives INSIDE
-- the mutating command, in the same locked transaction, so it cannot be
-- side-stepped by choosing a different entry point.
--
-- WHY PROOF STATE LIVES ON THE INVITATION ROW rather than in its own table:
-- it makes four required invariants STRUCTURAL instead of merely checked.
-- A challenge cannot address another invitation (there is nowhere else to put
-- it); a newer challenge REPLACES the older in the same columns, so a stale one
-- stops matching the instant a new one is minted; and every validation requires
-- the invitation to be live, so revoke, release, decline, expiry and reissue
-- invalidate proof automatically — a reissue creates a NEW row and the old
-- proof dies with the old one. A separate table would need a partial unique
-- index, explicit cross-invitation checks and a live-join on every validate to
-- reach the same guarantees.
--
-- NO PLAINTEXT CREDENTIAL IS EVER PERSISTED. Only sha256 hex digests are
-- stored. The raw challenge and the raw capability each exist in exactly one
-- server response and are written nowhere, so a leaked database row cannot be
-- replayed into either capability.
--
-- NOT HERE, DELIBERATELY: booking-time commit validation and scope-bound
-- appointments (G7), invitation delivery authority (G8), and every server,
-- browser and email concern. This migration adds no application caller.
-- ---------------------------------------------------------------------------

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- 1. ROUND ALLOWANCE. Owner-set, explicit, with NO default live value:
--    a NULL allowance means "no round is open", not "unlimited".
-- ---------------------------------------------------------------------
-- ARCHITECTURE CORRECTION FOUND BY THE B1 PROOF, preserved here because the
-- reasoning is the load-bearing part. The allowance was first added as a column
-- on public.studios. That is unsafe: `anon` and `authenticated` already hold
-- TABLE-level UPDATE on studios, and PostgreSQL cannot revoke a single column
-- from a table-level grant — the attempted `revoke update (col)` silently left
-- anon/authenticated able to write it. Protecting it would have required
-- revoking table UPDATE on studios and re-granting every other column, a large
-- blast radius on an existing table. The allowance therefore lives in its OWN
-- table, which starts with no grants at all and needs no privilege surgery
-- anywhere else.
create table if not exists public.studio_waitlist_admission_rounds (
  studio_id  uuid primary key references public.studios(id) on delete cascade,
  allowance  integer not null,
  updated_at timestamptz not null default now(),
  constraint studio_waitlist_admission_rounds_allowance_check check (allowance >= 0)
);

alter table public.studio_waitlist_admission_rounds enable row level security;

revoke all on public.studio_waitlist_admission_rounds from public;
revoke all on public.studio_waitlist_admission_rounds from anon;
revoke all on public.studio_waitlist_admission_rounds from authenticated;
revoke all on public.studio_waitlist_admission_rounds from service_role;
grant select (studio_id, allowance, updated_at)
  on public.studio_waitlist_admission_rounds to authenticated;

-- IDEMPOTENT, like every applied migration in this repo. Without the drop,
-- re-applying aborts the transaction here and every later statement — including
-- the scope constraint — is silently skipped. That is exactly how the first
-- negative-control restore failed without anyone noticing.
drop policy if exists "studio_waitlist_admission_rounds_owner_select"
  on public.studio_waitlist_admission_rounds;
create policy "studio_waitlist_admission_rounds_owner_select"
  on public.studio_waitlist_admission_rounds for select to authenticated
  using (public.is_studio_owner(studio_id));

comment on table public.studio_waitlist_admission_rounds is
  'WAIT-03B: explicit per-round manual intake allowance, set by the owner. '
  'A studio with NO ROW here has no open round and no invitation may issue. '
  'It is never defaulted to a live number and never inferred from calendar '
  'emptiness. Deliberately its own table: a new column on studios would '
  'inherit the browser-reachable table-level UPDATE grant anon/authenticated '
  'already hold, and a column-level revoke cannot remove a table-level grant.';

-- ---------------------------------------------------------------------
-- 2. OFFER SCOPE + DECLINE OUTCOME on the invitation.
--    Scope is stored server-side so a substituted URL parameter, service or
--    date cannot widen permission: the commit path re-reads these columns.
-- ---------------------------------------------------------------------
alter table public.new_client_waitlist_invitations
  add column if not exists scope_service_id      uuid,
  add column if not exists scope_start_date      date,
  add column if not exists scope_end_date        date,
  add column if not exists scope_allowed_weekdays smallint[],
  add column if not exists declined_at           timestamptz;

-- Tenancy: the offered service must belong to the SAME studio as the
-- invitation. Composite FK, the same shape 0188 uses for entry and issuer.
-- `services_id_studio_id_unique` already exists (0032); the guard keeps this
-- file correct against a database where it does not.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.services'::regclass
       and contype  = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (id, studio_id)'
  ) then
    alter table public.services
      add constraint services_id_studio_id_unique unique (id, studio_id);
  end if;
end $$;

alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_service_same_studio_fk;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_service_same_studio_fk
  foreign key (scope_service_id, studio_id)
  references public.services (id, studio_id) on delete restrict;

-- ALL-OR-NOTHING. A partially-scoped invitation is an unenforceable
-- permission, so it is unrepresentable rather than merely discouraged.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_complete_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_complete_check
  check (
    (scope_service_id is null and scope_start_date is null and scope_end_date is null
     and scope_allowed_weekdays is null)
    or
    (scope_service_id is not null and scope_start_date is not null
     and scope_end_date is not null and scope_start_date <= scope_end_date)
  );

-- Allowed weekdays, when present, must be a non-empty subset of 0..6
-- (extract(dow): 0 = Sunday). NULL means "every day inside the range"; an
-- EMPTY array authorises nothing and is refused here rather than silently
-- read as "all days" by a later consumer.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_scope_weekdays_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_scope_weekdays_check
  check (
    scope_allowed_weekdays is null
    or (
      array_length(scope_allowed_weekdays, 1) between 1 and 7
      and scope_allowed_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]
      -- DISTINCTNESS IS NOT CHECKED HERE, DELIBERATELY. PostgreSQL forbids a
      -- subquery in a CHECK, and duplicates are semantically inert: membership
      -- is tested with <@ / = ANY, so [2,2,4] and [2,4] authorise the same days.
      -- The issue command canonicalises to a sorted DISTINCT array on write, so
      -- duplicates cannot arise through the supported path.
    )
  );

-- A decline is a terminal outcome and cannot coexist with another one.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_one_terminal_outcome_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_one_terminal_outcome_check
  check (
    (case when redeemed_at is not null then 1 else 0 end
     + case when expired_at  is not null then 1 else 0 end
     + case when released_at is not null then 1 else 0 end
     + case when declined_at is not null then 1 else 0 end) <= 1
  );

-- ---------------------------------------------------------------------
-- 3. LIVENESS now accounts for decline.
--    0188's index treated only redeemed/expired/released as closed, so a
--    declined invitation would keep blocking the entry forever and decision 5
--    ("a later manual offer remains possible") would be unreachable.
-- ---------------------------------------------------------------------
drop index if exists public.new_client_waitlist_invitations_one_live_per_entry;
create unique index if not exists new_client_waitlist_invitations_one_live_per_entry
  on public.new_client_waitlist_invitations (entry_id)
  where redeemed_at is null and expired_at is null
    and released_at is null and declined_at is null;

-- "No immediate re-invitation to the SAME declined round", without inventing a
-- time-based exclusion: the identical offer cannot be re-issued to the same
-- entry while that declined record stands. A DIFFERENT offer is unaffected.
--
-- P3-2 CORRECTION, preserved. The key omitted scope_allowed_weekdays, so two
-- genuinely different offers — same service and dates, different permitted
-- weekdays — collided and the second was refused. The key must name every field
-- that defines the SAME LOGICAL OFFER.
--
-- NULLS NOT DISTINCT is required, not incidental. Adding a nullable column to a
-- unique index would otherwise WEAKEN the guard: PostgreSQL treats NULLs as
-- distinct by default, so two identical all-days offers (weekdays NULL) would
-- stop colliding — the opposite of the intent. PG15+; this stack is 17.
--
-- NULL and array[0,1,2,3,4,5,6] remain DIFFERENT keys. The contract defines
-- NULL as "every day inside the range" but does NOT define it as equivalent to
-- the explicit full array, so they are not made equivalent here.
--
-- Weekday ordering is already canonical: the issue command writes a sorted
-- DISTINCT array, so array equality is well defined on the supported path.
drop index if exists public.new_client_waitlist_invitations_no_repeat_declined_offer;
create unique index if not exists new_client_waitlist_invitations_no_repeat_declined_offer
  on public.new_client_waitlist_invitations
     (entry_id, scope_service_id, scope_start_date, scope_end_date, scope_allowed_weekdays)
  nulls not distinct
  where declined_at is not null;

-- ---------------------------------------------------------------------
-- 4. ADMISSION ACCOUNTING.
--    consumed = outstanding permission + permission already spent on a booking.
--    A booked permission stays consumed; it is NOT recycled on cancellation.
-- ---------------------------------------------------------------------
create or replace function public.waitlist_admission_consumed(p_studio_id uuid)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select
    (
      -- outstanding: live invitations whose response window has not passed
      select count(*)
        from public.new_client_waitlist_invitations i
       where i.studio_id   = p_studio_id
         and i.redeemed_at is null
         and i.expired_at  is null
         and i.released_at is null
         and i.declined_at is null
         and i.expires_at  > clock_timestamp()
    )
    +
    (
      -- spent: entries converted after redeeming an invitation
      select count(distinct e.id)
        from public.new_client_waitlist_entries e
        join public.new_client_waitlist_invitations i
          on i.entry_id = e.id and i.studio_id = e.studio_id
       where e.studio_id = p_studio_id
         and e.status    = 'converted'
         and i.redeemed_at is not null
    )
$$;

comment on function public.waitlist_admission_consumed(uuid) is
  'WAIT-03B: admission permission consumed for a studio. Outstanding live '
  'invitations plus permissions already spent on a booking. A declined or '
  'expired invitation frees permission; a booked one does not, and is not '
  'recycled when an appointment is later cancelled.';

-- ---------------------------------------------------------------------
-- 4b. THE DELEGATED ISSUER LEARNS THAT A DECLINED INVITATION IS CLOSED.
--
-- REVIEW FINDING (P1). 0192 adds `declined_at` and redefines
-- `..._one_live_per_entry` so a declined invitation stops blocking its entry —
-- that index is what makes decision 5, "a later manual offer remains
-- possible", representable at all. But the issuance authority this slice
-- DELEGATES to still carried 0190's liveness test:
--
--     i.redeemed_at is null and i.expired_at is null and i.released_at is null
--
-- `declined_at` is absent, so the historical declined row still matched and
-- issuance answered `already_invited`. REPRODUCED end to end before repair:
-- issue -> decline -> requeue -> claim -> issue a GENUINELY DIFFERENT offer
-- returned `already_invited`, so a declined entry could never receive another
-- offer of any kind. The index permitted the flow the command refused.
--
-- 0190's FILE IS FROZEN AND IS NOT EDITED. This is a forward redefinition, the
-- same mechanism 0189 and 0190 each used on this function. The body below is
-- 0190's, byte for byte, with ONE predicate extended — the TTL anchor 0190
-- exists to fix (`v_decision_at`, read after the entry mutex, used for
-- issued_at, expires_at and invited_at alike) is carried through unchanged.
-- ---------------------------------------------------------------------
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
  v_decision_at timestamptz;
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

  -- LOCK ORDER: the ENTRY first. Every command in this lifecycle takes the
  -- entry mutex before touching invitations; 0192 keeps that order everywhere.
  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  -- THE CANONICAL ISSUANCE INSTANT, READ AFTER THE MUTEX. This single value is
  -- the authority for the invitation's issued_at, the window it opens, and the
  -- entry's invited_at. Nothing on this path reads a clock again: two reads
  -- microseconds apart would put the row's own stamps out of step, which is the
  -- defect class 0189 removed one layer up.
  v_decision_at := clock_timestamp();

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
       -- THE ONE CHANGED LINE. A declined invitation is CLOSED, exactly as
       -- `..._one_live_per_entry` already treats it.
       and i.declined_at is null
  ) then
    return query select 'already_invited'::text, null::text, null::timestamptz; return;
  end if;

  v_raw     := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash    := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  -- The window starts when the invitation is ISSUED, not when this transaction
  -- happened to begin. Previously `now() + ttl`, which handed back a window
  -- already shortened by the transaction's age.
  v_expires := v_decision_at + make_interval(hours => v_ttl);

  insert into public.new_client_waitlist_invitations
    (studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id)
  values
    (p_studio_id, p_entry_id, v_hash, v_decision_at, v_expires, v_actor);

  update public.new_client_waitlist_entries
     set status = 'invited', invited_at = v_decision_at
   where id = p_entry_id and studio_id = p_studio_id and status = 'claimed';

  return query select 'invited'::text, v_raw, v_expires;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. SCOPED ISSUE COMMAND.
--    Wraps the applied issue_ command rather than duplicating token minting.
--    Lock order is studios -> round -> entry -> invitation, matching the
--    existing lifecycle, so this cannot deadlock against
--    release_/requeue_/expire_.
-- ---------------------------------------------------------------------
create or replace function public.issue_scoped_new_client_waitlist_invitation(
  p_studio_id        uuid,
  p_entry_id         uuid,
  p_actor_user_id    uuid,
  p_service_id       uuid,
  p_start_date       date,
  p_end_date         date,
  p_allowed_weekdays smallint[] default null,
  p_ttl_hours        integer default 72
)
returns table (result text, raw_token text, invitation_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_allowance integer;
  v_consumed  integer;
  v_issue     record;
  v_inv_id    uuid;
begin
  -- LOCK ORDER STEP 1: the studio row, then the round row. Serialises two
  -- concurrent issues competing for the final allowance seat.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'unknown_studio'::text, null::text, null::uuid; return;
  end if;

  select r.allowance into v_allowance
    from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id
   for update;

  if v_allowance is null then
    return query select 'no_round_open'::text, null::text, null::uuid; return;
  end if;

  if p_start_date is null or p_end_date is null or p_start_date > p_end_date then
    return query select 'invalid_scope_dates'::text, null::text, null::uuid; return;
  end if;

  if p_service_id is null
     or not exists (select 1 from public.services sv
                     where sv.id = p_service_id and sv.studio_id = p_studio_id) then
    return query select 'invalid_service'::text, null::text, null::uuid; return;
  end if;

  if p_allowed_weekdays is not null then
    if array_length(p_allowed_weekdays, 1) is null
       or not (p_allowed_weekdays <@ array[0,1,2,3,4,5,6]::smallint[]) then
      return query select 'invalid_weekdays'::text, null::text, null::uuid; return;
    end if;
    -- Canonicalise: sorted DISTINCT. This is where duplicate weekdays are
    -- removed, since the CHECK above cannot express distinctness.
    select array_agg(d order by d) into p_allowed_weekdays
      from (select distinct unnest(p_allowed_weekdays) as d) q;
  end if;

  -- THE NO-REPEAT-DECLINED RULE, ENFORCED WHERE IT IS ACTUALLY DECIDED.
  --
  -- SECOND-ORDER FINDING, surfaced by the P1 repair above and reproduced before
  -- this was written. `..._no_repeat_declined_offer` is a partial unique index
  -- over rows WHERE declined_at IS NOT NULL, so it does not fire when an
  -- invitation is ISSUED (declined_at is null then) — only when a SECOND one is
  -- declined. Until the repair, that never happened: the issuer's over-broad
  -- `already_invited` predicate blocked every re-issue after a decline, so the
  -- index was enforced by accident. Teaching the issuer that declined is closed
  -- removed that accident and exposed the real shape:
  --
  --     issue -> decline -> requeue -> claim -> issue the IDENTICAL offer
  --       -> issued, and the second decline then raised a bare 23505
  --
  -- A command in this lifecycle must return a CODE, never raise — 0185 says so
  -- explicitly and the requeue/23505 repair in 0188 is the precedent. So the
  -- rule moves to the point where it is actually a decision: the identical
  -- offer is refused at ISSUE, which is also what B1's own comment always
  -- claimed ("the identical offer cannot be re-issued to the same entry while
  -- that declined record stands"). A DIFFERENT offer is unaffected.
  --
  -- PRE-CHECK IS SOUND HERE, and that is not the general rule. 0188's requeue
  -- lesson is "handle, never pre-check", because a SELECT before an UPDATE
  -- reopens a read-then-write window. There is no window here: this runs under
  -- the STUDIO row lock taken at the top of this function, so two issues for
  -- one studio are serialised, and `..._one_live_per_entry` already forbids a
  -- second LIVE invitation for the entry.
  --
  -- NULLS NOT DISTINCT is mirrored with `is not distinct from`, so a NULL
  -- weekday set compares equal to a NULL weekday set exactly as the index does.
  -- The comparison runs AFTER canonicalisation, so [4,2,2,4] and [2,4] are the
  -- same offer here just as they are there.
  if exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.entry_id    = p_entry_id
       and i.declined_at is not null
       and i.scope_service_id       is not distinct from p_service_id
       and i.scope_start_date       is not distinct from p_start_date
       and i.scope_end_date         is not distinct from p_end_date
       and i.scope_allowed_weekdays is not distinct from p_allowed_weekdays
  ) then
    return query select 'already_declined_offer'::text, null::text, null::uuid; return;
  end if;

  -- ALLOWANCE CHECKED UNDER THE STUDIO LOCK, not before it.
  v_consumed := public.waitlist_admission_consumed(p_studio_id);
  if v_consumed >= v_allowance then
    return query select 'round_full'::text, null::text, null::uuid; return;
  end if;

  -- LOCK ORDER STEP 2/3: the applied command locks the entry and inserts the
  -- invitation. Reusing it keeps ONE token-minting implementation.
  select * into v_issue
    from public.issue_new_client_waitlist_invitation(
           p_studio_id, p_entry_id, p_actor_user_id, p_ttl_hours);

  -- The applied command's SUCCESS literal is 'invited', not 'issued'. Assuming
  -- the wrong word here previously caused a silent early return AFTER issue_
  -- had already created the row, leaving an UNSCOPED invitation live — the
  -- exact invariant this slice exists to hold. Unknown literals now raise
  -- rather than return, so the transaction rolls back instead of leaking one.
  if v_issue.result = 'invited' then
    null;
  elsif v_issue.result in ('already_invited','invalid_input','invalid_ttl','not_claimed','not_found') then
    return query select v_issue.result::text, null::text, null::uuid; return;
  else
    raise exception 'issue_scoped: unrecognised result % from issue_new_client_waitlist_invitation', v_issue.result
      using errcode = 'check_violation';
  end if;

  -- Stamp the scope onto the row just created, inside this same transaction.
  -- 0188's append-only trigger guards identity, tenancy, token and window and
  -- does not forbid these columns, so scope is settable exactly once here.
  update public.new_client_waitlist_invitations i
     set scope_service_id       = p_service_id,
         scope_start_date       = p_start_date,
         scope_end_date         = p_end_date,
         scope_allowed_weekdays = p_allowed_weekdays
   where i.studio_id   = p_studio_id
     and i.entry_id    = p_entry_id
     and i.redeemed_at is null and i.expired_at is null
     and i.released_at is null and i.declined_at is null
  returning i.id into v_inv_id;

  if v_inv_id is null then
    raise exception 'issue_scoped: invitation row not found for scope stamp'
      using errcode = 'check_violation';
  end if;

  return query select 'issued'::text, v_issue.raw_token::text, v_inv_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. READ-ONLY RESOLVER (G4).
--    The applied redeem_ command MUTATES, so a GET, link preview or crawler
--    that reached it would CONSUME the invitation. Rendering safe offer
--    metadata therefore needs a non-mutating resolver. STABLE: it cannot write,
--    and both the planner and the reader know it.
-- ---------------------------------------------------------------------
create or replace function public.resolve_new_client_waitlist_invitation(
  p_raw_token text
)
returns table (
  result                 text,
  invitation_id          uuid,
  studio_id              uuid,
  entry_id               uuid,
  scope_service_id       uuid,
  scope_start_date       date,
  scope_end_date         date,
  scope_allowed_weekdays smallint[],
  expires_at             timestamptz,
  recipient_contact_hash text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    case
      when i.id is null                                     then 'invalid_token'
      when i.redeemed_at is not null                        then 'already_redeemed'
      when i.declined_at is not null                        then 'declined'
      when i.released_at is not null                        then 'released'
      when i.expired_at  is not null                        then 'expired'
      when i.expires_at <= clock_timestamp()                then 'expired'
      when i.scope_service_id is null                       then 'unscoped'
      else 'live'
    end::text,
    i.id, i.studio_id, i.entry_id,
    i.scope_service_id, i.scope_start_date, i.scope_end_date, i.scope_allowed_weekdays,
    i.expires_at,
    -- The STORED contact, hashed. The raw address never leaves the database
    -- through this path, and the server compares hashes, so a substituted typed
    -- email cannot be made to match by echoing it back.
    encode(extensions.digest(lower(btrim(e.email)), 'sha256'), 'hex')
  from (select 1) dummy
  left join public.new_client_waitlist_invitations i
    on p_raw_token ~ '^[a-f0-9]{64}$'
   and i.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  left join public.new_client_waitlist_entries e
    on e.id = i.entry_id and e.studio_id = i.studio_id;
$$;

-- ---------------------------------------------------------------------
-- 7. RECIPIENT-PROOF STATE, held on the invitation row.
-- ---------------------------------------------------------------------
alter table public.new_client_waitlist_invitations
  add column if not exists proof_challenge_id          uuid,
  add column if not exists proof_challenge_hash        text,
  add column if not exists proof_challenge_expires_at  timestamptz,
  add column if not exists proof_challenge_sent_to_hash text,
  add column if not exists proof_challenge_attempts    integer not null default 0,
  add column if not exists proof_capability_hash       text,
  add column if not exists proof_capability_expires_at timestamptz;

-- Only hashes are ever stored. The raw challenge and the raw capability exist
-- in one server response and are never persisted, so a leaked database row
-- cannot be replayed into either capability.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_proof_hash_shape_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_proof_hash_shape_check
  check (
    (proof_challenge_hash is null or proof_challenge_hash ~ '^[a-f0-9]{64}$')
    and (proof_capability_hash is null or proof_capability_hash ~ '^[a-f0-9]{64}$')
    and (proof_challenge_sent_to_hash is null or proof_challenge_sent_to_hash ~ '^[a-f0-9]{64}$')
  );

-- A hash is meaningless without its expiry; storing one without the other would
-- create a credential with no server-clock bound.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_proof_pairing_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_proof_pairing_check
  check (
    -- ONE COHERENT CHALLENGE STATE. The id, the verifier and the expiry are a
    -- single fact about a single challenge, so any two-of-three combination is
    -- unrepresentable rather than merely unlikely: an id with no live challenge
    -- would be an idempotency handle for an event that cannot be completed, and
    -- a challenge with no id would be undeliverable without inventing one.
    (proof_challenge_hash is null) = (proof_challenge_expires_at is null)
    and (proof_challenge_hash is null) = (proof_challenge_id is null)
    and (proof_capability_hash is null) = (proof_capability_expires_at is null)
    and proof_challenge_attempts >= 0
  );

comment on column public.new_client_waitlist_invitations.proof_challenge_id is
  'WAIT-03B: a stable NON-SECRET identity for ONE challenge event, minted fresh '
  'by begin_waitlist_invitation_proof. It exists so a server-side sender can key '
  'provider idempotency on the EVENT rather than on anything derived from the '
  'credential — the defect #680 hit when a proof-send key was derived from a '
  'payload containing the code, making the transmitted header an offline '
  'verifier for it. This column is NOT authority: it proves nothing, verifies '
  'nothing, and grants nothing. It is never granted to a browser role, it is '
  'not derived from the raw challenge, and it dies with the challenge it names.';

comment on column public.new_client_waitlist_invitations.proof_challenge_sent_to_hash is
  'WAIT-03B B1.5: hash of the STORED invited contact, frozen when the challenge '
  'was issued. Editing the entry afterwards cannot retarget an outstanding '
  'challenge, and no browser-supplied address is ever compared.';

-- ---------------------------------------------------------------------
-- 8. COMMAND 1 — BEGIN. Mints a high-entropy challenge (the same 64-hex
--    primitive the invitation token uses; deliberately not a short reusable
--    PIN). Returns the raw challenge and the STORED delivery contact to the
--    SERVER only.
-- ---------------------------------------------------------------------
-- The return type gains `challenge_id` and `issued_at`, and PostgreSQL cannot
-- change a return type in place, so the prior signature is dropped first. On a
-- fresh chain this is a no-op; on re-apply it is what makes this file idempotent.
-- The ARGUMENT list is unchanged, so this same drop still names it.
drop function if exists public.begin_waitlist_invitation_proof(text, integer);

create or replace function public.begin_waitlist_invitation_proof(
  p_raw_token   text,
  p_ttl_minutes integer default 15
)
returns table (
  result           text,
  raw_challenge    text,
  delivery_contact text,
  expires_at       timestamptz,
  challenge_id     uuid,
  -- THE ACTUAL MINT INSTANT, for a server-side delivery caller that has to say
  -- when the code was issued. It is the SAME `v_now` the expiry is computed
  -- from -- the post-lock `clock_timestamp()` this command already decided on --
  -- so `expires_at - issued_at` is exactly the accepted TTL, by construction
  -- rather than by two clocks agreeing. No new column stores it: it is the
  -- decision instant, returned, not remembered.
  issued_at        timestamptz
)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_inv uuid; v_entry uuid; v_studio uuid; v_now timestamptz;
        v_raw text; v_email text; v_cid uuid;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_ttl_minutes is null or p_ttl_minutes <= 0 or p_ttl_minutes > 60 then
    return query select 'invalid_input'::text, null::text, null::text, null::timestamptz, null::uuid, null::timestamptz; return;
  end if;

  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if v_inv is null then
    return query select 'invalid_token'::text, null::text, null::text, null::timestamptz, null::uuid, null::timestamptz; return;
  end if;

  v_now := clock_timestamp();          -- POST-LOCK clock, as 0189 established

  -- POSSESSION may request proof, but only while the invitation is LIVE.
  if not exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.id = v_inv and i.redeemed_at is null and i.expired_at is null
       and i.released_at is null and i.declined_at is null and i.expires_at > v_now
  ) then
    return query select 'not_live'::text, null::text, null::text, null::timestamptz, null::uuid, null::timestamptz; return;
  end if;

  select e.email into v_email
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio;

  v_raw := encode(extensions.gen_random_bytes(32), 'hex');
  -- INDEPENDENT OF THE SECRET, deliberately. Deriving this from v_raw would
  -- make the handle a function of the credential, which is exactly the class of
  -- mistake that turned a provider idempotency header into an offline verifier.
  v_cid := gen_random_uuid();

  -- A NEW challenge REPLACES the old one in place. That is invariant 1: the
  -- previous hash is gone, so an older challenge can never verify afterwards.
  -- Any capability already minted is cleared too — requesting proof again must
  -- not leave an older capability alive.
  update public.new_client_waitlist_invitations
     set proof_challenge_id           = v_cid,
         proof_challenge_hash         = encode(extensions.digest(v_raw,'sha256'),'hex'),
         proof_challenge_expires_at   = v_now + make_interval(mins => p_ttl_minutes),
         proof_challenge_sent_to_hash = encode(extensions.digest(lower(btrim(v_email)),'sha256'),'hex'),
         proof_challenge_attempts     = 0,
         proof_capability_hash        = null,
         proof_capability_expires_at  = null
   where id = v_inv;

  -- `v_now` here is the same value written into proof_challenge_expires_at
  -- above, not a second reading of the clock.
  return query select 'challenge_issued'::text, v_raw, v_email,
                      v_now + make_interval(mins => p_ttl_minutes), v_cid, v_now;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. COMMAND 2 — COMPLETE. Verifies the challenge and mints a short-lived
--    capability bound to THIS invitation.
-- ---------------------------------------------------------------------
-- CAPABILITY TTL IS OWNED BY THE DATABASE at 30 minutes. The caller has no TTL
-- authority at all — there is no argument to get wrong — so a 31-minute
-- capability is not refused at runtime, it is UNREPRESENTABLE. The stale
-- three-argument signature is dropped rather than left beside this one as a
-- second way in; on a fresh chain it never existed and this is a no-op.
drop function if exists public.complete_waitlist_invitation_proof(text, text, integer);

create or replace function public.complete_waitlist_invitation_proof(
  p_raw_token     text,
  p_raw_challenge text
)
returns table (result text, raw_capability text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz; v_cap text; v_live_hash text;
        v_max constant integer := 5;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_challenge is null or p_raw_challenge !~ '^[a-f0-9]{64}$'
     then
    return query select 'invalid_input'::text, null::text, null::timestamptz; return;
  end if;

  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::text, null::timestamptz; return;
  end if;

  v_now := clock_timestamp();

  -- Invitation lifecycle gates the proof. A concurrent revoke that commits
  -- first makes this fail closed rather than minting a capability.
  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_hash is null then
    return query select 'no_challenge'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_expires_at <= v_now then
    return query select 'challenge_expired'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_attempts >= v_max then
    return query select 'too_many_attempts'::text, null::text, null::timestamptz; return;
  end if;

  -- P1-2: the FROZEN recipient hash is READ here. Previously `begin_` wrote it
  -- and nothing compared it, so the column advertised an anti-retargeting
  -- control it did not provide. If the entry's contact changed after the
  -- challenge was issued, the challenge is refused rather than silently
  -- verifying against a different address.
  select encode(extensions.digest(lower(btrim(e.email)),'sha256'),'hex')
    into v_live_hash
    from public.new_client_waitlist_entries e
   where e.id = r.entry_id and e.studio_id = r.studio_id;

  if r.proof_challenge_sent_to_hash is distinct from v_live_hash then
    return query select 'recipient_changed'::text, null::text, null::timestamptz; return;
  end if;

  if r.proof_challenge_hash <> encode(extensions.digest(p_raw_challenge,'sha256'),'hex') then
    update public.new_client_waitlist_invitations
       set proof_challenge_attempts = proof_challenge_attempts + 1 where id = r.id;
    return query select 'wrong_challenge'::text, null::text, null::timestamptz; return;
  end if;

  v_cap := encode(extensions.gen_random_bytes(32), 'hex');

  -- Single use: the challenge is consumed as the capability is minted, so a
  -- successful verification cannot be replayed — here or at another invitation.
  update public.new_client_waitlist_invitations
     set proof_challenge_id          = null,
         proof_challenge_hash        = null,
         proof_challenge_expires_at  = null,
         proof_challenge_attempts    = 0,
         proof_capability_hash       = encode(extensions.digest(v_cap,'sha256'),'hex'),
         proof_capability_expires_at = v_now + interval '30 minutes'
   where id = r.id;

  return query select 'verified'::text, v_cap, v_now + interval '30 minutes';
end;
$$;

-- ---------------------------------------------------------------------
-- 10. COMMAND 3 — INVALIDATE, for lifecycle transitions. Structural
--     invalidation already holds (every validation requires a live
--     invitation); this makes the clearing explicit so a released row does not
--     retain a dead credential at rest.
-- ---------------------------------------------------------------------
create or replace function public.invalidate_waitlist_invitation_proof(
  p_invitation_id uuid
)
returns void
language sql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
  update public.new_client_waitlist_invitations
     set proof_challenge_id = null,
         proof_challenge_hash = null, proof_challenge_expires_at = null,
         proof_challenge_sent_to_hash = null, proof_challenge_attempts = 0,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = p_invitation_id;
$$;

-- ---------------------------------------------------------------------
-- 11. GATED REDEEM. Proof and mutation in ONE locked transaction.
--     The applied 0188/0189 `redeem_(text)` is frozen and not edited; this is a
--     forward command, and the ungated one has its EXECUTE withdrawn below.
-- ---------------------------------------------------------------------
create or replace function public.redeem_new_client_waitlist_invitation_verified(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text, studio_id uuid, entry_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::uuid, null::uuid; return;
  end if;

  -- ONE lock, held across the proof check AND the mutation. A concurrent
  -- revoke either commits first (and we fail closed below) or waits.
  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::uuid, null::uuid; return;
  end if;

  -- THE GATE. Bearer possession got this far and stops here.
  if r.proof_capability_hash is null then
    return query select 'proof_required'::text, null::uuid, null::uuid; return;
  end if;
  if r.proof_capability_expires_at <= v_now then
    return query select 'proof_expired'::text, null::uuid, null::uuid; return;
  end if;
  if r.proof_capability_hash <> encode(extensions.digest(p_raw_capability,'sha256'),'hex') then
    return query select 'proof_invalid'::text, null::uuid, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set redeemed_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  return query select 'redeemed'::text, r.studio_id, r.entry_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 12. GATED DECLINE. The bare-token signature is never created and is dropped
--     if a prototype left one behind: a bearer entry point that still exists is
--     still a bearer path.
--
--     invited -> released is an edge the applied 0188 guard already permits;
--     the accepted requeue_ command then returns the entry to waiting. No new
--     lifecycle edge is invented here.
-- ---------------------------------------------------------------------
drop function if exists public.decline_new_client_waitlist_invitation(text);

create or replace function public.decline_new_client_waitlist_invitation(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text, entry_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz; v_inv uuid; v_entry uuid; v_studio uuid;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;

  -- LOCK ORDER: ENTRY FIRST, THEN INVITATION.
  --
  -- REVIEW FINDING (P2). This command previously took the invitation lock here
  -- and updated the entry at the end, while `release_new_client_waitlist_entry`
  -- and `expire_new_client_waitlist_invitation` both take the ENTRY mutex first
  -- and reach for the invitation second. Two orders over the same pair is a
  -- deadlock cycle: a recipient declining while an operator releases or expires
  -- the same entry could be aborted with 40P01 instead of receiving a closed
  -- lifecycle result. A deadlock is not a refusal — it destroys an otherwise
  -- valid command and tells the caller nothing about the lifecycle.
  --
  -- The entry id is read WITHOUT a lock first, which is sound precisely because
  -- 0188's append-only trigger freezes `entry_id`: it cannot change under us,
  -- so it is safe to use as the lock target before the invitation is pinned.
  -- Everything the decision depends on is re-read AFTER both locks are held.
  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex');
  if v_inv is null then
    return query select 'invalid_token'::text, null::uuid; return;
  end if;

  perform 1 from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio
   for update;

  select * into r from public.new_client_waitlist_invitations i
   where i.id = v_inv
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::uuid; return;
  end if;

  if r.proof_capability_hash is null then
    return query select 'proof_required'::text, null::uuid; return;
  end if;
  if r.proof_capability_expires_at <= v_now then
    return query select 'proof_expired'::text, null::uuid; return;
  end if;
  if r.proof_capability_hash <> encode(extensions.digest(p_raw_capability,'sha256'),'hex') then
    return query select 'proof_invalid'::text, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set declined_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = r.entry_id and studio_id = r.studio_id and status = 'invited';

  return query select 'declined'::text, r.entry_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 13. RETIRE THE UNGATED AND CHECK-THEN-ACT SURFACES.
--
--     The mutation owns capability validation inside its own locked
--     transaction, so a separate read-only oracle is not a caller path. A
--     surviving check-then-act API is exactly the surface B2 was told not to
--     build against, so it is dropped rather than deprecated. Never created on
--     a fresh chain; this converges a prototype database.
-- ---------------------------------------------------------------------
drop function if exists public.validate_waitlist_invitation_proof(text, text);

-- The applied 0188/0189 ungated `redeem_(text)` is FROZEN and not edited — its
-- EXECUTE is withdrawn instead. It has zero runtime callers, so nothing in the
-- application loses a capability it was using.
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from public;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from anon;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from authenticated;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from service_role;

-- REVIEW FINDING (P1). THE UNSCOPED ISSUER IS A BYPASS, and withdrawing the
-- ungated redeem while leaving it reachable was an inconsistency, not a
-- decision. `issue_scoped_…` exists to hold two invariants: no invitation
-- without an OPEN ROUND, and outstanding permission never above the ALLOWANCE.
-- Both live in the wrapper. The four-argument issuer it delegates to answers
-- neither, and it was still granted to `service_role` — so any server path
-- could call it directly, with no round open or the allowance exhausted, and
-- mint an invitation whose scope columns are all NULL. That is precisely the
-- "stored invitation expressing a permission its owner did not grant" this
-- slice exists to make unrepresentable.
--
-- Withdrawn from all four roles BY NAME. The wrapper is unaffected: it is
-- SECURITY DEFINER owned by `postgres`, which owns this function too, so the
-- delegated call is authorised by ownership rather than by a role grant. The
-- accompanying test proves the wrapper still issues AFTER this revoke, so the
-- revoke cannot silently disable the only supported issuance path.
revoke all privileges on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from public;
revoke all privileges on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from anon;
revoke all privileges on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from authenticated;
revoke all privileges on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from service_role;

-- ---------------------------------------------------------------------
-- 14. PRIVILEGES. service_role ONLY, revoked from all four BY NAME first.
--
--     Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
--     authenticated AND service_role at function-create time. An
--     authenticated-only command must revoke from all three explicitly, by
--     name — missed once in 0129 (anon) and again in 0164 (service_role).
--     Nothing here is granted to anon or authenticated: the browser never
--     executes any of these and never writes any of these columns.
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.waitlist_admission_consumed(uuid)',
    'public.issue_scoped_new_client_waitlist_invitation(uuid, uuid, uuid, uuid, date, date, smallint[], integer)',
    'public.resolve_new_client_waitlist_invitation(text)',
    'public.begin_waitlist_invitation_proof(text, integer)',
    'public.complete_waitlist_invitation_proof(text, text)',
    'public.invalidate_waitlist_invitation_proof(uuid)',
    'public.redeem_new_client_waitlist_invitation_verified(text, text)',
    'public.decline_new_client_waitlist_invitation(text, text)'
  ] loop
    execute format('revoke all privileges on function %s from public', f);
    execute format('revoke all privileges on function %s from anon', f);
    execute format('revoke all privileges on function %s from authenticated', f);
    execute format('revoke all privileges on function %s from service_role', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
