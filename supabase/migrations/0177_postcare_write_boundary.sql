-- ===========================================================================
-- APPOINTMENT BOUNDARY B8 — govern postcare claim + settlement writes
-- ===========================================================================
--
-- THE LAST DIRECT WRITER SURFACE
-- ---------------------------------------------------------------------------
-- B5 / 0174 revoked service_role's appointment DML except for ONE deliberate,
-- temporary exception: column-level UPDATE on the six postcare bookkeeping
-- columns, because seven application statements still wrote them directly —
-- four in the manual send action, three in the auto-send helper. 0174's own
-- comment named B8 as the owner of that removal. This file is that removal.
--
-- Those seven statements are replaced by TWO commands, not seven RPCs, because
-- the shape is a single state machine:
--
--     CLAIM  ->  provider call (OUTSIDE any transaction)  ->  SETTLE
--
-- The provider call cannot be inside a database transaction, and pretending
-- otherwise would hold a row lock across a network round trip. The integrity
-- primitive is therefore not a lock but a DB-ISSUED CLAIM TOKEN: the exact
-- `postcare_email_claimed_at` the claim wrote. Settlement may only touch the
-- row while that token still matches, which is what makes a late response from
-- a superseded sender harmless.
--
-- AFTER THIS MIGRATION
--   service_role on public.appointments: SELECT only. No INSERT/UPDATE/DELETE,
--   no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, and ZERO column-level UPDATE.
--   The B1 direct-appointment-writer census goes 7 -> 0.
--
-- ONE B4 INTEGRATION RULE TRAVELS WITH THE CLAIM
--   Introducing a claim introduces a state B4/0173 has never seen: an
--   appointment with an external email in flight. 0173's repair command asks
--   `appointment_has_blocking_dependents` whether reopening an outcome is safe,
--   and that helper only knew about a COMPLETED postcare send. A claim that has
--   not settled yet was invisible to it, so an owner could reopen the visit in
--   the window between claim and settlement and the send would still land.
--   This file therefore REPLACES that one helper — same five blocker classes,
--   same order, plus `postcare_in_flight`. See the section below.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT TOUCH
--   * `snapshot_appointment_buffer()` — STANDING PROHIBITION. Production
--     carries out-of-band GUC behaviour there that this repository's migration
--     source does not represent. Not created, replaced, dropped or referenced.
--   * 0173 itself. It is applied production history and its bytes stay frozen;
--     the helper is REPLACED from here, and neither `revert_appointment_outcome`
--     nor `set_appointment_notes` is REDEFINED — they already call the helper by
--     name, so they pick the new class up without being touched. The one
--     exception is metadata, not logic: `revert_appointment_outcome`'s catalog
--     COMMENT said "five ... classes" and is corrected to six by a standalone
--     COMMENT ON at the end of the B4 section. No body, no signature, no
--     privilege change.
--   * B6/0175's transition matrix, mark_appointment_complete, the transition
--     guard, the updated_at trigger and the capacity trigger.
--   * B7/0176's cancellation commands and the policy acknowledgement.
--   * appointment attribution, the append-only audit guard, the reservation
--     trigger and the Google outbox trigger.
--   * every payment object.
--
-- Postcare updates pass through B6's ordinary `appointments_set_updated_at_trg`
-- like any other write. Nothing here bypasses it, changes `status`, or touches
-- a timing/capacity column — so the capacity trigger (which watches only
-- studio_id and practitioner_id) cannot fire from a postcare-only update.
--
-- NO NEW AUDIT EVENT. The seven statements being replaced produce no
-- appointment_audit row today, and B8 is bookkeeping-boundary hardening rather
-- than a new semantic event taxonomy. The audit delta from claim/settle is 0.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- COMMAND 1 — claim_postcare_send
-- ---------------------------------------------------------------------------
-- Wins, or does not win, the right to call the email provider.
--
-- AUTHORITY, STATED PRECISELY BECAUSE THE IMPRECISE VERSION IS FLATTERING.
--
-- This command does NOT authenticate anybody. It is service_role-callable, and
-- service_role is a transport identity: the TRUSTED CALL SITE authenticates the
-- human, resolves the practitioner server-side, and supplies that id. What the
-- database does is VALIDATE the supplied identity — `p_actor_practitioner_id`
-- must be an ACTIVE practitioner of `p_studio_id` — and reject an inactive or
-- cross-studio actor outright.
--
-- WHAT THIS IS NOT. There is no cryptographic or session binding between the
-- supplied practitioner id and the authenticated human under service_role. A
-- caller already holding service_role CAN name a different active same-studio
-- practitioner, and this validation will accept it. That is a real residual
-- trust in the call site, and it is the same posture every other governed
-- appointment command carries; describing it as the database "authenticating
-- the practitioner" would overstate what the boundary actually buys.
--
-- WHAT IT DOES BUY, which is not nothing: a service_role caller cannot invent an
-- actor, act for a deactivated practitioner, or reach across studios, and the
-- membership rule cannot be skipped by a call site that simply asserts it.
-- Any active same-studio practitioner may send postcare; the
-- appointment's own practitioner assignment is deliberately NOT required,
-- because that matches the studio-member operational boundary the product
-- already has, and narrowing it here would be a silent behaviour change.
--
-- LIFECYCLE. B8 hardens what the application only implied: postcare requires
-- `status = 'completed'`, for the manual AND automatic paths. Sending aftercare
-- for a visit that was cancelled, no-showed, or has not happened yet is not a
-- race — it is wrong.
--
-- THE STALE WINDOW LIVES HERE, not in a caller parameter. Five minutes, the
-- existing operational contract: a claim younger than that is respected (a send
-- may genuinely still be in flight), an older one is assumed dead and is
-- reclaimable. A caller-supplied window would let any caller reclaim instantly.
create or replace function public.claim_postcare_send(
  p_appointment_id        uuid,
  p_studio_id             uuid,
  p_actor_practitioner_id uuid,
  p_is_resend             boolean
) returns table (
  result           text,
  claimed_at       timestamptz,
  send_attempts    integer,
  previous_sent_at timestamptz
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
  v_now  timestamptz;
begin
  -- ACTOR. Checked before the row is located so a cross-studio caller learns
  -- nothing about whether the appointment exists.
  if not exists (
    select 1 from public.practitioners p
     where p.id = p_actor_practitioner_id
       and p.studio_id = p_studio_id
       and p.active = true
  ) then
    return query select 'not_authorized'::text, null::timestamptz, null::integer, null::timestamptz;
    return;
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz, null::integer, null::timestamptz;
    return;
  end if;

  -- LIFECYCLE GATE.
  if v_appt.status <> 'completed' then
    return query select 'not_completed'::text, null::timestamptz, null::integer, v_appt.postcare_email_sent_at;
    return;
  end if;

  if coalesce(p_is_resend, false) then
    -- A resend of something never successfully sent is not a resend.
    if v_appt.postcare_email_sent_at is null then
      return query select 'never_sent'::text, null::timestamptz, null::integer, null::timestamptz;
      return;
    end if;
  else
    -- First send. Already-sent is a different action, and the caller must say so.
    if v_appt.postcare_email_sent_at is not null then
      return query select 'already_sent'::text, null::timestamptz, null::integer, v_appt.postcare_email_sent_at;
      return;
    end if;
  end if;

  -- FRESH CLAIM WINS. This is the concurrency primitive, and it applies to
  -- resends too — which is a deliberate improvement: two concurrent resends
  -- could previously both reach the provider, mitigated only by a disabled
  -- button. Now exactly one wins the claim.
  if v_appt.postcare_email_claimed_at is not null
     and v_appt.postcare_email_claimed_at > now() - interval '5 minutes'
  then
    return query select 'already_claimed'::text, null::timestamptz, null::integer, v_appt.postcare_email_sent_at;
    return;
  end if;

  -- The claim. One DB clock reading is used for BOTH stamps, so claimed_at and
  -- last_attempt_at are provably the same instant and the returned token is
  -- exactly what landed in the row.
  --
  -- TRUNCATED TO MILLISECONDS, and this is load-bearing rather than cosmetic.
  -- The token leaves the database as JSON and comes back through JavaScript,
  -- whose Date carries milliseconds — so a microsecond-precision timestamptz
  -- would be silently rounded in transit and NO settlement would ever match its
  -- own claim. Every send would look like a stale claim and nothing would ever
  -- be marked sent. Millisecond truncation is the same convention 0171 applies
  -- to appointment timestamps that cross this boundary.
  v_now := date_trunc('milliseconds', now());

  update public.appointments a
     set postcare_email_claimed_at      = v_now,
         postcare_email_last_attempt_at = v_now,
         postcare_email_send_attempts   = coalesce(a.postcare_email_send_attempts, 0) + 1
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   returning a.postcare_email_send_attempts, a.postcare_email_sent_at
        into v_appt.postcare_email_send_attempts, v_appt.postcare_email_sent_at;

  return query select 'claimed'::text, v_now, v_appt.postcare_email_send_attempts,
                      v_appt.postcare_email_sent_at;
end;
$$;

comment on function public.claim_postcare_send(uuid, uuid, uuid, boolean) is
  'B8/0177. Wins the right to send postcare for a COMPLETED appointment. '
  'Returns the DB-issued claimed_at, which is the token settle_postcare_send '
  'requires. Five-minute stale window lives here, never in a parameter.';

revoke execute on function public.claim_postcare_send(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_postcare_send(uuid, uuid, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- COMMAND 2 — settle_postcare_send
-- ---------------------------------------------------------------------------
-- THE CLAIM TOKEN IS LOAD-BEARING. Settlement mutates the row only while
-- `postcare_email_claimed_at = p_claimed_at`. The scenario this defends:
--
--     T1  sender A claims
--     ..  A hangs; its claim goes stale
--     T2  sender B reclaims (new token)
--     ..  A's provider call finally returns
--
-- A's late settlement must not stamp sent_at over B's in-flight send, clear
-- B's claim, or write a failure over B's newer state. Exact equality on the
-- token makes every one of those a no-op.
--
-- NO PROVIDER PAYLOAD CROSSES THIS BOUNDARY. The caller reports only whether
-- the send succeeded and whether the failure was retryable; the safe operator-
-- facing copy is derived HERE, from that boolean alone. A raw provider error
-- can carry recipient addresses, internal endpoints and vendor identifiers, and
-- postcare_email_last_error is rendered to practitioners.
create or replace function public.settle_postcare_send(
  p_appointment_id uuid,
  p_studio_id      uuid,
  p_claimed_at     timestamptz,
  p_success        boolean,
  p_retryable      boolean
) returns table (
  result     text,
  sent_at    timestamptz,
  failed_at  timestamptz,
  last_error text
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
  v_now  timestamptz;
  v_err  text;
begin
  if p_claimed_at is null then
    return query select 'stale_claim'::text, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz, null::text;
    return;
  end if;

  -- THE TOKEN PREDICATE. `is distinct from` so a NULL current claim (already
  -- settled by someone else) is a mismatch rather than a NULL-comparison
  -- surprise.
  if v_appt.postcare_email_claimed_at is distinct from p_claimed_at then
    return query select 'stale_claim'::text, v_appt.postcare_email_sent_at,
                        v_appt.postcare_email_failed_at, v_appt.postcare_email_last_error;
    return;
  end if;

  v_now := now();

  if coalesce(p_success, false) then
    -- SUCCESS. "Sent" means Hone handed the message to the provider — never
    -- delivered, received or opened. The DB clock stamps it; TypeScript does
    -- not get to say when a send happened.
    update public.appointments a
       set postcare_email_sent_at   = v_now,
           postcare_email_failed_at = null,
           postcare_email_last_error = null,
           postcare_email_claimed_at = null
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id;

    return query select 'settled'::text, v_now, null::timestamptz, null::text;
    return;
  end if;

  -- FAILURE. sent_at is deliberately NOT touched: a resend that fails today
  -- must leave yesterday's genuine successful send standing. Erasing it would
  -- turn a delivery record into a lie in exactly the situation — a dispute
  -- about whether aftercare was sent — where it matters most.
  -- Derived HERE, from the boolean alone, and held in a variable so the value
  -- returned to the caller is provably the value written to the column.
  v_err := case
    when coalesce(p_retryable, false)
      then 'Temporary email provider error. Try again.'
    else 'The email provider rejected the send. Try again.'
  end;

  update public.appointments a
     set postcare_email_failed_at  = v_now,
         postcare_email_last_error = v_err,
         postcare_email_claimed_at = null
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;

  -- sent_at is read from the row as it stood BEFORE this update, which is
  -- exactly right: the failure branch does not touch it, so a historical
  -- successful send survives a later failed resend.
  return query select 'settled'::text, v_appt.postcare_email_sent_at, v_now, v_err;
end;
$$;

comment on function public.settle_postcare_send(uuid, uuid, timestamptz, boolean, boolean) is
  'B8/0177. Settles a postcare send, but only while the claim token still '
  'matches — a superseded sender returning late is a no-op. Derives the safe '
  'last_error from p_retryable; no provider payload crosses this boundary.';

revoke execute on function public.settle_postcare_send(uuid, uuid, timestamptz, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.settle_postcare_send(uuid, uuid, timestamptz, boolean, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- B4 INTEGRATION — an UNRESOLVED postcare claim blocks OUTCOME REPAIR
-- ---------------------------------------------------------------------------
-- THE RACE THIS CLOSES, in the order it actually happens:
--
--     1. the appointment is `completed`
--     2. claim_postcare_send wins and COMMITS
--     3. postcare_email_claimed_at is populated
--     4. the provider call is in flight
--     5. the owner invokes revert_appointment_outcome
--     6. the blocking-dependents helper checks sent_at but NOT claimed_at
--     7. completed -> confirmed succeeds
--     8. the provider accepts
--     9. settle_postcare_send still holds the EXACT token and stamps sent_at
--
-- The result is an appointment sitting at `confirmed` for which aftercare has
-- been emailed — a communication for a visit Hone has just reopened, which
-- breaks the completed-only contract the claim command exists to enforce.
--
-- WHY NOT FIX IT IN SETTLEMENT. The obvious alternative is to make a SUCCESS
-- settlement refuse once the appointment is no longer completed. That is worse.
-- By step 8 the email has physically left; discarding the evidence would make
-- Hone LESS truthful about what its client received, and would recreate exactly
-- the overclaim/underclaim problem B8 was built to remove. The lifecycle change
-- must be blocked BEFORE it happens, which is here.
--
-- WHY `is not null` AND NOTHING ELSE. Not "younger than five minutes". The
-- five-minute window governs who may RECLAIM a send; it says nothing about
-- whether an external side effect resolved. A claim that went stale is a send
-- whose outcome Hone never learned — the most, not the least, dangerous state
-- to reopen an appointment underneath. Conservative by construction: a FAILURE
-- settlement and a SUCCESS settlement both clear `postcare_email_claimed_at`,
-- so the block lifts the moment the send resolves either way.
--
-- ORDER IS PRESERVED EXACTLY. The five existing classes keep their 0173
-- sequence and their 0173 predicates; `postcare_in_flight` is appended LAST.
-- That ordering is load-bearing for a resend: a resend claim sets claimed_at
-- while sent_at is already non-null, and the practitioner must still be told
-- the authoritative thing — aftercare has ALREADY been emailed — so
-- `postcare_sent` continues to win.
--
-- CREATE OR REPLACE preserves the function's owner and ACL, but the EXECUTE
-- posture is re-stated below anyway: the 0169 doctrine is to name every verb
-- rather than rely on what a replace happens to keep.
create or replace function public.appointment_has_blocking_dependents(
  p_appointment_id uuid,
  p_studio_id      uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  -- A reschedule successor: reverting resurrects a duplicate booking that the
  -- 23P01 exclusion cannot see, because the successor is at another time.
  if exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id
       and a.rescheduled_to_appointment_id is not null
  ) then
    return 'rescheduled';
  end if;

  -- An undeleted clinical session already hangs off this appointment.
  if exists (
    select 1 from public.sessions s
     where s.appointment_id = p_appointment_id
       and s.studio_id = p_studio_id
       and s.deleted_at is null
  ) then
    return 'linked_session';
  end if;

  -- Money moved (or is disputed) against this appointment.
  if exists (
    select 1 from public.appointment_payments ap
     where ap.appointment_id = p_appointment_id
       and ap.studio_id = p_studio_id
       and ap.payment_status <> 'method_saved'
  ) then
    return 'payment_state';
  end if;

  -- A manual fee was attempted against this appointment.
  if exists (
    select 1 from public.manual_fee_charge_attempts m
     where m.appointment_id = p_appointment_id
       and m.studio_id = p_studio_id
  ) then
    return 'manual_fee';
  end if;

  -- The client has already been emailed postcare for this visit.
  if exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id
       and a.postcare_email_sent_at is not null
  ) then
    return 'postcare_sent';
  end if;

  -- B8/0177 — NEW. A postcare send is claimed and has not settled. The email
  -- may be with the provider right now; reopening the outcome underneath it
  -- would produce aftercare for a visit that is no longer completed.
  if exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id
       and a.postcare_email_claimed_at is not null
  ) then
    return 'postcare_in_flight';
  end if;

  return null;
end;
$$;

comment on function public.appointment_has_blocking_dependents(uuid, uuid) is
  'Returns the first blocking-dependent class preventing safe outcome reversal (rescheduled, linked_session, payment_state, manual_fee, postcare_sent, postcare_in_flight), or NULL. Order is fixed so the code is deterministic when several apply; B8/0177 appended postcare_in_flight LAST so an already-sent visit still reports postcare_sent during a resend. Service-role only.';

revoke execute on function public.appointment_has_blocking_dependents(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.appointment_has_blocking_dependents(uuid, uuid)
  to service_role;

-- CATALOG TRUTH FOR THE CALLER, WITHOUT REDEFINING IT.
--
-- `revert_appointment_outcome` gains a sixth refusal — `blocked_postcare_in_flight`
-- — purely because it calls the helper above by name. Its BODY is correct and
-- is deliberately not re-emitted here: reproducing it would drag 0173's logic
-- into an unapplied migration, and hand-retyping an applied function body is
-- exactly the mistake B5 recorded.
--
-- But its COMMENT is now false. It says "five independent blocking-dependent
-- classes", and `\df+`, pg_description and every catalog-driven doc reader will
-- keep saying five. A comment is DDL, so the honest fix is a standalone
-- COMMENT ON — no CREATE OR REPLACE, no body, no signature change, no
-- privilege change. The rest of the description is preserved verbatim.
comment on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) is
  'Governed reverse lifecycle edge: completed/no_show/cancelled -> confirmed. Owner-only, studio- and appointment-scoped, expected-status concurrency, 72h window anchored to the audit event that established the current outcome (absent baseline REFUSES), six independent blocking-dependent classes (B8/0177 added postcare_in_flight, an unresolved postcare claim, so an outcome cannot be reopened while an aftercare email may still be with the provider), 23P01 mapped to slot_conflict. Exactly one audit row on success, none on refusal. Service-role only.';

-- ---------------------------------------------------------------------------
-- REMOVE B5's TEMPORARY SIX-COLUMN EXCEPTION
-- ---------------------------------------------------------------------------
-- 0174 granted this so the seven direct writers could keep working while the
-- boundary was being built. They are gone; the grant goes with them. 0174's
-- bytes stay frozen — it is applied production history, and its comment
-- already names B8 as the owner of this removal.
--
-- After this statement, service_role holds SELECT on public.appointments and
-- nothing else. Every remaining appointment mutation in the system goes through
-- a governed SECURITY DEFINER command.
revoke update (
  postcare_email_claimed_at,
  postcare_email_failed_at,
  postcare_email_last_attempt_at,
  postcare_email_last_error,
  postcare_email_send_attempts,
  postcare_email_sent_at
) on table public.appointments from service_role;

commit;
