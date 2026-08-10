-- ===========================================================================
-- APPOINTMENT BOUNDARY B7 — public cancellation + policy evidence, atomically
-- ===========================================================================
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `public_cancel_appointment_with_token` already commits the status flip and
-- the `cancelled` audit row in one transaction. The POLICY ACKNOWLEDGEMENT was
-- written afterwards, by the route, in a statement whose error was logged and
-- swallowed (app/cancel/[token]/actions.ts). A cancellation could therefore
-- exist with no acknowledgement row — which is exactly the evidence a late-
-- cancellation fee dispute turns on. Reschedule fixed the same defect in 0171;
-- cancellation is the remaining half.
--
-- There was also a TOCTOU evidence hole. The page rendered policy text, the
-- form posted only `acknowledged_policy=true`, and the action re-read the
-- CURRENT policy both to gate the cancel and to build the acknowledgement. A
-- studio edit between render and submit produced signed evidence for text the
-- client never saw. As legal evidence that is worse than no row at all.
--
-- WHAT THIS FILE DOES
-- ---------------------------------------------------------------------------
--   A. adds the presentation-proof inputs to the cancellation command and moves
--      the acknowledgement INSERT inside its transaction;
--   B. hardens the legacy 5-argument entry point so it can never act as an
--      acknowledgement bypass.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--   * `snapshot_appointment_buffer()` — STANDING PROHIBITION. Production
--     carries out-of-band GUC behaviour there that this repository's migration
--     source does not represent, so re-emitting it from repo source could
--     delete live behaviour. Not created, replaced, dropped or referenced.
--   * B6/0175's transition guard, updated_at trigger and capacity trigger. The
--     confirmed -> cancelled edge travels THROUGH
--     `appointments_enforce_transition_trg`; nothing here bypasses it, and no
--     GUC or service_role exception is introduced.
--   * calendar reservations and the Google outbox. Existing appointment
--     triggers own both. This command writes neither table directly; it changes
--     `status`, and those triggers fire inside the same transaction.
--   * postcare writers and the six-column service_role grant — B8 / 0177.
--   * every payment object.
--
-- OVERLOAD, AND WHY IT IS SAFE HERE (MEASURED, NOT ASSUMED)
-- ---------------------------------------------------------------------------
-- The new inputs are APPENDED to the existing command name rather than shipped
-- under a `_v2` name. Overloading a PostgREST-exposed function is only safe if
-- resolution is unambiguous, so it was measured against a local stack running
-- the pinned CLI's PostgREST before this file was written:
--
--   * 7 named arguments, both overloads installed  -> resolves to the 7-arg;
--   * 5 named arguments, both overloads installed  -> resolves to the 5-arg;
--   * 7 named arguments, only the 5-arg installed  -> PGRST202, "no matches
--     were found in the schema cache". It does NOT silently fall through to the
--     5-arg with the extra arguments ignored.
--
-- That last case is the load-bearing one: it means the app-first deployment
-- window fails LOUDLY and is detectable, so the route's fallback can be fenced
-- to exactly that condition instead of guessing.
--
-- LOCK ORDER — studios -> appointments
-- ---------------------------------------------------------------------------
-- The old command locked only the appointment, so a concurrent policy UPDATE
-- could slip between the policy read and the acknowledgement write. B7 must
-- linearize the policy too, and the established order in this command family
-- (0170 create_public_appointment, 0171 reschedule_appointment_v2, 0174
-- move_or_reassign_appointment) is:
--
--     studios FOR UPDATE  ->  [advisory]  ->  appointments FOR UPDATE
--
-- so this file takes `studios` BEFORE `appointments`. Taking a strict subset of
-- an existing order adds no new edge; taking appointments -> studios would have
-- created a fresh deadlock cycle against all three of those commands. The
-- capacity advisory lock is NOT taken: cancellation reads no capacity value and
-- creates no interval, and skipping a middle lock in an established order is
-- still a subset.
--
-- The caller supplies a token hash and no studio, so the studio must be
-- discovered before it can be locked. That pre-read is NOT authorisation and
-- NOT a source of truth: every value is re-read under the locks afterwards, and
-- the token is verified against the LOCKED row.
--
-- POLICY SNAPSHOT — ONE canonical algorithm, reused verbatim
-- ---------------------------------------------------------------------------
-- Byte-identical to buildPolicySnapshot() and to 0171:
--
--     coalesce(cancellation_policy_text, '') || E'\n---\n' ||
--     coalesce(no_show_policy_text, '')
--
-- hashed as lowercase SHA-256 hex, via schema-qualified `extensions.digest`.
-- The asymmetry from 0171 is preserved: the REQUIREMENT predicate trims (so a
-- whitespace-only policy needs no acknowledgement) while the SNAPSHOT does NOT
-- trim (so stored evidence is the exact column content).
--
-- ONE DELIBERATE DIVERGENCE FROM 0171, and it is a strengthening.
-- 0171 nests its hash comparison INSIDE `if v_needs_ack`, so when a studio has
-- no current policy the comparison never runs. For reschedule that is
-- sufficient. For B7 it is not: the frozen contract requires that a policy
-- REMOVED between render and submit also fails closed, and under the nested
-- shape that case would silently succeed — the client would have reviewed a
-- policy, the studio would have deleted it, and the cancellation would commit
-- as though nothing had changed. So the comparison here is UNCONDITIONAL: the
-- presented hash must equal the current hash even when both describe an empty
-- policy. The algorithm is unchanged; only the set of cases it covers is wider.
-- Consequently the page must ALWAYS post a presented hash, including for a
-- studio with no policy, where it is the hash of the empty snapshot.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- A — the atomic cancellation command
-- ---------------------------------------------------------------------------
create or replace function public.public_cancel_appointment_with_token(
  p_token                 text,
  p_reason                text,
  p_reason_label          text,
  p_note                  text,
  p_follow_up_allowed     boolean,
  p_acknowledged_policy   boolean,
  p_presented_policy_hash text
) returns table (
  result                    text,
  appointment_id            uuid,
  studio_id                 uuid,
  policy_acknowledgement_id uuid
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_id    uuid;
  v_appt         public.appointments%rowtype;
  v_cancel_text  text;
  v_noshow_text  text;
  v_needs_ack    boolean;
  v_current_hash text;
  v_ack_id       uuid;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- PRE-READ (NOT authorisation). Discover the studio so it can be locked
  -- first. No lock is taken here and nothing read here is trusted: the
  -- authoritative re-read happens under both locks below.
  select a.studio_id into v_studio_id
    from public.appointments a
   where a.cancellation_token_hash = p_token;
  if v_studio_id is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- LOCK 1 — the studio. This is what makes the policy decision linearizable:
  -- a concurrent policy UPDATE must now wait, so the hash compared below and
  -- the snapshot stored later are the same policy.
  select s.cancellation_policy_text, s.no_show_policy_text
    into v_cancel_text, v_noshow_text
    from public.studios s
   where s.id = v_studio_id
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  -- LOCK 2 — the appointment, re-found by token under the studio lock.
  select * into v_appt
    from public.appointments a
   where a.cancellation_token_hash = p_token
     and a.studio_id = v_studio_id
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_appt.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;
  if v_appt.status <> 'confirmed' then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;
  if v_appt.starts_at <= now() then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- CURRENT policy hash, derived under the studio lock.
  v_current_hash := encode(
    extensions.digest(
      coalesce(v_cancel_text, '') || E'\n---\n' || coalesce(v_noshow_text, ''),
      'sha256'
    ),
    'hex'
  );

  -- PRESENTATION PROOF — unconditional (see header). A missing hash is a
  -- mismatch, never consent: an older client that posts only the checkbox must
  -- not be able to acknowledge unseen text, and a client that saw a policy the
  -- studio has since deleted must not slip through on an empty current policy.
  if p_presented_policy_hash is null
     or lower(p_presented_policy_hash) is distinct from v_current_hash
  then
    return query select 'policy_changed'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- REQUIREMENT predicate — trims, so whitespace-only policy text requires no
  -- acknowledgement. U&'\FEFF' is a BOM, written escaped because a literal one
  -- is invisible in a .sql file. Identical to 0171 and to hasAnyPolicy().
  v_needs_ack := coalesce(v_cancel_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']')
              or coalesce(v_noshow_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']');

  if v_needs_ack and coalesce(p_acknowledged_policy, false) is not true then
    return query select 'ack_required'::text, v_appt.id, v_appt.studio_id, null::uuid;
    return;
  end if;

  -- ======================================================================
  -- MUTATION. Everything below commits together or not at all.
  -- ======================================================================
  --
  -- `updated_at` is deliberately NOT assigned here: B6/0175 made it
  -- DB-authoritative via appointments_set_updated_at_trg, and a hand-written
  -- assignment would only be as good as the next writer remembering. The
  -- confirmed -> cancelled edge travels through B6's transition guard; this
  -- command has no bypass for it.
  --
  -- cancelled_by stays 'client' and cancelled_by_practitioner_id is left NULL:
  -- a public token cancellation is the CLIENT acting, and manufacturing a
  -- practitioner identity would falsify B5's attribution.
  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = 'client',
         cancellation_reason = nullif(p_reason_label, '')
   where id = v_appt.id;

  -- Exactly ONE semantic cancellation event, with the same details shape the
  -- route already depends on. actor_type 'client', actor_id NULL.
  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appt.id, 'client', null, 'cancelled',
    jsonb_build_object(
      'source',            'public_token',
      'reason',            coalesce(p_reason, ''),
      'reason_label',      coalesce(p_reason_label, ''),
      'note',              coalesce(p_note, ''),
      'follow_up_allowed', coalesce(p_follow_up_allowed, false)
    )
  );

  -- THE FIX. This used to run after the RPC committed, in a swallowed
  -- statement. The snapshot is the CURRENT policy that was just proven equal to
  -- what the client was shown — not a second, later read.
  if v_needs_ack then
    insert into public.appointment_policy_acknowledgements
      (studio_id, appointment_id, client_id, action,
       cancellation_policy_text_snapshot, no_show_policy_text_snapshot,
       policy_snapshot_hash)
    values
      (v_appt.studio_id, v_appt.id, v_appt.client_id, 'cancel',
       coalesce(v_cancel_text, ''), coalesce(v_noshow_text, ''),
       v_current_hash)
    returning id into v_ack_id;
  end if;

  return query select 'cancelled'::text, v_appt.id, v_appt.studio_id, v_ack_id;
end;
$$;

comment on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) is
  'B7/0176. Atomic public cancellation: token check, policy presentation proof, '
  'confirmed->cancelled, one cancelled audit event and the policy '
  'acknowledgement all commit together. Locks studios before appointments.';

revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) from public, anon, authenticated;
grant execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean, boolean, text
) to service_role;

-- ---------------------------------------------------------------------------
-- B — the legacy 5-argument entry point becomes a FAIL-CLOSED shim
-- ---------------------------------------------------------------------------
-- RETIREMENT DECISION: redefined, NOT dropped.
--
-- Dropping it would make application rollback unsafe — the shipped route calls
-- the 5-arg form, so a rollback after 0176 would hit PGRST202 and no client
-- could cancel at all. Leaving its old body would be worse: it would remain a
-- working cancellation path that writes no acknowledgement, i.e. exactly the
-- bypass B7 exists to close.
--
-- So it keeps its signature and its return shape, and gains one rule: if the
-- studio currently has any policy, it refuses and mutates nothing. A studio
-- with no policy needs no acknowledgement, so delegation is safe there and the
-- old callers keep working.
--
-- It locks `studios` first, exactly like the 7-arg command, so the policy it
-- tests cannot change before the delegated call re-reads it. Both locks are
-- taken in the same transaction, so the inner re-lock is free.
create or replace function public.public_cancel_appointment_with_token(
  p_token             text,
  p_reason            text,
  p_reason_label      text,
  p_note              text,
  p_follow_up_allowed boolean
) returns table (
  result         text,
  appointment_id uuid,
  studio_id      uuid
)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_id    uuid;
  v_cancel_text  text;
  v_noshow_text  text;
  v_needs_ack    boolean;
  v_current_hash text;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  select a.studio_id into v_studio_id
    from public.appointments a
   where a.cancellation_token_hash = p_token;
  if v_studio_id is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  select s.cancellation_policy_text, s.no_show_policy_text
    into v_cancel_text, v_noshow_text
    from public.studios s
   where s.id = v_studio_id
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  v_needs_ack := coalesce(v_cancel_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']')
              or coalesce(v_noshow_text, '') ~ ('[^[:space:]' || U&'\FEFF' || ']');

  -- FAIL CLOSED. This caller cannot supply presentation proof, so for a
  -- policy-bearing studio there is no honest way to record consent. Refuse,
  -- mutate nothing, and let the caller be upgraded.
  if v_needs_ack then
    return query select 'ack_required'::text, null::uuid, v_studio_id;
    return;
  end if;

  -- No policy: no acknowledgement is required, so the presentation proof is the
  -- hash of the empty snapshot, computed from the row this function has locked.
  v_current_hash := encode(
    extensions.digest(
      coalesce(v_cancel_text, '') || E'\n---\n' || coalesce(v_noshow_text, ''),
      'sha256'
    ),
    'hex'
  );

  return query
    select c.result, c.appointment_id, c.studio_id
      from public.public_cancel_appointment_with_token(
             p_token, p_reason, p_reason_label, p_note, p_follow_up_allowed,
             false, v_current_hash
           ) c;
end;
$$;

comment on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) is
  'B7/0176. FAIL-CLOSED compatibility shim. Refuses with ack_required and '
  'mutates nothing when the studio has any policy text; delegates to the 7-arg '
  'atomic command only when no acknowledgement is required. Retained rather '
  'than dropped so an application rollback stays safe.';

revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) to service_role;

commit;
