-- ===========================================================================
-- 0201 — WAIT-P1-EXIT SUCCESSOR: THE EXIT STOPS ASKING A QUESTION IT CANNOT
--        ANSWER
-- ===========================================================================
--
-- 0200 IS APPLIED AND FROZEN. Nothing here edits it. This is the forward
-- correctness repair for three accepted behavioural findings against it, and it
-- redefines exactly ONE function.
--
-- THE THREE FINDINGS, AND WHY THEY ARE ONE FINDING
--
--   1. an appointment CANCELLATION can commit across the repair decision;
--   2. a qualifying appointment CREATION can commit across Close;
--   3. the repair does not enforce the redeemed invitation's scope_* rules.
--
-- All three live in one place: 0200's Step 6, which asked "did this redeemed
-- cycle produce a booking?" by scanning `public.appointments`:
--
--     select count(distinct a.client_id), (array_agg(distinct a.client_id))[1]
--       from public.appointments a
--       join public.clients c on c.id = a.client_id and c.studio_id = a.studio_id
--      where a.studio_id        = p_studio_id
--        and c.normalized_email = v_entry_email
--        and a.status          <> 'cancelled'
--        and a.created_at      >= v_redeemed_at;
--
-- That read takes NO LOCK, and Close holds NO LOCK that any appointment writer
-- also takes. Findings 1 and 2 are the two open windows around it. Finding 3 is
-- the predicate itself: it admits any non-cancelled appointment for the matched
-- client created at or after redemption, including one `create_waitlist_public_
-- appointment` would have refused for service, date or weekday.
--
-- ---------------------------------------------------------------------------
-- WHY THE ANSWER IS NOT A LOCK
-- ---------------------------------------------------------------------------
--
-- The obvious repair -- serialise the scan -- was derived and rejected, because
-- it is both larger and still wrong.
--
--   THE STUDIO ROW IS THE DE-FACTO SERIALISATION POINT for public appointment
--   creation (`create_public_appointment` takes `studios ... for update`),
--   public cancellation (0176) and reschedule (0171). Close takes no EXPLICIT
--   lock on it. Adding one would close those three -- and would have to be
--   taken BEFORE the entry, because 0195 takes studio THEN entry, and
--   entry-then-studio against studio-then-entry is a deadlock cycle.
--
--   MEASURED, and stated because the neater claim is false: Close does touch
--   the studio row, implicitly and AFTER the entry. Its `update` of the entry
--   fires `new_client_waitlist_entries_record_event`, and that audit INSERT
--   takes FOR KEY SHARE on `studios` through the event table's foreign key. So
--   Close CAN WAIT for an ordinary booking to settle. Two consequences, both
--   verified rather than argued:
--
--     * It cannot ANSWER differently, which is the property that matters and
--       is what makes the scan removable at all.
--     * It cannot DEADLOCK against 0195, because FOR KEY SHARE and 0195's
--       `studios ... for no key update` DO NOT CONFLICT -- the implicit lock
--       is granted while 0195 holds the row, so no cycle forms. This is the
--       same conflict-matrix reading as the `FOR SHARE` trap below, applied in
--       the other direction, and both are proven by paired-order tests rather
--       than by reading the matrix.
--
--   This wait is NOT introduced here. 0200 updates the same entry through the
--   same trigger, so it holds identically of the migration being corrected.
--
--   BUT `practitioner_cancel_appointment` AND `mark_appointment_no_show` TAKE
--   ONLY THE APPOINTMENT ROW. No studio lock reaches them. Closing finding 1
--   against the practitioner path needs appointment row locks as well.
--
--   AND NO LOCK CLOSES FINDING 2 PROPERLY. READ COMMITTED has no predicate
--   locking: a row that does not exist yet cannot be locked. Only SERIALIZABLE
--   detects that phantom, and `SET TRANSACTION ISOLATION LEVEL` must be the
--   first statement of a transaction -- unreachable from a SECURITY DEFINER
--   function invoked through PostgREST.
--
--   A trap worth naming, because it looks like protection and is not: 0200's
--   `clients ... FOR SHARE` does not serialise against booking. An appointment
--   INSERT takes FOR KEY SHARE on the client through the foreign key, and FOR
--   SHARE and FOR KEY SHARE DO NOT CONFLICT. That lock only ever guarded the
--   email binding.
--
-- ---------------------------------------------------------------------------
-- WHAT IS ACTUALLY WRONG: THE QUESTION HAS NO ANSWER
-- ---------------------------------------------------------------------------
--
-- `public.appointments` carries NO link to a waitlist cycle -- no entry id, no
-- invitation id. And `create_waitlist_public_appointment` ACCEPTS `p_entry_id`
-- and does not pass it to `create_public_appointment`; the link is dropped at
-- that boundary. The conversion records WHICH CLIENT (`converted_client_id`),
-- never WHICH APPOINTMENT.
--
-- So "which appointment came from this cycle?" is not merely unlocked -- it is
-- UNANSWERABLE AFTER THE FACT. Every implementation of Step 6 must guess, and
-- the three findings are the three ways 0200's guess goes wrong.
--
-- ---------------------------------------------------------------------------
-- AND SINCE 0195, THE GUESS IS NEVER NEEDED
-- ---------------------------------------------------------------------------
--
-- 0195 made the appointment and the conversion ONE TRANSACTION. An entry at
-- `invited` carrying a redeemed invitation therefore CANNOT have a cycle
-- booking: the transaction that would have created one also moves the entry to
-- `converted`, or neither happens. 0200's own header says Step 6 is "the second
-- layer, for the window 0195 closed but history predates".
--
-- It follows that for any cycle redeemed after 0195, Step 6 can only ever match
-- a NON-cycle appointment -- an ordinary booking the person made by another
-- route -- and converting the entry onto it is wrong every single time. That is
-- finding 3 stated as a consequence rather than as a case.
--
-- THE PRE-0195 POPULATION IT WAS WRITTEN FOR IS EMPTY, MEASURED RATHER THAN
-- ASSUMED: at authoring time production held ZERO entries at `invited` with an
-- open redeemed invitation, and ZERO invitations carrying `closed_at` -- Close
-- had never executed. That is a fact about 2026-09-20 and is recorded as one;
-- it is not a licence to skip the proofs below, and the tests construct the
-- stranded shape explicitly rather than relying on its absence.
--
-- ---------------------------------------------------------------------------
-- THE CHANGE
-- ---------------------------------------------------------------------------
--
-- CLOSE STOPS READING `public.appointments`. Its authority contracts to the
-- entry and the entry's invitation, which is exactly what 0195 guarantees is
-- sufficient.
--
--   * FINDING 1 and FINDING 2 are ELIMINATED, not mitigated. A decision that
--     does not depend on appointments cannot race appointment writers, in
--     either commit order, for creation or cancellation, on the public path or
--     the practitioner path.
--   * FINDING 3 is ELIMINATED. There is no second scope predicate left to
--     diverge from 0195's, and none needs extracting.
--
-- NO NEW LOCK IS TAKEN, AND THE LOCK ORDER IS UNCHANGED: entry FOR UPDATE, then
-- invitation FOR UPDATE, exactly as 0200 and as `release` before it. Close
-- already serialises against 0195 through the entry mutex, and 0195 is the only
-- appointment writer that can produce a cycle booking. The `clients FOR SHARE`
-- disappears with the arm that needed it.
--
-- THE RESULT IS SMALLER THAN WHAT IT REPLACES. No booking writer and no
-- cancellation writer is redefined. Ordinary public booking does not acquire a
-- new lock to wait on, which a studio-lock repair would have imposed on the
-- busiest write path in the product for the sake of an operator action.
--
-- WHAT HAPPENS TO AN UNRELATED APPOINTMENT: nothing. The entry closes, the
-- appointment stands and remains completely valid. THAT IS THE CORRECT
-- OUTCOME -- an ordinary booking is not a waitlist conversion, and 0200's
-- converting onto one is the defect, not the service.
--
-- THE RESIDUAL, STATED RATHER THAN HIDDEN: a hypothetical pre-0195 stranded row
-- would now be released without its missing conversion being recorded. Zero
-- such rows exist and 0195 prevents new ones. Surfacing them, if ever wanted,
-- belongs in a READ-ONLY diagnostic an operator can inspect -- never inside the
-- write path, which is what made the decision racy to begin with. That is a
-- separate slice and is deliberately not in this file.
--
-- ---------------------------------------------------------------------------
-- RESULT VOCABULARY
-- ---------------------------------------------------------------------------
--
-- `converted_instead` and `booking_unresolved` BECOME UNREACHABLE. They are not
-- removed from the application's closed union in this change: a caller pinned
-- to 0200's contract must never meet a code it does not know, and an unreachable
-- branch that is never taken costs nothing. Retiring them from the TypeScript
-- vocabulary is a later, separate edit once no deployed caller predates this.
--
-- Every other answer is returned unchanged, character for character:
-- `closed`, `not_found`, `invalid_input`, `already_booked`, `already_closed`,
-- `not_invited`, `not_redeemed`, and the authority codes from the shared
-- resolver.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO
-- ---------------------------------------------------------------------------
--
-- No table, column, index, trigger, policy, constraint or foreign key is
-- created, altered or dropped. No DML. No backfill. No grant change -- the
-- existing service_role-only EXECUTE is re-asserted by name for the same
-- 0129/0164/0184 reason every command in this schema re-asserts it: Supabase's
-- ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at create time, and `create or replace` does not reset an ACL --
-- so the revokes below are what keep the posture true rather than inherited.
--
-- `requeue_new_client_waitlist_entry` is NOT touched. 0200's redemption guard on
-- it is correct and is load-bearing for the one-redeemed-cycle invariant.
-- ===========================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- THE EXIT, CONTRACTED TO THE AUTHORITY IT ACTUALLY HAS
-- ---------------------------------------------------------------------------
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
  v_inv         uuid;
  v_decision_at timestamptz;
  v_hit         uuid;
begin
  -- 1. AUTHORITY, re-derived from (studio, actor) by the same shared resolver
  -- every other command uses. Owner-only, own studio, active practitioner.
  -- Unchanged from 0200.
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then return v_code; end if;
  if p_entry_id is null then return 'invalid_input'; end if;

  -- 2. THE ENTRY MUTEX, scoped by BOTH id and studio_id so the tenancy refusal
  -- and the lock are the same statement. Unchanged from 0200, and it remains
  -- the single serialisation point this command needs: `create_waitlist_public_
  -- appointment` takes the same row FOR UPDATE, so the exit and the only
  -- booking path that can convert this entry cannot both proceed.
  select e.status, e.released_at
    into v_status, v_released_at
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
     for update;

  if not found then return 'not_found'; end if;

  -- 3. IDEMPOTENCY AND STATE. Unchanged from 0200, including the exactness of
  -- the retry test: step 6 stamps the entry's `released_at` and the invitation's
  -- `closed_at` from ONE clock read, so equality between them is proof that THIS
  -- command performed THIS release. Nothing else in the schema writes
  -- `closed_at`. "Some invitation on this entry was closed once" would be the
  -- wrong question, because a closed cycle can be followed by a requeue -- which
  -- 0200's own guard now forbids for a redeemed entry -- or by history this
  -- command did not make.
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
    return 'not_invited';
  end if;

  -- 4. THE OPEN REDEEMED CYCLE, identified by 0200's unique partial index, so
  -- this is a lookup and not a choice. Unchanged from 0200 except that
  -- `redeemed_at` is no longer selected: nothing downstream compares against it
  -- now that no appointment window is derived from it.
  select i.id
    into v_inv
    from public.new_client_waitlist_invitations i
   where i.entry_id    = p_entry_id
     and i.studio_id   = p_studio_id
     and i.redeemed_at is not null
     and i.closed_at   is null;

  if not found then
    -- Unredeemed is not this command's business, and the refusal says which
    -- command is. A live invitation is ended by release; an elapsed one is
    -- recorded by expire. Neither is weakened and neither is duplicated here.
    return 'not_redeemed';
  end if;

  -- 5. LOCK THE INVITATION BY IMMUTABLE ID ALONE, after the entry, exactly as
  -- release does. Unchanged from 0200.
  perform 1 from public.new_client_waitlist_invitations i
    where i.id = v_inv
    for update;

  -- ---------------------------------------------------------------------
  -- 0200's STEP 6 STOOD HERE. IT IS GONE, AND ITS ABSENCE IS THE REPAIR.
  --
  -- Nothing between the invitation lock and the write reads `public.
  -- appointments`, `public.clients`, or any row this transaction has not
  -- already locked. The decision is therefore a pure function of two locked
  -- rows, and no appointment writer -- public create, waitlist create,
  -- public cancel, practitioner cancel, no-show or reschedule -- can change
  -- its outcome in either commit order.
  --
  -- THE ENTRY IS THE AUTHORITY, AND IT IS SUFFICIENT. `invited` carries
  -- `converted_at is null` and `converted_client_id is null` by the
  -- cycle-evidence CHECK, and since 0195 an appointment booked through the
  -- invitation cannot exist without the conversion that moves the entry out
  -- of `invited`. Reading appointments to second-guess that added no safety
  -- and three defects.
  -- ---------------------------------------------------------------------

  -- 6. ONE CLOCK READ, after every lock this path requires, so the invitation
  -- and the entry cannot disagree about when the cycle was closed. The caller
  -- supplies no clock and no instant.
  v_decision_at := clock_timestamp();

  -- 7. THE CLOSE. Guarded on the same facts step 4 read, so a concurrent close
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

  -- 8. THE ENTRY MOVE, stamped from the SAME instant, and guarded on the
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
  'WAIT-P1-EXIT (0201 successor to 0200): the only exit from a REDEEMED-BUT-'
  'UNBOOKED waitlist entry, the one lifecycle state release, expire, requeue and '
  'remove all refuse. Requires the entry at ''invited'' with an open redeemed '
  'invitation; answers already_booked, not_redeemed or already_closed otherwise. '
  'DOES NOT READ public.appointments. 0200 scanned that table unlocked to decide '
  'whether to record a missing conversion, which raced appointment creation and '
  'cancellation in both directions and applied a predicate weaker than 0195''s '
  'scope rules. Since 0195 the appointment and the conversion share one '
  'transaction, so an entry at ''invited'' cannot have a cycle booking and the '
  'scan could only ever match an UNRELATED appointment -- converting onto which '
  'was the defect. The decision is now a pure function of two locked rows: entry '
  'FOR UPDATE, then invitation FOR UPDATE. No booking or cancellation writer '
  'changes, and no new lock is taken. Records closed_at + '
  'closed_by_practitioner_id and moves the entry invited -> released in one '
  'transaction. Stamps NO terminal outcome on the invitation and does NOT '
  'recycle the admission seat, which 0192 rules is spent from redemption. '
  'converted_instead and booking_unresolved are now unreachable. Owner-only, own '
  'studio, service_role EXECUTE only.';

-- ---------------------------------------------------------------------------
-- ACL, RE-ASSERTED BY NAME
-- ---------------------------------------------------------------------------
-- `create or replace function` does NOT reset a function's ACL, so this is
-- belt-and-braces rather than strictly required. It is written anyway because
-- the failure it guards against has occurred three times in this schema -- 0129
-- missed `anon`, 0164 missed `service_role`, 0183 stated an allowlist and
-- enforced a denylist -- and because a reader of this file should be able to see
-- the posture without going to find 0200.
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from public;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from anon;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from authenticated;
revoke execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) from service_role;
grant  execute on function public.close_unbooked_new_client_waitlist_invitation(uuid, uuid, uuid) to service_role;

commit;
