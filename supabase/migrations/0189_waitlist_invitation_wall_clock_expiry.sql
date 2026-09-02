-- ===========================================================================
-- WAIT-03 — TTL DECISIONS MUST USE THE WALL CLOCK, AFTER THE LOCK — 0189
-- ===========================================================================
--
-- 0188 IS APPLIED AND FROZEN. Its bytes are production truth and are NOT edited
-- by this file. This migration corrects the deployed behaviour of exactly two
-- of its commands and touches nothing else: no table, no column, no index, no
-- policy, no trigger, no constraint, no new result word, no signature change.
--
-- THE DEFECT, REPRODUCED BEFORE IT WAS REPAIRED
-- ---------------------------------------------------------------------------
-- PostgreSQL's `now()` is `transaction_timestamp()`: it is fixed at the instant
-- the TRANSACTION began and never advances, no matter how long that transaction
-- subsequently runs or waits. 0188 made every TTL decision with `now()`, so a
-- transaction that began while an invitation was live decided as though it were
-- still live, however much wall-clock time had passed in between.
--
-- Measured against the frozen 0188 on a local PostgreSQL, twice, deterministically:
--
--   A. NO CONTENTION. Transaction begins 23:48:12.168Z; invitation expires
--      23:48:15.123Z; the wall clock is verified past the deadline
--      (clock_timestamp() = 23:48:15.163Z) BEFORE the call is issued.
--      Inside that transaction now() still reads 23:48:12.168Z.
--      redeem_new_client_waitlist_invitation returned `redeemed`.
--
--   B. GENUINE LOCK CONTENTION, PROVED. A second session held the invitation
--      row with SELECT ... FOR UPDATE. The redeeming transaction began at
--      23:48:15.305Z (invitation live until 23:48:21.219Z), issued the redeem,
--      and was proved BLOCKED by polling pg_stat_activity until
--      wait_event_type='Lock', wait_event='transactionid'. The holder released
--      at 23:48:21.274Z — after the deadline — WITHOUT invalidating the row.
--      redeem returned `redeemed`.
--
--   CONTROL. A transaction that BEGAN after the deadline returned
--   `invalid_token`, which is why the defect is invisible to every test whose
--   transaction starts on the far side of the TTL.
--
-- So an expired invitation was redeemable, and the TTL guarantee 0188 states
-- was not the guarantee it enforced. A SECOND, quieter consequence of the same
-- root cause: `redeemed_at = now()` stamped the transaction-start instant, so
-- even a LEGITIMATE redemption recorded a provenance timestamp that is not when
-- the redemption happened. Both are corrected here by the same change.
--
-- WHY NOT A TEXT REPLACEMENT OF now() -> clock_timestamp()
-- ---------------------------------------------------------------------------
-- Because a predicate can be evaluated BEFORE the statement blocks. Putting
-- clock_timestamp() inside the guarded UPDATE's WHERE clause would read the
-- clock on the first evaluation pass and then, after waiting on a row lock,
-- re-qualify the updated tuple — and PostgreSQL's EvalPlanQual re-check is
-- exactly where the stale answer got in. The correction is STRUCTURAL, not
-- lexical:
--
--        1. take the lock that serializes the decision
--        2. THEN read the wall clock, once, into v_decision_at
--        3. decide, and stamp, from that post-lock value
--
-- v_decision_at is a plain timestamptz local. There is no way for it to be
-- re-derived at a different instant, which is the property a function call in a
-- predicate does not have.
--
-- LOCK ORDERING IS PRESERVED, AND NOT INVERTED
-- ---------------------------------------------------------------------------
-- 0188's reviewed order is ENTRY, then invitation: issue(), expire() and
-- release() all take the entry row `for update` before they touch an
-- invitation, so entry and invitation move as one unit.
--
-- expire() KEEPS that exact order and now completes it. 0188 took the ENTRY lock
-- and then decided; the statement that actually serializes the terminal outcome
-- is the INVITATION update, which can block long afterwards. So expire() now
-- locks the entry, THEN this cycle's invitation row by its immutable id, and
-- only then reads the clock. Measured drift before that second lock existed:
-- 3,150 ms, and unbounded in principle. See COMMAND 6 below.
--
-- redeem() took NO lock at all in 0188 and now takes ONE: the invitation row,
-- by its immutable `token_hash`. It never asks for a second lock, so it cannot
-- be the waiter in a cycle, and a command holding the entry lock and waiting on
-- the invitation simply waits for a redemption that is already committing.
-- Locking by token_hash rather than by the mutable outcome columns is
-- deliberate: token_hash is immutable (the 0188 immutability trigger), so the
-- EvalPlanQual re-check after a wait cannot drop the row out of the lock
-- request and hand back a spurious `invalid_token`.
--
-- NO ADVISORY LOCK, no second lock table, no sleep, and no new serialization
-- primitive of any kind.
--
-- WHAT IS DELIBERATELY NOT CHANGED
-- ---------------------------------------------------------------------------
-- issue_new_client_waitlist_invitation computes `expires_at := now() + ttl`.
-- That is a CREATION timestamp, not a TTL decision, and its failure direction is
-- conservative: a transaction that begins early and issues late produces a
-- SHORTER real-world window, never a longer one. No defect was reproduced there,
-- and changing it would move the expires_at value of every future invitation —
-- a semantic change this repair has no evidence to justify. It stays as applied.
--
-- release_new_client_waitlist_entry makes no clock comparison at all: it is
-- operator-driven and terminates an invitation regardless of its window. It is
-- untouched.
--
-- The public result vocabulary is UNCHANGED: redeem still answers
-- `invalid_token` / `redeemed`; expire still answers the closed set
-- 0188 defined, including `not_expired`. This file adds no word, because the
-- correction makes existing words TRUE rather than describing a new outcome —
-- most visibly `already_redeemed`, which 0188 could miss entirely because it
-- read the redemption BEFORE taking the invitation lock, and answered
-- `not_expired` for an invitation that had in fact been redeemed.
--
-- PRESERVED VERBATIM: both signatures, both return types, SECURITY DEFINER,
-- `set search_path = pg_catalog, pg_temp`, volatility, the entry mutex, the
-- redemption-is-terminal precedence in expire(), append-only provenance,
-- same-studio FK semantics, RLS posture, and token_hash privacy (no function
-- returns or logs it).
--
-- ACLs ARE REASSERTED BY NAME rather than assumed. CREATE OR REPLACE preserves
-- an existing ACL, but Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to
-- anon, authenticated AND service_role at function-create time, and this repo
-- has been bitten twice by trusting that (0129 missed anon, 0164 missed
-- service_role). Every role is named explicitly below.
--
-- NO APPLICATION CALLER. WAIT-03 has no runtime caller in the application and
-- this file activates nothing; the feature remains dark.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- COMMAND 5 — REDEEM. Lock the invitation, then read the clock, then decide.
-- ---------------------------------------------------------------------------
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
  v_studio      uuid;
  v_entry       uuid;
  v_hash        text;
  v_inv         uuid;
  v_decision_at timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  -- Hash ONCE. 0188 recomputed it inline; holding it in a local keeps the lock
  -- request and the guarded update provably keyed on the same value.
  v_hash := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  -- SERIALIZE THE DECISION. This is the statement that blocks when another
  -- command holds the row, and it is deliberately keyed on token_hash alone --
  -- an immutable column -- so a wait that ends in an EvalPlanQual re-check
  -- still resolves to the same row instead of silently losing it.
  select i.id into v_inv
    from public.new_client_waitlist_invitations i
   where i.token_hash = v_hash
   for update;

  if v_inv is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  -- THE CLOCK IS READ HERE, AFTER THE LOCK, AND NOWHERE ELSE. Every comparison
  -- and every stamp below uses this one value, so the row cannot be judged
  -- against one instant and stamped with another.
  v_decision_at := clock_timestamp();

  -- The outcome columns are re-tested under the lock: a release or expiry that
  -- committed while this call waited is visible here, so redeem||expire still
  -- yields exactly one terminal state.
  update public.new_client_waitlist_invitations i
     set redeemed_at = v_decision_at
   where i.id          = v_inv
     and i.redeemed_at is null
     and i.expired_at  is null
     and i.released_at is null
     and i.expires_at  > v_decision_at
  returning i.studio_id, i.entry_id into v_studio, v_entry;

  if v_studio is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  return query select 'redeemed'::text, v_studio, v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND 6 — EXPIRE. Entry mutex, THEN the invitation row, THEN the clock.
-- ---------------------------------------------------------------------------
-- WHY THE ENTRY LOCK ALONE IS NOT ENOUGH, MEASURED. An earlier draft of this
-- file moved the clock read to just after 0188's entry mutex. That closes the
-- transaction-start staleness but not the whole defect, because the statement
-- that actually serializes the terminal outcome is the INVITATION update, and
-- it can block long after the clock was read:
--
--   TTL already elapsed. A second session held the invitation row FOR UPDATE.
--   This command took the entry mutex (proved: a third session then blocked on
--   the ENTRY row), captured v_decision_at, and blocked in the invitation
--   UPDATE. The holder ROLLED BACK 3.15 s later. Expiry succeeded and stamped
--   expired_at 2026-09-02T00:50:39.229Z while the lock that serialized it was
--   released at 00:50:42.379Z -- 3,150 ms of provenance drift, and unbounded in
--   principle, because a holder may wait arbitrarily long.
--
--   Worse, in the COMMIT variant the pre-UPDATE "already redeemed" check ran
--   BEFORE the invitation lock, so it read a snapshot in which the competing
--   redemption had not yet committed. A redemption then committed, and this
--   command answered `not_expired` for an invitation that was REDEEMED, leaving
--   the entry `invited`. The vocabulary was not wrong; the read was too early.
--
-- SO THE INVITATION ROW IS LOCKED BEFORE ANY DECISION IS READ OR TAKEN, and
-- every terminal fact below is read FROM THAT LOCKED ROW.
--
-- LOCK ORDER IS UNCHANGED AND STILL ENTRY -> INVITATION, which is 0188's
-- reviewed global order (issue, release and this command all take the entry row
-- first). redeem holds the invitation ONLY and never reaches for the entry, so
-- no path acquires INVITATION -> ENTRY and there is no cycle.
--
-- THE CURRENT CYCLE IS IDENTIFIED DETERMINISTICALLY. An entry may be invited,
-- expire, be requeued and be invited again, so it can carry several invitation
-- rows. The newest by (issued_at, id) is this cycle's; the entry mutex is what
-- makes that stable, because issue() cannot add one while we hold it. The lock
-- is then requested on that row's IMMUTABLE id -- never on the mutable terminal
-- columns, which would let the target disappear from the lock request after a
-- concurrent terminal transition and hand back a spurious answer.
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
  v_redeemed    timestamptz;
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

  -- 2. IDENTIFY AND LOCK THIS CYCLE'S INVITATION, by immutable id. Ordering by
  -- issued_at picks the current cycle rather than a historical one; the entry
  -- mutex above is what makes that choice stable.
  select i.id, i.redeemed_at, i.expired_at, i.released_at, i.expires_at
    into v_inv, v_redeemed, v_expired, v_released, v_expires
    from public.new_client_waitlist_invitations i
   where i.entry_id = p_entry_id
     and i.studio_id = p_studio_id
   order by i.issued_at desc, i.id desc
   limit 1
   for update;

  -- 3. THE CLOCK IS READ HERE -- after BOTH locks -- and nowhere else. Every
  -- comparison and every stamp below uses this one value, so the decision and
  -- the provenance it writes cannot disagree, and neither can be older than the
  -- lock that serialized the outcome.
  v_decision_at := clock_timestamp();

  -- The entry was never invited, so there is nothing to expire.
  if v_inv is null then
    return 'not_invited';
  end if;

  -- 4. TERMINAL STATE, READ FROM THE LOCKED ROW. Every branch below is decided
  -- on values that were read under the invitation lock, so a redemption that
  -- committed while this call waited is visible rather than missed.
  --
  -- REDEMPTION IS TERMINAL, and it is still checked before anything is written.
  if v_redeemed is not null then
    return 'already_redeemed';
  end if;

  -- Already expired by an earlier call: idempotent, same closed word.
  if v_expired is not null then
    return 'expired';
  end if;

  -- Released invitations are not expirable, and `released` is not this
  -- command's word. 0188 reached `not_invited` here by exhaustion; it is stated
  -- directly now that the row is in hand, and the answer is unchanged.
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

-- ---------------------------------------------------------------------------
-- PRIVILEGES — reasserted by name, never assumed.
-- ---------------------------------------------------------------------------
-- The intended posture, identical to 0188 and verified against production:
-- postgres=X, service_role=X, and NOTHING for PUBLIC, anon or authenticated.
-- Enumerated explicitly because ALTER DEFAULT PRIVILEGES grants EXECUTE to all
-- three application roles at create time and CREATE OR REPLACE would preserve
-- whatever an out-of-band re-grant had left behind.
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

commit;
