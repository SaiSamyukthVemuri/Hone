-- ===========================================================================
-- WAIT-03 — ATOMIC INVITATION BOOKING + CONVERSION — 0195
-- ===========================================================================
--
-- THE DEFECT THIS CLOSES. An invitation booking was three separate database
-- transactions driven from the application:
--
--     T1  redeem the invitation
--     T2  create_public_appointment
--     T3  record_new_client_waitlist_conversion
--
-- If the process disappeared between T2 committing and T3 running, the
-- appointment was durable and the waitlist entry stayed `invited` FOREVER. No
-- exception handler, log line, retry or reconciler could repair it, because the
-- thing that would have run them no longer existed. The prospect held an
-- appointment while the queue still showed them waiting to hear back, the
-- admission round's allowance was never reconciled, and the next operator sweep
-- could invite the same person again.
--
-- Moving T3 earlier cannot fix this; it only moves the window. Two commits with
-- a gap between them have a gap between them. The window closes only when the
-- appointment and the conversion share ONE transaction.
--
-- THE PRECEDENT IS THIS COMMAND'S OWN HISTORY. `appointment_audit` used to be
-- written by the application after `create_public_appointment` returned. 0170
-- moved it INSIDE, "in the same transaction as the appointment, so it cannot be
-- skipped or silently fail". This is that argument, for the same command, about
-- the next row that must not be skippable.
--
-- ---------------------------------------------------------------------------
-- COMPOSE, DO NOT DUPLICATE
-- ---------------------------------------------------------------------------
--
-- This command calls `public.create_public_appointment` and
-- `public.record_new_client_waitlist_conversion` and reimplements neither. Both
-- keep their signatures, their grants and their callers. Ordinary public
-- booking continues to call `create_public_appointment` DIRECTLY and is not
-- routed through here — it has no waitlist entry and must not acquire waitlist
-- locks.
--
-- PostgreSQL has no autonomous transactions: a PL/pgSQL function executes in its
-- caller's transaction. Both callees are exception-free, so neither opens a
-- subtransaction of its own, and composing them yields one atomic unit.
--
-- ---------------------------------------------------------------------------
-- THE ROLLBACK LAW, AND WHY `return` IS NOT ENOUGH
-- ---------------------------------------------------------------------------
--
-- If conversion refuses AFTER the appointment rows are already inserted, a plain
-- `return` would leave those inserts in the transaction — the caller would see a
-- refusal and the appointment would still commit. That is the defect wearing a
-- different hat.
--
-- So the composed work runs inside a subtransaction and refusals are raised as
-- SQLSTATE 'WA002'. Raising unwinds every mutation made inside that block; the
-- handler then returns a closed result code. This is the pattern 0193's
-- `admit_new_client_waitlist_entry` already uses with 'WA001' — the same shape,
-- a distinct code, so a nested failure can never be mistaken for this one.
--
-- 'WA002' IS PRIVATE. It never reaches a caller: the handler converts it to a
-- result string. No SQLSTATE and no raw database message crosses this boundary.
--
-- ---------------------------------------------------------------------------
-- THE ENTRY ID IS SUPPLIED, NOT INFERRED
-- ---------------------------------------------------------------------------
--
-- `p_entry_id` is the authoritative id the server-side redemption path already
-- holds. It is NEVER inferred from the email, the client id, invitation
-- chronology or queue order — every one of those can name the wrong person when
-- two prospects share an address or an entry has been removed and rejoined.
--
-- Supplied is not the same as trusted: `record_new_client_waitlist_conversion`
-- re-verifies the entry belongs to `p_studio_id` and is in a convertible state
-- under its own row lock, and this command does not weaken that. A foreign or
-- non-invited entry refuses, and the refusal rolls the appointment back.
--
-- ---------------------------------------------------------------------------
-- THE EXECUTABLE LOCK SEQUENCE, INCLUDING THE NESTED UPGRADE
-- ---------------------------------------------------------------------------
--
--   1. studios                        FOR NO KEY UPDATE   (this function)
--   2. new_client_waitlist_entries    FOR UPDATE          (this function, target row)
--   3. clients                        FOR SHARE           (this function, the bound
--                                                          recipient — see RECIPIENT
--                                                          BINDING below)
--   4. studios                        FOR UPDATE          <-- UPGRADE, inside
--                                                             create_public_appointment
--   5. acquire_studio_capacity_lock   advisory            (nested)
--   6. services                       FOR UPDATE          (nested)
--   7. appointments                   FOR UPDATE          (nested, overlap scan)
--   8. new_client_waitlist_entries    FOR UPDATE          (nested, already held at 2)
--   9. new_client_waitlist_invitations FOR UPDATE         (nested, conversion)
--  10. studios                        FK KEY SHARE        (nested, entry-event
--                                                          trigger insert; already
--                                                          covered by 4)
--  11. clients                        FK KEY SHARE        (nested, appointment and
--                                                          conversion FKs; compatible
--                                                          with the SHARE at 3)
--
-- STEP 4 IS A LOCK UPGRADE AND THE HEADER MUST SAY SO. `create_public_appointment`
-- takes `studios … FOR UPDATE`, so this transaction ends up holding FOR UPDATE on
-- a row it first took as NO KEY UPDATE. An earlier revision of this comment
-- described the sequence as a "strict append" over "disjoint" object sets. Both
-- claims were wrong: the object sets overlap on `studios`, and the studio lock
-- is taken twice at two different strengths.
--
-- WHY STEP 1 IS NO KEY UPDATE. `record_new_client_waitlist_conversion` UPDATEs
-- the entry, which fires `new_client_waitlist_entries_record_event`, which
-- INSERTs into `new_client_waitlist_entry_events`, whose `studio_id` FK requests
-- KEY SHARE on the studio. FOR UPDATE blocks that; NO KEY UPDATE does not. 0193's
-- admit chose the same mode for the same reason and says so in its own comments.
--
-- WHY STEP 2 COMES BEFORE STEP 4. Without it the transaction would hold
-- `studios FOR UPDATE` (acquired at 4) and only then request the entry, while a
-- concurrent conversion holds that entry and waits for the KEY SHARE at 10. That
-- cycle was MEASURED as a reproducible 40P01 before this repair. Taking the entry
-- first inverts nothing, because conversion also reaches the entry before it ever
-- touches the studio: its own statements are entry -> invitation, and its only
-- studio lock is the FK one raised by the UPDATE at the end. A competing
-- conversion therefore blocks on the entry while holding nothing on the studio.
--
-- ---------------------------------------------------------------------------
-- RECIPIENT BINDING — WHY STEP 3 EXISTS
-- ---------------------------------------------------------------------------
--
-- An independent review found that this command took `p_client_id` ON TRUST. It
-- verified nothing about WHO that client was. `record_new_client_waitlist_conversion`
-- checks only that the client EXISTS IN THE SAME STUDIO ('client_not_found') — a
-- same-studio check is NOT a same-person check. So a caller could redeem person
-- A's invitation, pass person B's client id, and the transaction would book B's
-- appointment and mark A's entry converted to B. Both halves committed together,
-- which is exactly the atomicity this migration promises — of the wrong pairing.
--
-- THE PREDICATE IS THE REPOSITORY'S OWN, NOT A NEW RULE. Two generated, stored
-- columns already define normalized identity, and this command compares them:
--
--   new_client_waitlist_entries.email_normalized  = lower(btrim(email))     (0185)
--   clients.normalized_email                      = lower(trim(email)),     (0032)
--                                                   null when blank
--
-- `trim` IS `btrim`, so the two agree. `clients_studio_normalized_email_uniq`
-- makes that value unique per studio, and `find_or_create_client_for_booking`
-- resolves a booking's client by exactly this equality. Binding to it therefore
-- preserves BOTH legitimate paths: a returning client matched on normalized
-- email, and a brand-new client just inserted from the entry's own address.
-- Nothing here reads a name, and nothing trusts a browser-supplied address —
-- the entry side is the stored invitation record.
--
-- FAIL CLOSED. A null on either side refuses. A blank entry email normalizes to
-- '' while a blank client email normalizes to NULL, so that pair refuses too.
--
-- WHY FOR SHARE, AND WHY IT IS NOT KEY SHARE. `clients.email` is not a key
-- column, so `UPDATE clients SET email = …` takes FOR NO KEY UPDATE on the row.
-- KEY SHARE does NOT conflict with that, and would let the bound identity change
-- after the check and before the commit. FOR SHARE does conflict, so the row the
-- binding was proved against cannot be re-pointed mid-transaction. It is also no
-- stronger than needed: SHARE and KEY SHARE are compatible, so the FK checks at
-- step 11 — and any concurrent transaction merely referencing this client — are
-- unaffected.
--
-- THE BOOKING SCOPE IS A SEPARATE, UNCLOSED QUESTION. The same review asked for
-- the redeemed invitation's booking scope to be enforced — that the service and
-- start time be the ones offered. `new_client_waitlist_invitations` records no
-- offered service and no offered slot (0188: id, studio_id, entry_id, token_hash,
-- issued_at, expires_at, issued_by_practitioner_id, redeemed_at, expired_at,
-- released_at, declined_at). There is no authority in the schema to check
-- against, so this command does NOT claim to enforce it and does not guess one.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS TESTED, AND WHAT IS NOT CLAIMED
-- ---------------------------------------------------------------------------
--
-- THIS DOES NOT CLAIM UNIVERSAL DEADLOCK FREEDOM. What was measured, against a
-- fresh chain on an isolated local database, is that these pairs complete with
-- no 40P01 and no timeout:
--
--   * two invitation bookings competing for one redeemed entry (contention
--     observed on every run);
--   * invitation booking vs a standalone conversion on the same entry — the
--     pair that previously deadlocked;
--   * invitation booking vs conversion on a different entry in the same studio;
--   * invitation booking vs 0193 admission;
--   * invitation booking vs ordinary public booking.
--
-- THE SUPPORTED TRANSACTION MODEL IS ONE RPC PER TRANSACTION, which is what the
-- application does: a server action calls this command once and the statement is
-- its own transaction. A caller that composes THIS command with other
-- studio-FK-writing statements inside one explicit transaction is OUTSIDE the
-- tested model — such a transaction could hold a studio KEY SHARE before
-- reaching step 1 and has not been analysed here.
--
-- THE COST, STATED. The studio row lock and the capacity advisory lock are held
-- across the conversion work as well. That is a throughput cost, not a
-- correctness one, and it is the price of the invariant.
--
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- A NOTE ON HOW THIS WAS PROVED, SO THE WRONG TEST IS NOT REVIVED
-- ---------------------------------------------------------------------------
--
-- A concurrency harness may give a participant a "prefix" lock only if that is
-- the FIRST LOCK THAT PARTICIPANT'S OWN COMMAND TAKES. For a standalone
-- conversion the entry qualifies; for THIS command it does not, because this
-- command takes the studio first.
--
-- Applying an entry-first prefix to this studio-first command produced a
-- 40P01 that was reported as a defect in the lock policy and was not one: the
-- harness had manufactured an order no caller can produce. Two clean
-- invocations racing on one redeemed entry were then measured five times with
-- observed contention, and every run gave one winner, one closed refusal, one
-- appointment and a converted entry.
--
-- Related: each participant must own BEGIN -> work -> COMMIT/ROLLBACK. Deferring
-- both commits until after the race resolves makes a blocked participant wait on
-- a transaction that cannot end until it returns, which reports as a timeout and
-- proves nothing.
--
-- -- WHAT REMAINS LEGAL, AND MUST
-- ---------------------------------------------------------------------------
--
-- `invitation redeemed AND no appointment` is still reachable and still correct:
-- redemption is its own earlier transaction, by design, so a visitor who
-- abandons the flow leaves a spent invitation and no booking. That is the
-- accepted consumed-without-booking state with an operator recovery path.
--
-- What is now UNREACHABLE is `appointment exists AND entry.status = 'invited'`.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.create_waitlist_public_appointment(
  p_studio_id               uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text,
  p_entry_id                uuid,
  p_notes                   text default null,
  p_referral_source         text default null
)
returns table (
  result           text,
  appointment_id   uuid,
  starts_at        timestamptz,
  ends_at          timestamptz,
  duration_minutes integer,
  practitioner_id  uuid,
  created_at       timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt         record;
  v_conversion   text;
  v_entry_email  text;
  v_client_email text;
begin
  -- ---------------------------------------------------------------------
  -- LOCK POLICY. Measured, not assumed — see the lock-order note below.
  --
  -- studios FOR NO KEY UPDATE, deliberately NOT FOR UPDATE. This is the mode
  -- 0193's admit already chose for this row, and its comment states why:
  -- FOR UPDATE blocks the KEY SHARE that the lifecycle writers' event-trigger
  -- inserts need. `record_new_client_waitlist_conversion` UPDATEs the entry,
  -- which fires `new_client_waitlist_entries_record_event`, which INSERTs into
  -- `new_client_waitlist_entry_events`, whose `studio_id` FK requests exactly
  -- that KEY SHARE. NO KEY UPDATE does not conflict with it; FOR UPDATE does.
  --
  -- THEN THE TARGET ENTRY, BEFORE `create_public_appointment` RUNS. That
  -- command takes studios FOR UPDATE, so without this line the transaction
  -- would hold FOR UPDATE on the studio and only afterwards request the entry —
  -- while a concurrent conversion holds the entry and waits for its KEY SHARE
  -- on the same studio. That is a cycle, and it was MEASURED as a reproducible
  -- 40P01 before this repair.
  --
  -- Taking the entry first inverts nothing, because conversion also reaches the
  -- entry before it ever touches studios: its own statements are entry
  -- FOR UPDATE -> invitation FOR UPDATE, and its only studios lock is the FK
  -- one, raised by the UPDATE at the end. So a competing conversion blocks on
  -- the entry while holding nothing on the studio, and no cycle can form.
  --
  -- Both statements are PERFORM, so a missing row is simply no lock; the
  -- validation below still produces the closed refusal.
  -- ---------------------------------------------------------------------
  -- Cheap, closed refusal BEFORE anything is locked or written. `p_entry_id` is
  -- what separates this command from ordinary booking; without it the caller
  -- wanted `create_public_appointment` and should have called it. This now runs
  -- ahead of the locks: locking on a NULL id matched nothing anyway.
  if p_studio_id is null or p_client_id is null or p_entry_id is null then
    return query select 'invalid_input'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  perform 1 from public.studios where id = p_studio_id for no key update;

  -- STEP 2. The entry, and its IDENTITY, are read under the lock. An earlier
  -- revision used PERFORM here and never inspected FOUND, so a missing or
  -- cross-studio entry produced no lock AND no refusal — the guard read as a
  -- tenancy check while enforcing nothing. Scoping by BOTH id and studio_id
  -- means a cross-studio entry is simply not found.
  select e.email_normalized
    into v_entry_email
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
     for update;

  if not found then
    return query select 'entry_not_found'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- STEP 3. THE RECIPIENT BINDING. See the header: this is the check whose
  -- absence let person A's invitation book person B's appointment. FOR SHARE,
  -- not KEY SHARE, so a concurrent `UPDATE clients SET email = …` (which takes
  -- FOR NO KEY UPDATE) cannot re-point this identity after the comparison.
  select c.normalized_email
    into v_client_email
    from public.clients c
   where c.id = p_client_id and c.studio_id = p_studio_id
     for share;

  if not found then
    return query select 'client_not_found'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  -- Fail closed on either side being absent; never treat two NULLs as a match.
  if v_entry_email is null
     or v_client_email is null
     or v_client_email <> v_entry_email then
    return query select 'recipient_mismatch'::text,
      null::uuid, null::timestamptz, null::timestamptz,
      null::integer, null::uuid, null::timestamptz;
    return;
  end if;

  begin
    -- 1. THE APPOINTMENT. Every refusal it can emit is a closed code; only
    --    'created' continues. Its own validation, capacity, overlap and audit
    --    behaviour are untouched and unduplicated.
    select * into v_appt
      from public.create_public_appointment(
        p_studio_id,
        p_client_id,
        p_service_id,
        p_starts_at,
        p_cancellation_token_hash,
        p_notes,
        p_referral_source
      );

    if v_appt.result is distinct from 'created' then
      -- Nothing has been written that needs unwinding, but raising keeps ONE
      -- exit path for every refusal rather than two that could drift apart.
      raise exception 'appointment:%', v_appt.result using errcode = 'WA002';
    end if;

    -- Belt and braces: a 'created' result with no id would mean the command
    -- changed shape underneath us, which is an inconsistency, not a refusal.
    if v_appt.appointment_id is null then
      raise exception 'inconsistent:appointment_without_id' using errcode = 'WA002';
    end if;

    -- 2. THE CONVERSION, in this same transaction. `p_client_id` is the resolved
    --    client the appointment was actually created for — the same value the
    --    command above was given — so the converted row can never name a
    --    different person than the booking.
    v_conversion := public.record_new_client_waitlist_conversion(
      p_studio_id,
      p_entry_id,
      p_client_id
    );

    if v_conversion is distinct from 'converted' then
      -- THE LOAD-BEARING LINE. This unwinds the appointment and its audit row.
      -- A `return` here would commit a booking whose conversion refused, which
      -- is the exact state this migration exists to make unreachable.
      raise exception 'conversion:%', v_conversion using errcode = 'WA002';
    end if;

    return query select 'created_and_converted'::text,
      v_appt.appointment_id, v_appt.starts_at, v_appt.ends_at,
      v_appt.duration_minutes, v_appt.practitioner_id, v_appt.created_at;
    return;

  exception
    when sqlstate 'WA002' then
      -- Every mutation inside the block above is now rolled back. SQLERRM
      -- carries the closed code this command chose; no SQLSTATE and no raw
      -- database text crosses the boundary.
      return query select SQLERRM::text,
        null::uuid, null::timestamptz, null::timestamptz,
        null::integer, null::uuid, null::timestamptz;
      return;
  end;
end;
$$;

comment on function public.create_waitlist_public_appointment(
  uuid, uuid, uuid, timestamptz, text, uuid, text, text
) is
'WAIT-03: create a public appointment for an invitation booking and record the '
'waitlist conversion in ONE transaction. Composes create_public_appointment and '
'record_new_client_waitlist_conversion; reimplements neither. A conversion '
'refusal rolls the appointment back via the private WA002 sentinel, so '
'"appointment exists AND entry.status = invited" is unreachable. Ordinary public '
'booking does NOT route through here and is unchanged. p_entry_id is the '
'authoritative redeemed entry supplied by the server, never inferred from email, '
'client id, invitation chronology or queue order.';

-- GRANTS. Supabase''s ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
-- authenticated AND service_role at create time, so all three are revoked by
-- name — the omission that shipped in 0129 (anon) and again in 0164
-- (service_role). This is a server-only command reached from a server action
-- holding the service role; no browser role may call it.
revoke execute on function public.create_waitlist_public_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text, text) from public;
revoke execute on function public.create_waitlist_public_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text, text) from anon;
revoke execute on function public.create_waitlist_public_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text, text) from authenticated;
revoke execute on function public.create_waitlist_public_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text, text) from service_role;
grant  execute on function public.create_waitlist_public_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text, text) to service_role;

commit;
