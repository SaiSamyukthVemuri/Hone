-- ===========================================================================
-- WAIT-P1-EXIT — THE REDEEMED-BUT-UNBOOKED ESCAPE HATCH — 0200
-- ===========================================================================
--
-- THE DEAD END THIS CLOSES, reconstructed from the shipped commands before a
-- line of this file was written.
--
-- Redemption does NOT move the entry. `redeem_new_client_waitlist_invitation`
-- (0188) and `redeem_new_client_waitlist_invitation_verified` (0192) stamp
-- `redeemed_at` on the invitation and leave the entry at `invited`. Only a
-- recorded CONVERSION moves it, and conversion requires a real client that the
-- canonical booking authority already created.
--
-- So a prospect who opens their invitation and never books leaves the entry at
-- `invited` with a redeemed invitation. In that state EVERY operator exit
-- refuses, and each refusal is deliberate and correct on its own terms:
--
--   release_new_client_waitlist_entry   -> 'already_redeemed'
--       0192 guards the entry move with `not exists (... redeemed_at is not
--       null)`. Without that guard a redeemed prospect could be released out of
--       `invited` and stranded short of conversion. The guard was a REPAIR.
--
--   expire_new_client_waitlist_invitation -> 'already_redeemed'
--       Refuses before it writes anything, and again on the statement that
--       moves the entry, because the two must never disagree. Expiry also
--       means the TTL elapsed; a redeemed invitation's window is spent, not
--       elapsed, so the word would be a lie even if the guard allowed it.
--
--   remove_new_client_waitlist_entry    -> 'release_required'
--       And structurally: the transition guard has no edge `invited -> removed`
--       at all, so removal cannot be reached even with the command's consent.
--
--   requeue_new_client_waitlist_entry   -> 'not_requeueable'
--       Accepts only `released` and `expired`, neither of which this entry can
--       reach.
--
--   record_new_client_waitlist_conversion -> needs a client that does not exist
--
-- And no NEW invitation can be issued either: `..._one_live_per_entry` permits
-- one live row per entry, redemption closes it, and the admission authority
-- accepts only `waiting` or `claimed`. The entry is immovable in every
-- direction. The practitioner surface renders this faithfully and therefore
-- offers no control at all -- `lib/waitlist/admission-model.ts` withholds
-- release, expire, requeue and remove on exactly this row, and says
-- "This entry stays here until the booking is recorded." Forever, if the
-- booking never comes.
--
-- NOTHING BELOW WEAKENS ANY OF THOSE FIVE COMMANDS. Not one of their guards,
-- signatures, result codes or grants is touched. This file adds a SIXTH
-- command that is the only one permitted to act on the state they all refuse,
-- and it refuses everything they accept.
--
-- ---------------------------------------------------------------------------
-- WHERE THE ENTRY LANDS, AND WHY IT IS NOT A NEW STATE
-- ---------------------------------------------------------------------------
--
-- `invited -> released`. The transition guard already permits that edge, so no
-- trigger, CHECK or status vocabulary changes.
--
-- It is also the edge the schema ALREADY uses for "this invitation cycle ended
-- without a booking": `decline_new_client_waitlist_invitation` (0192) moves the
-- entry `invited -> released` when the prospect says no. Redeem-then-abandon is
-- the same shape of outcome reached by silence instead of by an answer, and it
-- should not invent a second vocabulary for it.
--
-- From `released` the ordinary commands resume: requeue returns the prospect to
-- `waiting` with `joined_at` untouched (it is immutable), and remove reaches
-- `removed`. This file adds no second path to either, and rewrites no queue
-- ordering, provenance or evidence.
--
-- ---------------------------------------------------------------------------
-- THE ADMISSION SEAT IS NOT RECYCLED, AND THAT IS 0192'S RULING, NOT A GAP
-- ---------------------------------------------------------------------------
--
-- `waitlist_admission_round_consumed` counts a seat as spent from the moment an
-- invitation is REDEEMED, and its own comment states the rule plainly: "A
-- declined, expired or released invitation frees its seat back to the round; a
-- redeemed one does not, and is not recycled when an appointment is later
-- cancelled."
--
-- This command does not touch that function, that definition, or the round. A
-- closed cycle's invitation keeps `redeemed_at`, so it keeps counting against
-- the round that authorised it. Recycling the seat here would silently redefine
-- the per-round quota for every caller, which is a product decision and not a
-- side effect of an escape hatch. It is asserted as a test, not assumed.
--
-- What IS restored is the entry's own lifecycle: it leaves the active set, so
-- `..._one_active_per_email` frees that person's slot, the queue can be worked,
-- and a later cycle can issue a genuinely new invitation once the entry is
-- requeued and claimed.
--
-- ---------------------------------------------------------------------------
-- THE INVITATION IS ALREADY UNUSABLE, AND STAYS THAT WAY
-- ---------------------------------------------------------------------------
--
-- Both redeem commands require `redeemed_at is null`, so a redeemed token can
-- never redeem again -- that is true BEFORE this file and is not created by it.
-- This file does not stamp a second terminal outcome either: the
-- `..._one_outcome_check` CHECK permits at most one of redeemed / expired /
-- released / declined, so writing one onto a redeemed row would fail the
-- constraint. `closed_at` is deliberately NOT a terminal outcome. It records
-- that an operator ENDED a redeemed cycle, alongside the redemption rather than
-- instead of it, and it is excluded from every liveness predicate in the schema
-- for that reason.
--
-- ===========================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. THE CLOSE RECORD
-- ---------------------------------------------------------------------------
-- TWO COLUMNS, BOTH NULLABLE, NO BACKFILL AND NO REWRITE. Plain nullable
-- `ADD COLUMN` takes ACCESS EXCLUSIVE only for the catalogue update; neither
-- column has a default or a generation expression, so no table rewrite occurs.
--
-- AN ACTOR, WHICH RELEASE NOTABLY LACKS. The entry-events trigger records
-- `coalesce(new.removed_by, new.claimed_by, old.claimed_by)`, so a release
-- attributes the transition to whoever HELD the claim, not to whoever ended it
-- -- 0188 says so in its own comment. Ending a cycle that has already reached a
-- real person is a consequential act, and it is recorded against the
-- practitioner who performed it rather than inferred from a neighbouring
-- column.
alter table public.new_client_waitlist_invitations
  add column if not exists closed_at                 timestamptz,
  add column if not exists closed_by_practitioner_id uuid;

-- STUDIO-SCOPED ACTOR, the 0179 composite-FK idiom this schema applies to every
-- actor column. A practitioner from another studio cannot be recorded as having
-- closed this studio's cycle, and the reference is RESTRICT so the evidence
-- cannot be deleted out from under the record.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_closed_by_same_studio_fk;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_closed_by_same_studio_fk
  foreign key (closed_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict;

-- EVIDENCE IS ALL-OR-NOTHING, AND ONLY MEANINGFUL ON A REDEEMED CYCLE.
--
-- Both halves matter. A `closed_at` with no actor is an unexplained record, the
-- same failure the entries table's cycle-evidence CHECK exists to prevent. And
-- a close on an UNREDEEMED invitation would be a second, quieter way to end a
-- live invitation -- exactly the "two names for one act" that 0189 refused when
-- it stopped expire from serving as cancellation. Release remains the only way
-- to end a live invitation, enforced here rather than merely intended.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_close_evidence_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_close_evidence_check
  check (
    (closed_at is null) = (closed_by_practitioner_id is null)
    and (closed_at is null or redeemed_at is not null)
  );

-- ---------------------------------------------------------------------------
-- 2. "THE OPEN REDEEMED CYCLE" IS UNIQUE BY CONSTRUCTION, NOT BY ORDERING
-- ---------------------------------------------------------------------------
--
-- An entry can carry several invitation rows: the table is append-only and a
-- requeued entry can be invited again. So the command below has to identify
-- WHICH redeemed invitation it is closing, and picking one by `issued_at desc`
-- is precisely the chronology guess 0189 was written to delete -- two cycles
-- completed inside one transaction share an identical `issued_at` and the
-- tie-break falls to a random v4 UUID.
--
-- This index answers it structurally instead, the same way
-- `..._one_live_per_entry` answers "which invitation is current". At most one
-- redeemed-and-not-yet-closed row per entry, so THE open redeemed cycle is a
-- fact the database enforces rather than a row the query chooses.
--
-- IT IS SATISFIABLE ON EXISTING DATA, AND THAT WAS MEASURED, NOT ASSUMED. An
-- entry holding a redeemed invitation cannot leave `invited` by any shipped
-- path -- release and expire refuse it, removal has no edge, conversion is the
-- only exit and it is terminal -- so it can never be requeued and can never
-- acquire a second invitation. Read-only against the canonical production
-- project on 2026-09-19, before this file was authored: 31 entries, 3
-- invitations, 2 redeemed, and ZERO entries holding more than one redeemed
-- invitation. The index is a statement of what is already true.
create unique index if not exists new_client_waitlist_invitations_one_open_redeemed_per_entry
  on public.new_client_waitlist_invitations (entry_id)
  where redeemed_at is not null and closed_at is null;

-- ---------------------------------------------------------------------------
-- 3. THE CLOSE IS WRITE-ONCE
-- ---------------------------------------------------------------------------
--
-- FORWARD REDEFINITION, the mechanism 0192 itself used on 0188's and 0190's
-- functions. 0192's body is carried through UNCHANGED -- identity, tenancy,
-- token, validity window, the write-once admission round, and the three
-- terminal outcomes -- with ONE arm added. Nothing existing is relaxed.
--
-- WITHOUT THIS the close columns would be the only mutable lifecycle evidence
-- on an append-only table: a second call could re-stamp `closed_at` with a new
-- instant and a different actor, and the audit record would say the last writer
-- rather than the person who acted. The unique index above does not prevent
-- that -- an UPDATE that keeps `closed_at` non-null never re-enters the
-- predicate.
--
-- `declined_at` IS DELIBERATELY NOT ADDED TO THE TERMINAL ARM. 0192 omitted it,
-- and `decline_new_client_waitlist_invitation` clears `proof_capability_hash`
-- in the same UPDATE that sets it; tightening that arm is a separate decision
-- about a command this slice does not touch, and guessing at it here would be
-- the kind of drive-by change that turns an escape hatch into a regression.
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

  -- 0200. The operator close is evidence of a single act by a single
  -- practitioner, and is recorded once.
  if (old.closed_at is not null and new.closed_at is distinct from old.closed_at)
     or (old.closed_by_practitioner_id is not null
         and new.closed_by_practitioner_id is distinct from old.closed_by_practitioner_id) then
    raise exception
      'new_client_waitlist_invitations: an operator close is recorded once and cannot be rewritten'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE COMMAND
-- ---------------------------------------------------------------------------
--
-- SIGNATURE MATCHES ITS FIVE NEIGHBOURS EXACTLY -- (studio, entry, actor user
-- id) -> text -- so it drops straight into `runEntryLifecycleCommand` in
-- app/(app)/settings/waitlist/actions.ts and the browser supplies an entry id
-- and nothing else. No role, no studio, no practitioner id and no clock comes
-- from the caller.
--
-- LOCK ORDER, AND WHY IT CANNOT DEADLOCK WITH A BOOKING IN FLIGHT.
--
--   this command:  entry FOR UPDATE -> invitation FOR UPDATE
--                  -> (the entry UPDATE raises KEY SHARE on studios, via the
--                     event trigger's insert into ..._entry_events)
--
--   0195 booking:  studios FOR NO KEY UPDATE -> entry FOR UPDATE
--                  -> clients FOR SHARE
--
-- A booking holding studios NO KEY UPDATE and waiting on the entry, against
-- this command holding the entry and wanting studios KEY SHARE, is NOT a cycle:
-- KEY SHARE does not conflict with NO KEY UPDATE. That is the same argument
-- 0195's own header makes about `record_new_client_waitlist_conversion`, and
-- this command takes exactly the lock prefix `release_new_client_waitlist_entry`
-- already takes -- entry first, then the invitation by immutable id. No studios
-- lock is taken here, deliberately: taking one would invert the prefix that has
-- been proven on the release path.
--
-- THE BOOKING RACE RESOLVES TO EXACTLY ONE OUTCOME, IN EITHER ORDER.
--
--   Booking commits first. 0195 moves the entry to `converted` inside its own
--   transaction. This command then acquires the entry lock, reads `converted`,
--   and answers `already_booked`. Nothing is written.
--
--   This command commits first. The entry is `released` and the redeemed
--   invitation is closed. 0195 then acquires the entry lock and runs
--   `record_new_client_waitlist_conversion`, which requires `status = 'invited'`
--   and therefore answers `not_invited`; 0195 raises its private 'WA002', which
--   unwinds the subtransaction containing the appointment inserts. The
--   appointment does not commit.
--
-- Both orders yield a booking or an exit, never both, and the entry mutex is
-- what makes the two statements a single decision rather than two.
create or replace function public.close_unbooked_new_client_waitlist_invitation(
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
  v_status      text;
  v_released_at timestamptz;
  v_entry_email text;
  v_inv         uuid;
  v_redeemed_at timestamptz;
  v_decision_at timestamptz;
  v_hit         uuid;
begin
  -- 1. AUTHORITY, re-derived from (studio, actor) by the same shared resolver
  -- every other command uses. Owner-only, own studio, active practitioner.
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  -- 2. THE ENTRY MUTEX, taken before anything is read about the invitation.
  -- Scoped by BOTH id and studio_id, so a cross-studio entry is simply not
  -- found -- the tenancy refusal and the lock are the same statement, which is
  -- the repair 0195 had to make after a bare PERFORM checked nothing.
  select e.status, e.released_at, e.email_normalized
    into v_status, v_released_at, v_entry_email
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
     for update;

  if not found then return 'not_found'; end if;

  -- EVERYTHING BELOW RUNS UNDER THAT LOCK. No other waitlist command can touch
  -- this entry until this transaction ends, so the reads and the writes that
  -- follow are one decision rather than a sequence with windows in it.

  -- 3. IDEMPOTENCY, AND THE STATE THIS COMMAND ACTS ON.
  --
  -- A retry -- a double-submitted form, a replayed action, an operator pressing
  -- twice -- arrives after the entry has already moved to `released`. Testing
  -- the status alone would answer `not_invited`, which is true of the row and
  -- useless to the caller: it reads as "this was never invited" when in fact
  -- this very command closed it a moment ago.
  --
  -- THE TEST IS EXACT, NOT A GUESS AT HISTORY. "Some invitation on this entry
  -- was closed once" is the wrong question -- a closed cycle can be followed by
  -- a requeue, a fresh invitation and an ordinary expiry, and answering
  -- `already_closed` there would describe a cycle nobody asked about. Step 7
  -- below stamps the entry's `released_at` and the invitation's `closed_at`
  -- from ONE clock read, so equality between them is proof that THIS command
  -- performed THIS release. Nothing else in the schema writes `closed_at`.
  --
  -- The facts are durable: `closed_at` is write-once under the append-only
  -- trigger, on a row that cannot be deleted, whose `entry_id` is immutable;
  -- and the entry's own evidence columns cannot change without a legal status
  -- transition.
  if v_status = 'converted' then return 'already_booked'; end if;

  if v_status <> 'invited' then
    if v_status = 'released'
       and v_released_at is not null
       and exists (
         select 1
           from public.new_client_waitlist_invitations i
          where i.entry_id  = p_entry_id
            and i.studio_id = p_studio_id
            and i.closed_at = v_released_at)
    then
      return 'already_closed';
    end if;
    -- Any other non-invited state: `waiting`, `claimed`, `expired`, `removed`,
    -- or a `released` this command did not produce. None of them is the state
    -- this command exists for, and the existing commands own all of them.
    return 'not_invited';
  end if;

  -- 4. THE OPEN REDEEMED CYCLE. Identified by the unique partial index above,
  -- so this is a lookup and not a choice; `limit 1` is not present because
  -- there is nothing to limit.
  select i.id, i.redeemed_at
    into v_inv, v_redeemed_at
    from public.new_client_waitlist_invitations i
   where i.entry_id    = p_entry_id
     and i.studio_id   = p_studio_id
     and i.redeemed_at is not null
     and i.closed_at   is null;

  if not found then
    -- UNREDEEMED IS NOT THIS COMMAND'S BUSINESS, and the refusal says which
    -- command is. A live invitation is ended by release; an elapsed one is
    -- recorded by expire. Neither is weakened, and neither is duplicated here.
    return 'not_redeemed';
  end if;

  -- 5. LOCK THE INVITATION BY IMMUTABLE ID ALONE, after the entry, exactly as
  -- release does. A redemption that committed between steps 4 and 5 cannot
  -- change this row's identity, and the guarded UPDATE below re-reads the
  -- facts it depends on.
  perform 1 from public.new_client_waitlist_invitations i
    where i.id = v_inv
    for update;

  -- 6. NO APPOINTMENT MAY BE STRANDED.
  --
  -- The authority for "no booking" is the entry itself: `invited` carries
  -- `converted_at is null` and `converted_client_id is null` by the
  -- cycle-evidence CHECK, and since 0195 the appointment and the conversion
  -- share ONE transaction, so an appointment booked through the invitation
  -- cannot exist without the conversion that moves the entry.
  --
  -- THIS IS THE SECOND LAYER, for the window 0195 closed but history predates.
  -- Before 0195 the flow was three separate transactions and a process that
  -- disappeared between the appointment and the conversion left a durable
  -- appointment behind an entry still reading `invited` -- 0195's own header
  -- records that defect. Closing such a cycle would hide a real appointment
  -- behind a released waitlist row.
  --
  -- The link is the recipient binding 0195 enforces: a waitlist booking creates
  -- or matches a client whose normalised email equals the entry's. Restricted
  -- to appointments created at or after THIS cycle's redemption, so a person's
  -- unrelated history cannot block the exit, and ignoring cancelled
  -- appointments, because a cancelled booking strands nothing.
  --
  -- IT FAILS CLOSED INTO A COMMAND THAT WORKS, which is the whole point: the
  -- operator is pointed at `record_new_client_waitlist_conversion`, which
  -- accepts exactly this state (`invited` + redeemed). Refusing here therefore
  -- cannot create a second dead end.
  if exists (
    select 1
      from public.appointments a
      join public.clients c
        on c.id = a.client_id and c.studio_id = a.studio_id
     where a.studio_id        = p_studio_id
       and c.normalized_email = v_entry_email
       and a.status          <> 'cancelled'
       and a.created_at      >= v_redeemed_at)
  then
    return 'booking_exists';
  end if;

  -- 7. ONE CLOCK READ, after every lock this path required, so the invitation
  -- and the entry cannot disagree about when the cycle was closed. The caller
  -- supplies no clock and no instant.
  v_decision_at := clock_timestamp();

  -- 8. THE CLOSE. Guarded on the same facts step 4 read, so a concurrent close
  -- that committed in between matches nothing rather than overwriting.
  update public.new_client_waitlist_invitations i
     set closed_at                 = v_decision_at,
         closed_by_practitioner_id = v_actor
   where i.id          = v_inv
     and i.redeemed_at is not null
     and i.closed_at   is null;

  if not found then
    -- Unreachable while the entry mutex is held -- a competing close would have
    -- blocked at step 2 -- and kept so the command can never report a write it
    -- did not make.
    return 'already_closed';
  end if;

  -- 9. THE ENTRY MOVE, stamped from the SAME instant, and guarded on the
  -- redemption rather than merely on the status -- the asymmetry that produced
  -- the original stranding defect in both release and expire was a guarded
  -- invitation statement beside an unguarded entry statement.
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_decision_at
   where id = p_entry_id and studio_id = p_studio_id
     and status = 'invited'
     and exists (
       select 1
         from public.new_client_waitlist_invitations i
        where i.id          = v_inv
          and i.entry_id    = p_entry_id
          and i.studio_id   = p_studio_id
          and i.redeemed_at is not null)
  returning id into v_hit;

  if v_hit is null then
    -- Reachable only if the entry moved between step 3 and here under the same
    -- lock, which the entry mutex prevents. Kept so the command can never
    -- report a transition it did not make.
    return 'not_invited';
  end if;

  return 'closed';
end;
$$;

comment on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) is
  'WAIT-P1-EXIT: the only exit from a REDEEMED-BUT-UNBOOKED waitlist entry, the '
  'one lifecycle state release, expire, requeue and remove all refuse. Requires '
  'the entry at ''invited'' with an open redeemed invitation and NO appointment '
  'attributable to this cycle; answers already_booked, not_redeemed, '
  'booking_exists or already_closed otherwise. Records closed_at + '
  'closed_by_practitioner_id on the invitation and moves the entry '
  'invited -> released in one transaction under the entry mutex, so a booking in '
  'flight and this exit cannot both succeed. Stamps NO terminal outcome on the '
  'invitation -- the redemption already made the token permanently unusable -- '
  'and does NOT recycle the admission seat, which 0192 rules is spent from the '
  'moment of redemption. Owner-only, own studio, service_role EXECUTE only; the '
  'browser supplies an entry id and nothing else.';

-- ---------------------------------------------------------------------------
-- 5. GRANTS
-- ---------------------------------------------------------------------------
--
-- REVOKED FROM ALL FOUR BY NAME BEFORE THE ONE GRANT. Supabase's ALTER DEFAULT
-- PRIVILEGES grants EXECUTE to anon, authenticated AND service_role at
-- function-create time, and PostgreSQL grants to PUBLIC. 0129 missed `anon` and
-- 0164 missed `service_role`; both are now pinned by
-- tests/security/clinical-rpc-grant-guard.test.ts, and this file names every
-- grantee explicitly so a textual guard can read the contract.
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from public;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from anon;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from authenticated;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from service_role;
grant  execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) to service_role;

-- THE OPERATOR SURFACE HAS TO BE ABLE TO SEE A CLOSED CYCLE.
--
-- 0188 granted SELECT column by column, deliberately: a table-wide grant had
-- returned `token_hash` to an authenticated session. The withheld set is
-- credential and authority material -- the token hash, the proof challenge and
-- capability fields, the scope_* offer terms, and admission_round_id.
--
-- These two are neither. They are lifecycle evidence of exactly the class 0188
-- already grants (`redeemed_at`, `expired_at`, `released_at`) and 0198 extended
-- to `declined_at` on precisely this reasoning. Without them the page cannot
-- tell a closed cycle from an open one and would offer this command on a row it
-- has already acted on -- the fail-open the admission model exists to prevent.
--
-- Owner RLS is untouched and still decides WHICH rows.
grant select (closed_at, closed_by_practitioner_id)
  on public.new_client_waitlist_invitations to authenticated;

commit;
