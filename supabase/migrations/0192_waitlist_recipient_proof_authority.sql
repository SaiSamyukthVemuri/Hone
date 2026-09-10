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
--
-- A ROUND IS A DURABLE ROW, NOT A MUTABLE SLOT. The first shape keyed this
-- table by studio_id alone, so "opening the next round" could only mean
-- overwriting the one row -- and consumption, having no round to belong to,
-- was counted over the studio's whole history instead. Measured on that shape:
-- after admitting and converting ONE prospect against an allowance of 1, a
-- fresh round at allowance 1 answered `round_full` forever. The allowance was
-- a LIFETIME CAP wearing the word "per-round".
--
-- The product ruling is that it is a PER-ROUND QUOTA, so the schema now says
-- so: every round is its own immutable row with its own identity, its own
-- opening and closing evidence, and its own allowance. Closing a round never
-- erases it; opening the next one never overwrites the last.
create table if not exists public.studio_waitlist_admission_rounds (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid not null references public.studios(id) on delete cascade,
  allowance  integer not null,
  -- SERVER-OWNED. Both stamps come from the opening/closing command's own
  -- post-lock clock; no caller supplies either.
  opened_at  timestamptz not null default now(),
  opened_by_practitioner_id uuid not null,
  closed_at  timestamptz,
  closed_by_practitioner_id uuid,
  updated_at timestamptz not null default now(),

  constraint studio_waitlist_admission_rounds_allowance_check check (allowance >= 0),
  -- Closing is one fact with two halves. A closed_at with no actor, or an actor
  -- with no instant, describes a close nobody performed.
  constraint studio_waitlist_admission_rounds_close_evidence_check
    check ((closed_at is null) = (closed_by_practitioner_id is null)),
  constraint studio_waitlist_admission_rounds_close_order_check
    check (closed_at is null or closed_at >= opened_at),
  -- STRUCTURAL TENANCY, the same composite shape 0185/0188 already use: a
  -- practitioner from another studio cannot be recorded here even if a command
  -- were wrong.
  constraint studio_waitlist_admission_rounds_opener_same_studio_fk
    foreign key (opened_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint studio_waitlist_admission_rounds_closer_same_studio_fk
    foreign key (closed_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  -- The target of the invitation's composite same-studio FK below. It is what
  -- makes "an invitation may only name a round of its OWN studio" structural
  -- rather than policed.
  constraint studio_waitlist_admission_rounds_id_studio_uniq unique (id, studio_id)
);

-- AT MOST ONE OPEN ROUND PER STUDIO, enforced by the database rather than by
-- the command. A second open row is the one state that would make "the current
-- round" ambiguous, and no application code is trusted to prevent it.
create unique index if not exists studio_waitlist_admission_rounds_one_open_per_studio
  on public.studio_waitlist_admission_rounds (studio_id)
  where closed_at is null;

create index if not exists studio_waitlist_admission_rounds_studio_opened_idx
  on public.studio_waitlist_admission_rounds (studio_id, opened_at desc);

alter table public.studio_waitlist_admission_rounds enable row level security;

revoke all on public.studio_waitlist_admission_rounds from public;
revoke all on public.studio_waitlist_admission_rounds from anon;
revoke all on public.studio_waitlist_admission_rounds from authenticated;
revoke all on public.studio_waitlist_admission_rounds from service_role;
-- READ ONLY, and by COLUMN LIST. The owner's settings page needs to render the
-- round; nothing in a browser may forge one, alter its allowance, reopen it, or
-- move an invitation between rounds. Every mutation goes through the two
-- SECURITY DEFINER commands below.
grant select (
  id, studio_id, allowance, opened_at, opened_by_practitioner_id,
  closed_at, closed_by_practitioner_id, updated_at
) on public.studio_waitlist_admission_rounds to authenticated;

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
  'WAIT-03B: one DURABLE ROW PER ADMISSION ROUND. The allowance is a PER-ROUND '
  'QUOTA, not a lifetime cap: consumption is counted only over invitations '
  'stamped with that round''s id, so a new round starts at zero however many '
  'prospects earlier rounds admitted. A studio with no OPEN row (closed_at is '
  'null) has no open round and no invitation may issue; the allowance is never '
  'defaulted to a live number and never inferred from calendar emptiness. '
  'Closed rounds are retained as history and are never overwritten. At most one '
  'row per studio may be open, enforced by a partial unique index rather than '
  'by application code. Deliberately its own table: a new column on studios '
  'would inherit the browser-reachable table-level UPDATE grant anon and '
  'authenticated already hold, and a column-level revoke cannot remove a '
  'table-level grant.';

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
  add column if not exists declined_at           timestamptz,
  -- THE ROUND THAT AUTHORISED THIS INVITATION. Nullable, and deliberately so:
  -- invitations issued by 0188..0191 predate rounds entirely and belong to
  -- none. That is the honest record AND the safe one -- a legacy row cannot
  -- consume any round's capacity, because consumption is counted only over
  -- rows stamped with the round being asked about.
  add column if not exists admission_round_id    uuid;

-- SAME-STUDIO BY CONSTRUCTION. A caller cannot name another studio's round to
-- borrow its allowance: the composite key makes a cross-studio pairing
-- unrepresentable rather than merely refused.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_round_same_studio_fk;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_round_same_studio_fk
  foreign key (admission_round_id, studio_id)
  references public.studio_waitlist_admission_rounds (id, studio_id) on delete restrict;

create index if not exists new_client_waitlist_invitations_admission_round_idx
  on public.new_client_waitlist_invitations (admission_round_id);

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
-- THE STUDIO-LIFETIME COUNTER IS WITHDRAWN, not renamed. Keeping the name
-- `waitlist_admission_consumed(uuid)` while silently swapping its argument from
-- a studio to a round would leave a same-signature function whose meaning had
-- changed underneath every reader -- exactly the trap this slice has already
-- paid for elsewhere. 0192 is unapplied, so this drops something production has
-- never seen.
drop function if exists public.waitlist_admission_consumed(uuid);

-- ---------------------------------------------------------------------
-- ROUND-SCOPED CONSUMPTION. One round, one quota, counted over invitations
-- stamped with that round and nothing else.
--
-- TWO CORRECTIONS LIVE IN THIS ONE QUERY.
--
-- 1. IT IS SCOPED TO A ROUND. The previous shape counted every converted entry
--    the studio had ever produced, so old rounds consumed new ones forever.
--    Measured: allowance 1, admit+convert one prospect, and the NEXT round at
--    allowance 1 answered `round_full` with nobody in it.
--
-- 2. A REDEEMED INVITATION COUNTS FROM REDEMPTION, not from conversion. The
--    previous shape counted `outstanding` (redeemed_at IS NULL) plus
--    `converted entries`, so an invitation that had been redeemed but not yet
--    converted was in NEITHER term. Measured: consumption fell 1 -> 0 -> 1 and
--    a second prospect was admitted against an allowance of 1. That window is
--    not a race -- it is the whole booking flow, a human choosing a slot.
--
-- ONE ROW, ONE SEAT, COUNTED ONCE. This reads invitations only. Conversion is
-- not joined at all, because conversion REQUIRES redemption, so a redeemed row
-- already carries its own seat and adding an entry-side term could only
-- double-count it.
--
-- MONOTONIC ACROSS THE LIFECYCLE, which is what closes the race without a new
-- lock: LIVE counts through the second limb, REDEEMED and CONVERTED both count
-- through the first, and no committed state between them counts zero.
--
-- TERMINAL BEFORE REDEMPTION RELEASES THE SEAT. declined / expired / released
-- fail the second limb and never satisfy the first, so the seat returns to the
-- round -- which is the point of ending an offer early. A lapsed window does
-- the same with no state change at all, by `expires_at`.
create or replace function public.waitlist_admission_round_consumed(p_round_id uuid)
returns integer
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select count(*)::integer
    from public.new_client_waitlist_invitations i
   where i.admission_round_id = p_round_id
     and (
           -- SPENT: redemption consumes the seat for the rest of the round, and
           -- a later cancellation does not recycle it.
           i.redeemed_at is not null
           or
           -- OUTSTANDING: still answerable, and its window has not lapsed.
           --
           -- `redeemed_at is null` makes the two limbs DISJOINT, which is not
           -- cosmetic. Without it a redeemed invitation inside its original
           -- window satisfies BOTH, and the SPENT limb only becomes load-bearing
           -- once that window lapses — so a test suite that never ages a
           -- redeemed row would pass with the SPENT limb deleted entirely. Found
           -- exactly that way, by a negative control that failed to go red.
           -- Disjoint limbs also make "one row, one seat" obvious rather than
           -- something a reader has to reason about.
           (    i.redeemed_at is null
            and i.expired_at  is null
            and i.released_at is null
            and i.declined_at is null
            and i.expires_at  > clock_timestamp())
         )
$$;

comment on function public.waitlist_admission_round_consumed(uuid) is
  'WAIT-03B: admission permission consumed WITHIN ONE ROUND, counted only over '
  'invitations stamped with that round. A new round therefore starts at zero '
  'however many prospects earlier rounds admitted — the allowance is a '
  'per-round quota, not a lifetime cap. A seat is consumed while an invitation '
  'is still answerable, and from the moment it is REDEEMED — not from '
  'conversion, which would leave the whole booking flow counting zero. Each '
  'invitation counts at most once. A declined, expired or released invitation '
  'frees its seat back to the round; a redeemed one does not, and is not '
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
  v_round_id  uuid;
  v_issue     record;
  v_inv_id    uuid;
begin
  -- LOCK ORDER STEP 1: the studio row, then the round row. Serialises two
  -- concurrent issues competing for the final allowance seat.
  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'unknown_studio'::text, null::text, null::uuid; return;
  end if;

  -- THE OPEN ROUND IS IDENTIFIED AND LOCKED ONCE, and its identity is carried
  -- through every later decision in this command. `closed_at is null` is what
  -- makes it THE current round; the partial unique index guarantees there is at
  -- most one, so no ordering or tie-break is needed or wanted.
  select r.id, r.allowance into v_round_id, v_allowance
    from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id
     and r.closed_at is null
   for update;

  if v_round_id is null then
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

  -- ALLOWANCE CHECKED UNDER THE STUDIO AND ROUND LOCKS, not before them, and
  -- against THE ROUND ALREADY LOCKED ABOVE -- never by re-asking which round is
  -- current, which could answer differently after the decision.
  v_consumed := public.waitlist_admission_round_consumed(v_round_id);
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
  -- THE ROUND IS STAMPED IN THE SAME STATEMENT AS THE SCOPE, from the variable
  -- captured under the lock above. The invitation therefore belongs to exactly
  -- the round whose allowance authorised it, and the append-only trigger makes
  -- that binding immutable from here on.
  update public.new_client_waitlist_invitations i
     set scope_service_id       = p_service_id,
         scope_start_date       = p_start_date,
         scope_end_date         = p_end_date,
         scope_allowed_weekdays = p_allowed_weekdays,
         admission_round_id     = v_round_id
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
        -- The invitation's OWN death, read from the locked authoritative row,
        -- and the challenge window actually granted after it is bounded by it.
        v_inv_expires timestamptz; v_challenge_expires timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_ttl_minutes is null or p_ttl_minutes <= 0 or p_ttl_minutes > 60 then
    return query select 'invalid_input'::text, null::text, null::text, null::timestamptz, null::uuid, null::timestamptz; return;
  end if;

  -- `expires_at` IS READ FROM THE LOCKED ROW, in the same statement that takes
  -- the lock. It is not re-derived, not re-read afterwards, and never supplied
  -- by a caller: the authority for when this invitation dies is the row this
  -- transaction now holds.
  select i.id, i.entry_id, i.studio_id, i.expires_at
    into v_inv, v_entry, v_studio, v_inv_expires
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

  -- ------------------------------------------------------------------
  -- A CHALLENGE MAY NEVER OUTLIVE THE INVITATION THAT AUTHORISES IT.
  -- ------------------------------------------------------------------
  --
  -- The requested TTL was bounded 1..60 minutes and nothing else, so an
  -- invitation with two minutes left minted a fifteen-minute challenge: the
  -- stored column asserted a fact that was false, and `begin_` RETURNS this
  -- instant to the server-side delivery caller, which states it to the
  -- recipient. The email then promised a window the authority would refuse
  -- inside -- `complete_` gates on invitation liveness BEFORE it looks at the
  -- challenge, so every use after `expires_at` answers `not_live`. A code that
  -- says it is good until 14:15 and stops working at 14:02 is a promise the
  -- system cannot keep.
  --
  -- BOUNDED AT THE MINT, WHICH IS THE ONLY PLACE IT CAN BE STRUCTURAL. This
  -- function is the sole writer of a NON-NULL proof_challenge_expires_at --
  -- the only other two writes in this file set it to NULL -- so clamping here
  -- makes a longer-lived challenge unrepresentable rather than merely refused.
  -- A delivery caller may still decline to send a window it considers too
  -- short; that is a second opinion about output, not the authority for the
  -- lifetime, and it cannot repair a value already persisted.
  --
  -- `least` IS SAFE HERE BECAUSE THE COLUMN IS NOT NULL. `least` ignores NULL
  -- operands and would silently return the unclamped instant if v_inv_expires
  -- were null; new_client_waitlist_invitations.expires_at is `timestamptz not
  -- null` from 0188 and no migration has relaxed it, so the null operand this
  -- would need cannot exist. Stated rather than assumed, because the failure
  -- would be silent.
  --
  -- NO NEW REFUSAL, AND NONE IS NEEDED. The liveness gate above already
  -- established `expires_at > v_now`, so the clamped instant is strictly in the
  -- future for every challenge this command issues -- it can be short, but it
  -- is never already expired and never earlier than the mint. The existing
  -- vocabulary therefore still describes the outcome exactly: the challenge WAS
  -- issued, and `expires_at` reports the window that was actually granted. A
  -- near-expiry refusal would be a new user-facing policy, and this repair does
  -- not invent one.
  v_challenge_expires := least(v_now + make_interval(mins => p_ttl_minutes), v_inv_expires);

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
         proof_challenge_expires_at   = v_challenge_expires,
         proof_challenge_sent_to_hash = encode(extensions.digest(lower(btrim(v_email)),'sha256'),'hex'),
         proof_challenge_attempts     = 0,
         proof_capability_hash        = null,
         proof_capability_expires_at  = null
   where id = v_inv;

  -- THE RETURNED EXPIRY IS THE PERSISTED ONE, the same variable, not a second
  -- computation that happens to agree. Recomputing it here is what let the
  -- returned value and the stored value drift apart in principle; one variable
  -- makes them the same fact. `v_now` is likewise the instant the expiry was
  -- measured from, not a second reading of the clock.
  return query select 'challenge_issued'::text, v_raw, v_email,
                      v_challenge_expires, v_cid, v_now;
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
-- 13. GATED RECIPIENT IDENTITY. The three fields a booking submission needs,
--     released ONLY to a proven recipient of THIS invitation.
--
--     WHY THIS EXISTS. B3 books the invited person into the scoped slot, and
--     the public booking command requires their name, email and phone. Those
--     live on the waitlist ENTRY, and 0185 revoked every table privilege on
--     `new_client_waitlist_entries` from service_role BY NAME precisely so the
--     server's most privileged client cannot dump contact details directly.
--     That boundary is correct and is NOT relaxed here -- no table grant is
--     added, and `has_table_privilege('service_role', ..., 'SELECT')` stays
--     false. The server reads the three booking fields through this command or
--     it does not read them at all.
--
--     WHY THIS IS NOT THE CHECK-THEN-ACT ORACLE RETIRED BELOW. The dropped
--     `validate_waitlist_invitation_proof(text,text)` returned a VERDICT: a
--     caller asked "is this proof good?", received a boolean, and then acted on
--     its OWN authority in a later transaction. The gap between the verdict and
--     the act is the defect. This command issues no verdict to act on. It
--     performs, inside one locked decision, the only thing the capability
--     entitles its holder to here -- reading their own three booking fields --
--     and returns them. Nothing downstream trusts its answer:
--     `redeem_new_client_waitlist_invitation_verified` re-proves the same
--     capability inside its own locked transaction before anything is consumed.
--     Removing this command would not remove a gate; it would remove a read.
--
--     THE CAPABILITY TEST IS THE MUTATIONS' TEST, VERBATIM -- same liveness
--     set, same post-lock `clock_timestamp()`, same digest comparison, same
--     refusal vocabulary. A second, softer reading of "valid proof" is exactly
--     how a two-authority law erodes, so there is not a second one.
--
--     LOCK ORDER. This takes the INVITATION lock only and reads the entry
--     WITHOUT one. `decline_`, `release_new_client_waitlist_entry` and
--     `expire_new_client_waitlist_invitation` all take the ENTRY mutex first
--     and reach for the invitation second; taking an entry lock here too would
--     close exactly the deadlock cycle the P2 above was raised to remove. An
--     unlocked read cannot participate in that cycle.
--
--     WHAT IT MAY RETURN is a result and three columns, and the values are the
--     STORED ones verbatim -- this is an authority boundary, not a normaliser.
--     No lifecycle field, no proof or recipient hash, no scope, no other
--     invitation and no other entry is reachable through it, and there is no
--     argument by which a caller could ask for one.
-- ---------------------------------------------------------------------
create or replace function public.resolve_waitlist_invitation_recipient_identity(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text, name text, email text, phone text)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz;
        v_name text; v_email text; v_phone text;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::text, null::text, null::text; return;
  end if;

  -- ONE lock, held across the WHOLE authority decision, so a concurrent
  -- revoke, decline, reissue or redeem either commits first -- and this fails
  -- closed below -- or waits for it. Same pin as the two gated mutations.
  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::text, null::text, null::text; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::text, null::text, null::text; return;
  end if;

  -- THE GATE. Bearer possession reaches here and stops, exactly as it does at
  -- redeem and at decline.
  if r.proof_capability_hash is null then
    return query select 'proof_required'::text, null::text, null::text, null::text; return;
  end if;
  if r.proof_capability_expires_at <= v_now then
    return query select 'proof_expired'::text, null::text, null::text, null::text; return;
  end if;
  if r.proof_capability_hash <> encode(extensions.digest(p_raw_capability,'sha256'),'hex') then
    return query select 'proof_invalid'::text, null::text, null::text, null::text; return;
  end if;

  -- IDENTITY COMES FROM THIS INVITATION'S ENTRY, IN THIS INVITATION'S STUDIO.
  -- The composite FK (entry_id, studio_id) -> entries(id, studio_id) already
  -- makes a cross-studio pair unrepresentable; the predicate restates it at
  -- runtime so this read cannot outlive that guarantee.
  select e.name, e.email, e.phone
    into v_name, v_email, v_phone
    from public.new_client_waitlist_entries e
   where e.id = r.entry_id and e.studio_id = r.studio_id;

  -- The FK cascades the invitation away with its entry, so a live invitation
  -- always has one. This refuses rather than returning 'resolved' carrying a
  -- null identity, if that ever stops holding.
  if not found then
    return query select 'identity_unavailable'::text, null::text, null::text, null::text; return;
  end if;

  return query select 'resolved'::text, v_name, v_email, v_phone;
end;
$$;

-- ---------------------------------------------------------------------
-- 14. RETIRE THE UNGATED AND CHECK-THEN-ACT SURFACES.
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
-- 14b. THE LEGACY LIFECYCLE COMMANDS LEARN THAT A DECLINED ROW IS CLOSED.
--
--      SECTION 3 WIDENED WHAT "LIVE" MEANS AND THIS IS THE REST OF THAT
--      CHANGE. 0188 created `..._one_live_per_entry` as a UNIQUE index on
--      (entry_id) WHERE redeemed_at, expired_at and released_at are all null.
--      That uniqueness was not a detail: it is what made an UNORDERED
--      `select i.id into v_inv` over those three columns correct in 0188 and
--      0189 -- at most one row could ever match, so "the row matching" and
--      "the current cycle" were the same thing by construction.
--
--      Section 3 replaced that index with the four-column predicate so a
--      declined invitation stops blocking its entry and a later offer becomes
--      possible. Correct, and the point of this slice. But it DELETED THE
--      SINGLETON GUARANTEE the three-column question depended on, and three
--      commands were still asking it:
--
--        expire_new_client_waitlist_invitation
--        release_new_client_waitlist_entry
--        record_new_client_waitlist_conversion
--
--      After DECLINE A -> REQUEUE -> ISSUE B, two rows satisfy the old
--      predicate and one satisfies the new one. Measured on a real database:
--      three-terminal matched 2, four-terminal matched 1.
--
--      WHAT THAT COSTS. A declined row PASSES the old guards (measured:
--      passes_legacy_guard = true, is_declined = true), so whichever row the
--      unordered select happens to return is the one these commands act on:
--
--        * release_ / expire_ stamping the declined row raises
--          `one_terminal_outcome_check` -- SQLSTATE 23514, measured -- so the
--          command RAISES instead of returning a code. 0185's rule is that a
--          command answers with a WORD, never an error;
--        * expire_ adjudicating the declined row rules against the wrong
--          offer's expires_at;
--        * record_conversion locks the wrong row, voiding the mutual exclusion
--          its own comment claims ("it only ever locks the live one").
--
--      Physical row order decided which branch ran, so the benign outcome was
--      luck rather than a guarantee -- a vacuum or a plan change is enough to
--      flip it. An unordered read of a set that may hold two rows is the
--      defect; which row it happened to return is not the fix.
--
--      FORWARD REDEFINITION, BECAUSE 0188/0189/0190 ARE APPLIED AND FROZEN.
--      Their bytes are never edited. These three are re-created here from
--      0189's exact text with ONE change each: the invitation selector gains
--      `and i.declined_at is null`. Nothing else moves -- same signatures,
--      same SECURITY DEFINER and search_path, same actor and tenant checks,
--      same ENTRY -> INVITATION lock order, same single post-lock
--      clock_timestamp(), same result vocabulary, same expiry and conversion
--      semantics. This teaches the commands a new terminal state; it does not
--      redefine the old ones.
--
--      CHRONOLOGY IS NOT THE FIX. An `order by issued_at desc limit 1` would
--      also make the select single-valued, and would be wrong: it would pick a
--      row by age rather than by liveness, and would still act on a declined
--      row when that row happened to be newest. The four-terminal predicate is
--      the invariant; ordering is not authority.
--
--      Grants are re-stated below rather than inherited. CREATE OR REPLACE
--      preserves an existing ACL, so this is belt-and-braces -- but this file
--      states privileges explicitly everywhere else, and a reader should not
--      have to know that rule to audit these three.
--
--      ONE CONSUMER IS DELIBERATELY NOT REPAIRED HERE: WAIT-LIVE-READ-01.
--      The practitioner queue at app/(app)/settings/waitlist/page.tsx asks the
--      same three-column question of this table and, for one entry with a
--      declined row and a live row, gets TWO rows back; its per-entry map keeps
--      whichever arrives last, so a historical declined offer can become the
--      rendered "current cycle". Measured.
--
--      It is not fixed in this migration's PR because the fix READS
--      declined_at, and hosted production is at 0191 where that column does not
--      exist. A deployed filter on a missing column makes PostgREST reject the
--      query, and the page's error branch then withholds every invitation
--      control for every studio. The ordering is therefore not a preference:
--
--          0192 hosted + verified  ->  app code reading declined_at  ->  deploy
--
--      Never the reverse. WAIT-LIVE-READ-01 is the stacked dependent PR that
--      carries the page change once this migration is applied.
-- ---------------------------------------------------------------------

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
  v_actor       uuid;
  v_code        text;
  v_hit         uuid;
  v_inv         uuid;
  v_expired     timestamptz;
  v_released    timestamptz;
  v_expires     timestamptz;
  v_decision_at timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  -- 1. SERIALIZE ON THE ENTRY ROW FIRST. Unchanged from 0188, and still the
  -- outer mutex: issue() takes this same lock before it inserts, so entry and
  -- invitation move as one unit and no live token is left behind a terminal
  -- entry.
  perform 1
     from public.new_client_waitlist_entries e
    where e.id = p_entry_id and e.studio_id = p_studio_id
    for update;

  -- 2. IDENTIFY THIS CYCLE STRUCTURALLY, NEVER BY CHRONOLOGY.
  --
  -- An earlier draft ordered by `issued_at desc, id desc`. That is wrong twice
  -- over, and both were reproduced:
  --
  --   INVERSION. 0188 stamps `issued_at := now()` in its insert trigger, and
  --   now() is transaction_timestamp(). A transaction that BEGAN earlier but
  --   issues later stamps the NEW row with the OLDER instant. Measured: TX began
  --   12:28:37.684Z; cycle A was issued and released from ordinary autocommit
  --   calls at 12:28:37.689Z; the old transaction then issued cycle B, stamped
  --   .684Z. The ordering picked the RELEASED historical row, expire() answered
  --   `not_invited`, and the genuine live cycle was left live and unstamped.
  --
  --   TIES. Two cycles completed inside ONE transaction share an identical
  --   issued_at, so the tiebreak fell to `id desc` -- a random v4 UUID. Which
  --   invitation was called "current" was then decided by coin flip.
  --
  -- THE SCHEMA ALREADY CARRIES THE ANSWER, and it is an invariant rather than a
  -- heuristic: `new_client_waitlist_invitations_one_live_per_entry` is a UNIQUE
  -- index on (entry_id) WHERE redeemed_at, expired_at and released_at are all
  -- null. At most ONE invitation per entry can be live, so the live row IS the
  -- current cycle, by construction, with no ordering of any kind.
  --
  -- THIS SELECT TAKES NO LOCK ON PURPOSE. The live-state predicate is mutable,
  -- and a FOR UPDATE carrying it could have the row re-qualified away by
  -- EvalPlanQual after a concurrent redemption commits -- losing the row and
  -- answering as though the entry had never been invited. So identity is read
  -- here, and the LOCK below is requested on the immutable id alone.
  select i.id into v_inv
    from public.new_client_waitlist_invitations i
   where i.entry_id    = p_entry_id
     and i.studio_id   = p_studio_id
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.declined_at is null;

  -- 3. NO LIVE INVITATION. Derived from WAIT-03's lifecycle invariants, and
  -- deliberately NOT from max(issued_at) or any other chronology guess.
  --
  -- Redemption is the state that produces this legally: redeem() terminates the
  -- invitation and leaves the entry `invited` (conversion is a separate,
  -- explicit command). It is also structurally unambiguous, because an entry
  -- holding a redeemed invitation can never acquire a later cycle: release and
  -- expire both refuse a redeemed entry, and requeue only accepts an entry that
  -- one of them has already moved. So "this entry has a redeemed invitation" and
  -- "this entry's current cycle was redeemed" are the same statement, which is
  -- exactly what 0188 relied on and why its wording is kept.
  if v_inv is null then
    if exists (
      select 1
        from public.new_client_waitlist_invitations i
       where i.entry_id    = p_entry_id
         and i.studio_id   = p_studio_id
         and i.redeemed_at is not null)
    then
      return 'already_redeemed';
    end if;
    if exists (
      select 1 from public.new_client_waitlist_entries e
       where e.id = p_entry_id and e.studio_id = p_studio_id and e.status = 'expired')
    then
      -- Already expired by an earlier call: idempotent, same closed word.
      return 'expired';
    end if;
    return 'not_invited';
  end if;

  -- 4. LOCK THE IDENTIFIED ROW BY ITS IMMUTABLE ID, and only then read the
  -- clock. `id` cannot change (0188's immutability trigger), so a wait that ends
  -- in an EvalPlanQual re-check still resolves to the SAME invitation instead of
  -- dropping it. If a redemption commits between step 2 and this lock, we still
  -- hold this row and observe redeemed_at below -- the truthful
  -- `already_redeemed` -- rather than losing the row.
  -- redeemed_at is deliberately NOT read into a local here: the cross-cycle
  -- `exists` check below is 0188's precedence and subsumes the locked row, so a
  -- second copy of the same fact would only be a chance for the two to diverge.
  select i.expired_at, i.released_at, i.expires_at
    into v_expired, v_released, v_expires
    from public.new_client_waitlist_invitations i
   where i.id = v_inv
   for update;

  -- THE CLOCK IS READ HERE -- after BOTH locks -- and nowhere else. Every
  -- comparison and every stamp below uses this one value, so the decision and
  -- the provenance it writes cannot disagree, and neither can be older than the
  -- lock that serialized the outcome.
  v_decision_at := clock_timestamp();

  -- REDEMPTION IS TERMINAL, re-tested UNDER the lock and across every cycle,
  -- which is 0188's precedence. Reading it before the lock is what let a
  -- redemption that committed during the wait go unseen.
  if exists (
    select 1
      from public.new_client_waitlist_invitations i
     where i.entry_id    = p_entry_id
       and i.studio_id   = p_studio_id
       and i.redeemed_at is not null)
  then
    return 'already_redeemed';
  end if;

  -- The remaining terminal facts come from the LOCKED row.
  if v_expired is not null then
    return 'expired';
  end if;
  if v_released is not null then
    return 'not_invited';
  end if;

  -- 5. EXPIRY MEANS THE TTL ELAPSED. It is not a second word for release, and
  -- the caller still supplies no clock and no expiry authority.
  if v_expires > v_decision_at then
    -- TRUTHFUL, AND NOT ANY OTHER EXISTING CODE: the entry is invited and its
    -- invitation is live, so the window simply has not closed yet.
    return 'not_expired';
  end if;

  -- 6. STAMP. The row is already locked, so this update cannot block and cannot
  -- be re-qualified against a newer version behind our back.
  update public.new_client_waitlist_invitations i
     set expired_at = v_decision_at
   where i.id = v_inv
  returning i.id into v_inv;

  if v_inv is null then
    return 'not_invited';
  end if;

  -- REDEMPTION IS TERMINAL FOR THIS ENTRY, RESTATED AS DEFENCE IN DEPTH. The
  -- branch above already refused a redeemed entry; this repeats the test on the
  -- statement that actually moves the entry, so the two can never disagree.
  update public.new_client_waitlist_entries
     set status = 'expired', expired_at = v_decision_at
   where id = p_entry_id and studio_id = p_studio_id and status = 'invited'
     and not exists (
       select 1
         from public.new_client_waitlist_invitations i
        where i.entry_id    = p_entry_id
          and i.studio_id   = p_studio_id
          and i.redeemed_at is not null)
  returning id into v_hit;

  if v_hit is null then
    return 'not_invited';
  end if;
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
  v_actor       uuid;
  v_code        text;
  v_hit         uuid;
  v_inv         uuid;
  v_decision_at timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  -- 1. SERIALIZE ON THE ENTRY ROW FIRST. Unchanged from 0188: issue() takes this
  -- same lock before it inserts, so entry and invitation move as one unit and no
  -- live token is left behind a terminal entry.
  perform 1
     from public.new_client_waitlist_entries e
    where e.id = p_entry_id and e.studio_id = p_studio_id
    for update;

  -- 2. IDENTIFY THE LIVE INVITATION STRUCTURALLY, if there is one. NULL is a
  -- legitimate, common answer here: a `claimed` entry may never have been
  -- invited, and an `expired` entry's invitation is already terminal.
  -- No lock is taken by this SELECT -- see COMMAND 6.
  select i.id into v_inv
    from public.new_client_waitlist_invitations i
   where i.entry_id    = p_entry_id
     and i.studio_id   = p_studio_id
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.declined_at is null;

  -- 3. LOCK IT BY IMMUTABLE ID ALONE, when it exists.
  if v_inv is not null then
    perform 1
       from public.new_client_waitlist_invitations i
      where i.id = v_inv
      for update;
  end if;

  -- 4. ONE CLOCK READ, after every lock this path required. Both stamps below
  -- come from it, so the invitation and the entry can never disagree about when
  -- the release happened.
  v_decision_at := clock_timestamp();

  -- 5. Invalidate the live invitation, under its own lock. The three null
  -- guards are 0188's and are kept: a redemption that committed between step 2
  -- and step 3 leaves redeemed_at set, this matches nothing, and the entry move
  -- below refuses too -- yielding `already_redeemed` rather than a release that
  -- overwrites a redemption.
  if v_inv is not null then
    update public.new_client_waitlist_invitations i
       set released_at = v_decision_at
     where i.id = v_inv
       and i.redeemed_at is null and i.expired_at is null and i.released_at is null
     and i.declined_at is null;
  end if;

  -- 6. The entry move, guarded against a redeemed prospect exactly as 0188
  -- guards it, and stamped from the SAME instant as the invitation.
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_decision_at
   where id = p_entry_id and studio_id = p_studio_id
     and status in ('claimed','invited','expired')
     and not exists (
       select 1
         from public.new_client_waitlist_invitations i
        where i.entry_id    = p_entry_id
          and i.studio_id   = p_studio_id
          and i.redeemed_at is not null)
  returning id into v_hit;

  if v_hit is null then
    if exists (
      select 1
        from public.new_client_waitlist_invitations i
       where i.entry_id    = p_entry_id
         and i.studio_id   = p_studio_id
         and i.redeemed_at is not null)
    then
      return 'already_redeemed';
    end if;
    return 'not_releasable';
  end if;
  return 'released';
end;
$$;

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
  v_decision_at timestamptz;
  v_inv         uuid;
  v_hit uuid;
begin
  if p_studio_id is null or p_entry_id is null or p_client_id is null then
    return 'invalid_input';
  end if;

  if not exists (select 1 from public.clients c
                  where c.id = p_client_id and c.studio_id = p_studio_id) then
    return 'client_not_found';
  end if;

  -- Same entry mutex the invalidating commands take, for the same reason: the
  -- redemption test below and the status move must not straddle a concurrent
  -- issue/redeem/release.
  perform 1
     from public.new_client_waitlist_entries e
    where e.id = p_entry_id and e.studio_id = p_studio_id
    for update;

  -- THE ENTRY MUTEX DOES NOT SERIALIZE A REDEMPTION, and conversion is the one
  -- command where that matters. redeem() locks the INVITATION and deliberately
  -- never asks for the entry, so it runs to completion while this command holds
  -- the entry row. Measured on the pre-repair shape: a redemption committed at
  -- 19:13:57.512Z while conversion held the entry, and conversion -- whose clock
  -- had already been read -- stamped converted_at 19:13:57.457Z. The conversion
  -- was recorded 55 ms BEFORE the redemption that authorised it, inverting the
  -- REDEEM -> CONVERT chronology this migration exists to protect.
  --
  -- So the LIVE invitation is identified structurally (one_live_per_entry, never
  -- issued_at or UUID order) and LOCKED BY ITS IMMUTABLE ID before the clock is
  -- read. A redemption in flight is then either already committed and visible
  -- below, or blocked behind us; either way the clock is later than it.
  --
  -- WITH NO LIVE INVITATION THE ENTRY MUTEX ALREADY SUFFICES, and that is
  -- provable rather than hopeful: redeem() requires a live invitation (all three
  -- outcome columns null), so with none live no redemption can begin; and
  -- issue() takes this same entry mutex, so no new invitation can appear while
  -- we hold it. The relevant state is frozen and there is no second lock to
  -- take. That is also why conversion never has to identify a REDEEMED row by
  -- chronology: it only ever locks the live one.
  --
  -- LOCK ORDER IS UNCHANGED, ENTRY -> INVITATION. Nothing here takes the entry
  -- after an invitation, so redeem's invitation-only hold cannot deadlock it.
  select i.id into v_inv
    from public.new_client_waitlist_invitations i
   where i.entry_id    = p_entry_id
     and i.studio_id   = p_studio_id
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.declined_at is null;

  if v_inv is not null then
    perform 1
       from public.new_client_waitlist_invitations i
      where i.id = v_inv
      for update;
  end if;

  -- ONLY NOW. Every stamp below comes from this one post-lock instant.
  v_decision_at := clock_timestamp();

  -- CONVERSION REQUIRES A REDEEMED INVITATION. `invited` alone is not evidence
  -- that the person ever accepted: it says an operator SENT an invitation. The
  -- lifecycle is REDEEM -> BOOK -> RECORD, and recording a conversion straight
  -- out of `invited` skipped the first step entirely -- measured: conversion
  -- succeeded while the raw token was still live, so the token could then be
  -- redeemed AFTER the entry had already reached a terminal state.
  --
  -- The test is `redeemed_at is not null` on this entry's own invitation, which
  -- is durable: write-once under an append-only trigger, on an undeletable row,
  -- with an immutable entry_id. A released or expired invitation that was never
  -- redeemed carries no redeemed_at and is therefore refused here too.
  --
  -- NOTHING IS CONSUMED HERE. This command does not redeem, expire or release
  -- anything: an unredeemed invitation is left exactly as it was, so the refusal
  -- is repeatable and the operator can still have the prospect redeem properly.
  if not exists (
    select 1
      from public.new_client_waitlist_invitations i
     where i.entry_id    = p_entry_id
       and i.studio_id   = p_studio_id
       and i.redeemed_at is not null)
  then
    -- DISTINGUISHED FROM 'not_invited', which would be false: the entry may be
    -- invited and simply not yet redeemed. The caller must be able to tell
    -- "there was no invitation" from "they have not accepted it yet".
    if exists (select 1 from public.new_client_waitlist_entries e
                where e.id = p_entry_id and e.studio_id = p_studio_id
                  and e.status = 'invited')
    then
      return 'not_redeemed';
    end if;
  end if;

  update public.new_client_waitlist_entries
     set status              = 'converted',
         converted_at        = v_decision_at,
         converted_client_id = p_client_id
   where id = p_entry_id and studio_id = p_studio_id and status = 'invited'
     and exists (
       select 1
         from public.new_client_waitlist_invitations i
        where i.entry_id    = p_entry_id
          and i.studio_id   = p_studio_id
          and i.redeemed_at is not null)
  returning id into v_hit;

  if v_hit is null then return 'not_invited'; end if;
  return 'converted';
end;
$$;


-- The same service_role-only posture 0188 and 0189 already established for
-- these three, re-stated by name so it is visible rather than inherited.
revoke all privileges on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from public;
revoke all privileges on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from anon;
revoke all privileges on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from authenticated;
revoke all privileges on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) from service_role;
grant  execute on function public.expire_new_client_waitlist_invitation(uuid, uuid, uuid) to service_role;

revoke all privileges on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from public;
revoke all privileges on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from anon;
revoke all privileges on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from authenticated;
revoke all privileges on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) from service_role;
grant  execute on function public.release_new_client_waitlist_entry(uuid, uuid, uuid) to service_role;

revoke all privileges on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from public;
revoke all privileges on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from anon;
revoke all privileges on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from authenticated;
revoke all privileges on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) from service_role;
grant  execute on function public.record_new_client_waitlist_conversion(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 14d. OPENING AND CLOSING A ROUND IS A COMMAND, NOT A TABLE WRITE.
--
--      Before this, the round table had NO writer anywhere: no RPC, no server
--      action, no application path. The only way to establish a round was a
--      raw service-role upsert, which is not a product contract -- it has no
--      owner check, no attribution, no close evidence and nothing stopping two
--      open rounds. Both commands below re-derive authority in the database
--      from (studio_id, auth user id) through the existing resolver, exactly as
--      every other command in this file does.
--
--      LOCK ORDER IS THE CANONICAL ONE: STUDIO -> ROUND. Issuance takes
--      studios then the round; these take the same two in the same order, so an
--      open or close cannot invert against a concurrent issue.
--
--      MID-ROUND ALLOWANCE CHANGE IS DELIBERATELY NOT OFFERED. Nothing in the
--      shipped product asks for it, and it is the one edit that could put a
--      round below what it has already spent. When a studio wants a different
--      number it closes the round and opens the next one, which leaves history
--      instead of rewriting it. Adding it later is a small forward command; it
--      would have to refuse an allowance below the round's consumed count.
-- ---------------------------------------------------------------------
create or replace function public.open_new_client_waitlist_admission_round(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_allowance     integer
)
returns table (result text, round_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_code  text;
  v_now   timestamptz;
  v_id    uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::uuid; return;
  end if;

  -- NO DEFAULTED ALLOWANCE, EVER. A null is not "unlimited" and not "the last
  -- one again"; it is a caller that did not say. Zero is legitimate and means
  -- a round that admits nobody yet.
  if p_allowance is null or p_allowance < 0 then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;

  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then
    return query select 'unknown_studio'::text, null::uuid; return;
  end if;

  -- Decided under the lock, so two concurrent opens cannot both see "none
  -- open". The partial unique index is still the last word -- the exception
  -- handler below turns its verdict into this command's own vocabulary rather
  -- than letting a 23505 escape.
  perform 1 from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id and r.closed_at is null
   for update;
  if found then
    return query select 'round_already_open'::text, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  begin
    insert into public.studio_waitlist_admission_rounds
      (studio_id, allowance, opened_at, opened_by_practitioner_id, updated_at)
    values (p_studio_id, p_allowance, v_now, v_actor, v_now)
    returning id into v_id;
  exception
    when unique_violation then
      return query select 'round_already_open'::text, null::uuid; return;
  end;

  return query select 'opened'::text, v_id;
end;
$$;

create or replace function public.close_new_client_waitlist_admission_round(
  p_studio_id     uuid,
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
  v_id    uuid;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;

  perform 1 from public.studios s where s.id = p_studio_id for update;
  if not found then return 'unknown_studio'; end if;

  select r.id into v_id
    from public.studio_waitlist_admission_rounds r
   where r.studio_id = p_studio_id and r.closed_at is null
   for update;
  if v_id is null then return 'no_round_open'; end if;

  -- A ROUND MAY NOT CLOSE WHILE AN OFFER IT AUTHORISED IS STILL ANSWERABLE.
  --
  -- Closing is what moves the quota to the next round. If a live unredeemed
  -- invitation could be left behind, its seat would leave the accounting the
  -- moment the round closed -- while the recipient could still redeem it and
  -- book. The studio would then have admitted someone no round is counting.
  --
  -- The owner is not stuck: the existing lifecycle already ends an outstanding
  -- offer early (release), and an unanswered one lapses on its own window. Only
  -- SETTLED rounds close -- redeemed, declined, expired, released, or lapsed.
  if exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.admission_round_id = v_id
       and i.redeemed_at is null
       and i.expired_at  is null
       and i.released_at is null
       and i.declined_at is null
       and i.expires_at  > clock_timestamp()
  ) then
    return 'live_offers_outstanding';
  end if;

  update public.studio_waitlist_admission_rounds r
     set closed_at = clock_timestamp(),
         closed_by_practitioner_id = v_actor,
         updated_at = clock_timestamp()
   where r.id = v_id and r.closed_at is null;

  return 'closed';
end;
$$;

-- ---------------------------------------------------------------------
-- 14c. AN INVITATION'S ROUND IS IMMUTABLE.
--
--      0188's append-only trigger already freezes identity, tenancy, token and
--      the validity window, and its bytes are APPLIED AND FROZEN. It cannot
--      know about a column added here, so the guard is re-created forward with
--      `admission_round_id` added to the same immutable set.
--
--      WITHOUT THIS, THE QUOTA IS ADVISORY. A row could be moved from a full
--      round to an emptier one after issuance -- or out of a round entirely --
--      and the count would follow it. The seat an invitation spent must stay
--      spent in the round that authorised it.
--
--      Issuance itself still works: the trigger is BEFORE UPDATE, and the stamp
--      in issue_scoped_ moves the column from NULL to its round inside the same
--      transaction, which `is distinct from` permits exactly once because every
--      later write would be from a non-NULL value.
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

  -- The round may be set ONCE, at issuance, and never changed or cleared after.
  if old.admission_round_id is not null
     and new.admission_round_id is distinct from old.admission_round_id then
    raise exception
      'new_client_waitlist_invitations: the admission round that authorised an invitation is immutable'
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

-- ---------------------------------------------------------------------
-- 15. PRIVILEGES. service_role ONLY, revoked from all four BY NAME first.
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
    'public.waitlist_admission_round_consumed(uuid)',
    'public.open_new_client_waitlist_admission_round(uuid, uuid, integer)',
    'public.close_new_client_waitlist_admission_round(uuid, uuid)',
    'public.issue_scoped_new_client_waitlist_invitation(uuid, uuid, uuid, uuid, date, date, smallint[], integer)',
    'public.resolve_new_client_waitlist_invitation(text)',
    'public.begin_waitlist_invitation_proof(text, integer)',
    'public.complete_waitlist_invitation_proof(text, text)',
    'public.invalidate_waitlist_invitation_proof(uuid)',
    'public.redeem_new_client_waitlist_invitation_verified(text, text)',
    'public.decline_new_client_waitlist_invitation(text, text)',
    'public.resolve_waitlist_invitation_recipient_identity(text, text)'
  ] loop
    execute format('revoke all privileges on function %s from public', f);
    execute format('revoke all privileges on function %s from anon', f);
    execute format('revoke all privileges on function %s from authenticated', f);
    execute format('revoke all privileges on function %s from service_role', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
