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
-- WHAT THIS FILE DELIBERATELY DOES NOT TOUCH
--   * `snapshot_appointment_buffer()` — STANDING PROHIBITION. Production
--     carries out-of-band GUC behaviour there that this repository's migration
--     source does not represent. Not created, replaced, dropped or referenced.
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
-- AUTHORITY. The command is service_role-callable, but service_role is a
-- transport identity, not a business actor — so the DATABASE authenticates the
-- practitioner: `p_actor_practitioner_id` must be an ACTIVE practitioner of
-- `p_studio_id`. Any active same-studio practitioner may send postcare; the
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
