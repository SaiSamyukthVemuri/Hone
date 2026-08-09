-- ---------------------------------------------------------------------------
-- 0173 — APPOINTMENT BOUNDARY B4: governed repair commands
--
-- WHY THIS EXISTS
-- ===========================================================================
-- 0172 (B3) revoked direct anon/authenticated INSERT/UPDATE/DELETE on
-- `public.appointments`. That was provably a no-op for the deployed
-- application — B1 (#522) froze the census showing ZERO authenticated writers
-- — but it did close an OPERATIONAL HATCH that was reachable in principle:
-- before 0172 a practitioner with a valid JWT could, via PostgREST, repair a
-- mistake by hand. Nothing in the product exposed that, and nobody is known to
-- have used it, but after 0172 the capability is gone at the privilege layer
-- and cannot come back without a new migration.
--
-- This migration supplies the governed replacements for the two repairs that
-- have an actual product justification:
--
--   1. `revert_appointment_outcome` — a practitioner marked an appointment
--      completed / no-show, or cancelled it, and was wrong. Today the UI says
--      "cannot be undone from this screen" (AppointmentLifecycleActions.tsx:50)
--      and it means it: there is no reverse edge anywhere in the product.
--   2. `set_appointment_notes` — appointment notes are written once at booking
--      time and, after 0172, are effectively immutable through the browser.
--
-- Both are SECURITY DEFINER, service_role-only commands. Neither re-opens
-- direct DML: the browser roles gain no table privilege here, and this file
-- contains no GRANT of any table privilege to `anon` or `authenticated`.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ===========================================================================
-- * It does NOT touch `snapshot_appointment_buffer()`. Production carries an
--   out-of-band GUC behaviour in that function which exists in NO migration in
--   this repository (recorded at 0172:212-218 and in the migration-process
--   memory), so emitting `create or replace function` for it from repo source
--   would silently delete a live production behaviour. There is no statement
--   below that creates, replaces or drops ANY trigger function.
-- * It does NOT create the audit `studio_id` column, an actor FK, an audit
--   durability trigger, a status-transition trigger, a public cancellation
--   acknowledgement, or retire the seven postcare writers. Those are B5-B8 and
--   each owns its own migration number.
-- * It does NOT close L23 (FK referential actions reaching appointments through
--   parent deletes). That is a privilege change on OTHER tables and ships as
--   the separately reviewed companion migration 0174, so this file keeps a
--   single subject: appointment repair.
-- * It adds NO column, index, constraint or table. Not one statement below
--   writes, deletes or repairs a row at migration time.
--
-- THE LOCK PROTOCOL IS NOT NEW
-- ===========================================================================
-- `lock_appointment_for_command` reuses the EXACT order established by
-- `create_internal_appointment_v2` (0152:13-23) and re-stated in
-- `create_public_appointment` (0170:676-688):
--
--     studios row FOR UPDATE  ->  acquire_studio_capacity_lock(studio_id)
--                             ->  appointments row FOR UPDATE
--
-- Taking these in any other order against a command that already holds them in
-- this order is a deadlock. The helper exists precisely so B4's two commands
-- cannot drift from that order, and so a future B-series command has one place
-- to inherit it from.
--
-- The appointment lookup is scoped by BOTH id and studio_id. That is what makes
-- a cross-studio repair attempt indistinguishable from a nonexistent
-- appointment: both return `appointment_not_found`, so the command is not an
-- existence oracle for another studio's schedule.
--
-- THE REPAIR WINDOW IS ANCHORED TO THE AUDIT, NOT TO THE APPOINTMENT
-- ===========================================================================
-- A 72-hour window measured from `appointments.updated_at` would be trivially
-- extendable by any unrelated write, and measured from `starts_at` it would
-- refuse a same-day mistake on a long-past appointment that was only just
-- mis-marked. The window is therefore measured from the audit event that
-- ESTABLISHED the current terminal outcome:
--
--     completed  <- action 'marked_complete'   (0032:4090)
--     no_show    <- action 'marked_no_show'    (0033:378)
--     cancelled  <- action 'cancelled'         (0033:299, 0091:133, 0171)
--
-- If no such audit row exists the command REFUSES with `no_audit_baseline`
-- rather than falling back to a permissive default. An appointment whose
-- terminal outcome has no audit trail is exactly the case where a silent
-- repair is least defensible, and B2 (#523) established that nine functions
-- write this table, so absence is meaningful rather than routine.
--
-- BLOCKING DEPENDENTS — INCLUDING ONE THE BRIEF DID NOT NAME
-- ===========================================================================
-- Five classes make reversal unsafe. Four are the canonical ones from the
-- boundary audit; the fifth was found by reading 0171 while writing this file:
--
--   linked_session   an undeleted `sessions` row points at this appointment
--                    (sessions.appointment_id, 0068; soft delete via deleted_at)
--   payment_state    `appointment_payments.payment_status` has moved past
--                    'method_saved' — money or a dispute is involved
--   manual_fee       a `manual_fee_charge_attempts` row exists for it (0064)
--   postcare_sent    `appointments.postcare_email_sent_at` is set (0043) —
--                    the client has already been told the visit happened
--   rescheduled      *** NOT IN THE BRIEF. 0171's reschedule cancels the
--                    predecessor with action 'cancelled' AND links a successor
--                    via rescheduled_to_appointment_id. Reverting such a row to
--                    'confirmed' resurrects a DUPLICATE booking, and because
--                    the successor sits at a DIFFERENT time the 23P01 exclusion
--                    below does NOT catch it. Without this class the command
--                    would silently double-book a client. ***
--
-- SLOT COLLISION IS REAL AND IS MAPPED, NOT SWALLOWED
-- ===========================================================================
-- `no_overlapping_active_appointments_per_studio` (0029:236) is an EXCLUDE
-- USING gist constraint with `WHERE (status = 'confirmed')`. A cancelled
-- appointment's interval can therefore be re-let to someone else, and flipping
-- it back to 'confirmed' RE-ARMS the exclusion. The same UPDATE also fires
-- `appointments_sync_calendar_reservation_trg` (0030:570), whose shadow table
-- carries its own exclusion.
--
-- Either can raise 23P01. The command catches that specific SQLSTATE and
-- returns `slot_conflict`. It does NOT catch broadly: any other error
-- propagates and rolls the transaction back, because a command that swallows
-- unknown failures while reporting a tidy code is worse than one that raises.
--
-- REFUSALS ARE TOTAL NO-OPS
-- ===========================================================================
-- Every refusal path returns BEFORE the UPDATE and BEFORE the audit insert. No
-- refusal writes an audit row (a refusal is not an event that happened to the
-- appointment) and no refusal touches any appointment column. Success writes
-- EXACTLY ONE audit row. Both properties are pinned behaviourally by whole-row
-- comparison in tests/db/appointment-repair-commands.db.test.ts.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson, recorded verbatim at 0169:70-76).
--
-- Migration max 0172 -> 0173.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- HELPER 1 — appointment_actor_role
--
-- The server derives the actor's membership and role from the database. The
-- browser supplies a user id that the server action has already authenticated;
-- it NEVER supplies a role. Returns zero rows for a non-member OR an inactive
-- member, so callers cannot distinguish "never was" from "no longer is" — and
-- both refuse identically.
-- ---------------------------------------------------------------------------
create or replace function public.appointment_actor_role(
  p_studio_id      uuid,
  p_actor_user_id  uuid
)
returns table (practitioner_id uuid, actor_role text)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.id, p.role
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id   = p_actor_user_id
     and p.active    = true
   limit 1;
$$;

comment on function public.appointment_actor_role(uuid, uuid) is
  'Server-side actor derivation for the appointment repair commands. Returns (practitioner_id, role) for an ACTIVE member of the studio, or zero rows. The caller never supplies a role. Service-role only.';

-- ---------------------------------------------------------------------------
-- HELPER 2 — lock_appointment_for_command
--
-- THE canonical lock order for every appointment command. See the header.
-- Scoped by (id, studio_id) so a cross-studio id is simply "not found".
-- ---------------------------------------------------------------------------
create or replace function public.lock_appointment_for_command(
  p_appointment_id uuid,
  p_studio_id      uuid
)
returns public.appointments
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio_exists boolean;
  v_appt          public.appointments;
begin
  -- 1. studio row.
  select true into v_studio_exists
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return null;
  end if;

  -- 2. studio capacity advisory lock (0136:225).
  perform public.acquire_studio_capacity_lock(p_studio_id);

  -- 3. the appointment row, scoped by BOTH keys.
  select a.* into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return null;
  end if;

  return v_appt;
end;
$$;

comment on function public.lock_appointment_for_command(uuid, uuid) is
  'Canonical appointment command lock protocol: studio row FOR UPDATE, then acquire_studio_capacity_lock, then the appointment row FOR UPDATE — the order established by create_internal_appointment_v2 (0152) and create_public_appointment (0170). Scoped by (id, studio_id); returns NULL for unknown studio OR unknown/cross-studio appointment. Service-role only.';

-- ---------------------------------------------------------------------------
-- HELPER 3 — appointment_has_blocking_dependents
--
-- Centralises the conditions that make outcome reversal unsafe. Returns the
-- FIRST blocking class name, or NULL when reversal is safe. Order is fixed so
-- the returned code is deterministic when several classes apply at once.
-- ---------------------------------------------------------------------------
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

  return null;
end;
$$;

comment on function public.appointment_has_blocking_dependents(uuid, uuid) is
  'Returns the first blocking-dependent class preventing safe outcome reversal (rescheduled, linked_session, payment_state, manual_fee, postcare_sent), or NULL. Order is fixed so the code is deterministic when several apply. Service-role only.';

-- ---------------------------------------------------------------------------
-- HELPER 4 — write_appointment_audit
--
-- Server-authored audit insertion. `actor_type` is constrained by the 0010
-- CHECK to ('practitioner','client','system'); B4 only ever writes
-- 'practitioner'. Kept as a helper so both commands emit an identically shaped
-- row and a future B5 audit change has one insertion point to migrate.
-- ---------------------------------------------------------------------------
create or replace function public.write_appointment_audit(
  p_appointment_id uuid,
  p_actor_type     text,
  p_actor_id       uuid,
  p_action         text,
  p_details        jsonb
)
returns void
language sql
security definer
set search_path = pg_catalog, pg_temp
as $$
  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, p_actor_type, p_actor_id, p_action, p_details
  );
$$;

comment on function public.write_appointment_audit(uuid, text, uuid, text, jsonb) is
  'Server-authored appointment_audit insertion used by the B4 repair commands. Service-role only; browser roles hold no INSERT on appointment_audit after 0172.';

-- ---------------------------------------------------------------------------
-- COMMAND 1 — revert_appointment_outcome
--
--     completed ─┐
--     no_show   ─┼─→ confirmed
--     cancelled ─┘
--
-- Owner-only. Returns a closed result code; never leaks a row.
-- ---------------------------------------------------------------------------
create or replace function public.revert_appointment_outcome(
  p_appointment_id   uuid,
  p_studio_id        uuid,
  p_actor_user_id    uuid,
  p_expected_status  text,
  p_reason           text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- Minimum meaningful reason, AFTER btrim. SQL owns normalisation; the client
  -- cannot satisfy this with whitespace.
  c_min_reason  constant integer  := 10;
  c_window      constant interval := interval '72 hours';

  v_practitioner_id uuid;
  v_role            text;
  v_reason          text;
  v_appt            public.appointments;
  v_blocking        text;
  v_baseline_action text;
  v_baseline_id     uuid;
  v_baseline_at     timestamptz;
  v_updated         integer;
begin
  -- GATE 1 — actor. Membership and role are derived here, never accepted from
  -- the caller. A non-member is refused before any appointment is looked at,
  -- so this command cannot be used to probe another studio's schedule.
  select r.practitioner_id, r.actor_role
    into v_practitioner_id, v_role
    from public.appointment_actor_role(p_studio_id, p_actor_user_id) r;
  if v_practitioner_id is null then
    return 'not_a_member';
  end if;
  if v_role <> 'owner' then
    return 'not_owner';
  end if;

  -- GATE 2 — the requested target must be a terminal status this command
  -- understands. Checked before any row is touched.
  if p_expected_status is null
     or p_expected_status not in ('completed', 'no_show', 'cancelled') then
    return 'not_terminal';
  end if;

  -- GATE 3 — reason. SQL owns the whitespace normalisation.
  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < c_min_reason then
    return 'reason_too_short';
  end if;

  -- GATE 4 — lock. Cross-studio and unknown are indistinguishable.
  v_appt := public.lock_appointment_for_command(p_appointment_id, p_studio_id);
  if v_appt.id is null then
    return 'appointment_not_found';
  end if;

  -- GATE 5 — optimistic concurrency. The caller states the status it saw; if
  -- the row has moved since, refuse rather than overwrite. A second identical
  -- invocation lands here (the row is now 'confirmed') and is refused
  -- truthfully with `status_mismatch` rather than silently "succeeding".
  if v_appt.status <> p_expected_status then
    return 'status_mismatch';
  end if;

  -- GATE 6 — blocking dependents, checked independently of everything above.
  v_blocking := public.appointment_has_blocking_dependents(p_appointment_id, p_studio_id);
  if v_blocking is not null then
    return 'blocked_' || v_blocking;
  end if;

  -- GATE 7 — the audit baseline that established the CURRENT outcome, and the
  -- repair window measured from it. Absence REFUSES; it never permits.
  v_baseline_action := case v_appt.status
                         when 'completed' then 'marked_complete'
                         when 'no_show'   then 'marked_no_show'
                         when 'cancelled' then 'cancelled'
                       end;

  select aa.id, aa.created_at
    into v_baseline_id, v_baseline_at
    from public.appointment_audit aa
   where aa.appointment_id = p_appointment_id
     and aa.action = v_baseline_action
   order by aa.created_at desc, aa.id desc
   limit 1;

  if v_baseline_id is null then
    return 'no_audit_baseline';
  end if;

  -- Inclusive at exactly 72 hours: a repair AT the boundary is allowed.
  if now() - v_baseline_at > c_window then
    return 'repair_window_expired';
  end if;

  -- MUTATION. The expected status is repeated in the predicate so the
  -- concurrency check is enforced by the UPDATE itself, not merely by GATE 5.
  -- Re-arming the 0029 exclusion (and the 0030 shadow) can raise 23P01.
  begin
    update public.appointments a
       set status              = 'confirmed',
           cancellation_reason = null,
           cancelled_at        = null,
           cancelled_by        = null,
           updated_at          = now()
     where a.id = p_appointment_id
       and a.studio_id = p_studio_id
       and a.status = p_expected_status;
    get diagnostics v_updated = row_count;
  exception
    when exclusion_violation then       -- 23P01
      return 'slot_conflict';
  end;

  if v_updated <> 1 then
    -- Unreachable under the row lock held since GATE 4; treated as a refusal
    -- rather than an assertion so the command cannot report success on zero
    -- rows (the "zero-row write looks like success" trap, 0172 test §1).
    return 'status_mismatch';
  end if;

  -- EXACTLY ONE audit event, only on success.
  perform public.write_appointment_audit(
    p_appointment_id,
    'practitioner',
    v_practitioner_id,
    'outcome_reverted',
    jsonb_build_object(
      'source',            'appointment_repair_command',
      'previous_status',   p_expected_status,
      'new_status',        'confirmed',
      'reason',            v_reason,
      'baseline_audit_id', v_baseline_id,
      'baseline_at',       v_baseline_at
    )
  );

  return 'ok';
end;
$$;

comment on function public.revert_appointment_outcome(uuid, uuid, uuid, text, text) is
  'Governed reverse lifecycle edge: completed/no_show/cancelled -> confirmed. Owner-only, studio- and appointment-scoped, expected-status concurrency, 72h window anchored to the audit event that established the current outcome (absent baseline REFUSES), five independent blocking-dependent classes, 23P01 mapped to slot_conflict. Exactly one audit row on success, none on refusal. Service-role only.';

-- ---------------------------------------------------------------------------
-- COMMAND 2 — set_appointment_notes
--
-- After 0172, creation-time appointment notes are immutable through the
-- browser. This is the governed correction. Any ACTIVE member may correct
-- notes (unlike outcome reversal, this is not owner-only: notes are
-- operational text the practitioner who ran the visit needs to fix).
--
-- The audit records LENGTHS ONLY. Appointment notes routinely contain
-- client-identifying detail, and `appointment_audit_member_read` (0010) is
-- readable by every member of the studio; copying note text into that JSON
-- would widen who can read it and would make the note permanently
-- unredactable. Lengths give a reviewer the shape of the change without the
-- content.
-- ---------------------------------------------------------------------------
create or replace function public.set_appointment_notes(
  p_appointment_id uuid,
  p_studio_id      uuid,
  p_actor_user_id  uuid,
  p_notes          text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  -- `appointments.notes` is bare `text` (0010:184) with no CHECK, so this is
  -- B4's own ceiling rather than a restatement of a schema constraint.
  c_max_notes constant integer := 2000;

  v_practitioner_id uuid;
  v_role            text;
  v_appt            public.appointments;
  v_before_len      integer;
  v_after           text;
  v_updated         integer;
begin
  -- GATE 1 — actor. Any ACTIVE member; role is derived, never supplied.
  select r.practitioner_id, r.actor_role
    into v_practitioner_id, v_role
    from public.appointment_actor_role(p_studio_id, p_actor_user_id) r;
  if v_practitioner_id is null then
    return 'not_a_member';
  end if;

  -- GATE 2 — normalisation happens in SQL, and length is measured AFTER it so
  -- trailing whitespace cannot be used to trip the ceiling.
  v_after := btrim(coalesce(p_notes, ''));
  if length(v_after) > c_max_notes then
    return 'notes_too_long';
  end if;
  if v_after = '' then
    v_after := null;                    -- blank clears the field
  end if;

  -- GATE 3 — lock. Cross-studio and unknown are indistinguishable.
  v_appt := public.lock_appointment_for_command(p_appointment_id, p_studio_id);
  if v_appt.id is null then
    return 'appointment_not_found';
  end if;

  v_before_len := coalesce(length(v_appt.notes), 0);

  -- MUTATION. Only `notes` and `updated_at` are written: no status, no times,
  -- no practitioner, no service. Nothing here re-arms the 0029 exclusion or
  -- changes any interval, so the scheduling and capacity paths are untouched.
  update public.appointments a
     set notes      = v_after,
         updated_at = now()
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id;
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return 'appointment_not_found';
  end if;

  -- LENGTHS ONLY — never the note text itself.
  perform public.write_appointment_audit(
    p_appointment_id,
    'practitioner',
    v_practitioner_id,
    'notes_corrected',
    jsonb_build_object(
      'source',          'appointment_repair_command',
      'previous_length', v_before_len,
      'new_length',      coalesce(length(v_after), 0),
      'cleared',         (v_after is null)
    )
  );

  return 'ok';
end;
$$;

comment on function public.set_appointment_notes(uuid, uuid, uuid, text) is
  'Governed appointment-notes correction for an ACTIVE studio member. SQL owns btrim; blank clears to NULL; ceiling 2000 chars measured after trim. Writes only notes + updated_at, so no scheduling/capacity logic is triggered. Audit records BEFORE/AFTER LENGTHS ONLY — never note text, which would leak client-identifying detail into member-readable audit JSON. Service-role only.';

-- ---------------------------------------------------------------------------
-- EXECUTE GRANTS
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to `public`, `anon` AND
-- `authenticated` at CREATE time, so every function above must have those
-- revoked explicitly and be re-granted to `service_role` alone. Naming each
-- verb rather than reaching for a blanket statement is the 0169 doctrine.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.appointment_actor_role(uuid, uuid)',
    'public.lock_appointment_for_command(uuid, uuid)',
    'public.appointment_has_blocking_dependents(uuid, uuid)',
    'public.write_appointment_audit(uuid, text, uuid, text, jsonb)',
    'public.revert_appointment_outcome(uuid, uuid, uuid, text, text)',
    'public.set_appointment_notes(uuid, uuid, uuid, text)'
  ] loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant  execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
