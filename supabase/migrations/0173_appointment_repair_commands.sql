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
-- * It DOES close L23 (FK referential actions reaching appointments through
--   parent deletes) — see GROUP 5. That closure was briefly drafted as a
--   companion migration 0174, which was WRONG: the canonical appointment-DML
--   program already reserves 0174 for B5 (attribution + audit integrity), 0175
--   for B6, 0176 for B7 and 0177 for B8. Consuming 0174 here would have shifted
--   every later boundary migration by one. L23 therefore lives in GROUP 5 of
--   this file, kept in its own clearly separated group so it remains
--   independently auditable, and 0174 stays free for B5.
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
-- GROUP 1 · HELPER 1 — appointment_actor_role
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
-- GROUP 1 · HELPER 2 — lock_appointment_for_command
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
-- GROUP 1 · HELPER 3 — appointment_has_blocking_dependents
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
-- GROUP 1 · HELPER 4 — write_appointment_audit
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
-- GROUP 2 · COMMAND — revert_appointment_outcome
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
-- GROUP 3 · COMMAND — set_appointment_notes
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
-- GROUP 4 — EXECUTE / COMMAND PRIVILEGE POSTURE
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

-- ---------------------------------------------------------------------------
-- GROUP 5 — L23: PARENT-DELETE APPOINTMENT-LINEAGE CLOSURE
--
-- Everything above this line concerns the two repair COMMANDS. This group is a
-- separate subject and is deliberately kept whole and self-contained so it can
-- be reviewed on its own terms. It ships here rather than as its own migration
-- only because the canonical appointment-DML program reserves 0174 for B5.
--
-- WHAT L23 IS
-- ===========================================================================
-- 0172 revoked direct anon/authenticated INSERT/UPDATE/DELETE on
-- `public.appointments`. It closed DIRECT DML and said so explicitly, and it
-- recorded — in its own header (0172:220-247) and in
-- docs/production/known-limitations.md — the edge it did NOT close:
--
--   A referential action runs as the CONSTRAINT's owner and consults neither
--   the table ACL nor RLS (`appointments` is not FORCE RLS). So deleting a
--   PARENT row still writes `appointments` for a caller holding no privilege
--   on `appointments` whatsoever.
--
-- Two such paths were reachable from a browser after 0172:
--
--   * any MEMBER may DELETE a `services` row  (`services_member_all` is FOR ALL)
--       -> appointments_service_same_studio_fk       ON DELETE SET NULL
--       -> appointments.service_id becomes NULL
--   * an OWNER may DELETE a `practitioners` row ("practitioners: owners delete")
--       -> appointments_practitioner_same_studio_fk  ON DELETE SET NULL
--       -> appointments.practitioner_id becomes NULL
--
-- The write is SILENT: no audit row, no `updated_at` touch, no `sync_version`
-- bump, no calendar outbox enqueue. An appointment quietly loses the lineage
-- that every downstream clinical and billing question depends on.
--
-- THE CENSUS THAT AUTHORISES THIS
-- ===========================================================================
-- Performed locally and statically for B4; NO production access of any kind.
--
--   1. FK census on `appointments` (6 FKs, post-0151 truth, read from
--      pg_constraint on a fresh 0001->0173 chain):
--
--        clients        CASCADE     <- NOT browser reachable
--        studios        CASCADE     <- NOT browser reachable
--        services       SET NULL (service_id)       <- REACHABLE, member
--        practitioners  SET NULL (practitioner_id)  <- REACHABLE, owner
--        appointments   SET NULL (self, rescheduled_from/to) — self-reference
--                       only; reaching it requires deleting an appointment,
--                       which 0172 already denies.
--
--      Every one of those FKs is additionally ON UPDATE NO ACTION, so there is
--      no update-cascade sibling to this hazard. That is pinned by a test,
--      because `authenticated` deliberately KEEPS UPDATE on both parents.
--
--   2. Reachability is privilege AND policy. Both were read from the live local
--      catalog rather than inferred:
--
--        services       authenticated arwdDxtm + services_member_all FOR ALL
--        practitioners  authenticated arwdDxtm + "practitioners: owners delete"
--        clients        authenticated arwdDxtm but NO delete policy (0087
--                       replaced the FOR ALL policy with per-command ones)
--        studios        authenticated arwdDxtm but NO delete policy
--
--      `clients` and `studios` are therefore already default-denied at the RLS
--      layer, which is exactly why L23 is "a column is nulled" and not "the
--      appointment disappears". They are NOT touched here: their deletion path
--      is already correctly denied, and altering them for symmetry would widen
--      this group for no security gain.
--
--   3. Runtime hard-delete census. EVERY `.delete()` call site in `app/`,
--      `lib/` and `components/` was enumerated and resolved to its target
--      table — eight in total:
--
--        treatment_plan_stages, client_pinned_notes, client_pricing,
--        studio_blockouts, studio_timed_blocks   (authenticated client)
--        studios, calendar_connection_secrets,
--        calendar_connections                    (service role)
--
--      ZERO hard-delete `services`. ZERO hard-delete `practitioners`. No SQL
--      function in any of the 172 prior migrations deletes from either table.
--      The product DEACTIVATES instead: `services.active` (0010:150) and
--      `practitioners.active` (0001:25), both surfaced in settings.
--
--      Deleting a service or a practitioner is therefore AMBIENT DATABASE
--      CAPABILITY, not a product workflow. Nothing deployed loses a capability
--      here — the same standard 0172 was held to.
--
-- WHY BOTH LAYERS, NOT JUST THE PRIVILEGE
-- ===========================================================================
-- Revoking the DELETE privilege alone fully closes L23 today: the privilege
-- check precedes the policy check, so RLS never gets a say.
--
-- It is still not sufficient on its own. 0172 itself warns that a privilege can
-- be re-granted out of band "by platform tooling or a future
-- `auto_expose_new_tables` regression" (0172:150-152). If that happened,
-- `services_member_all` — still FOR ALL — would instantly re-open L23 with no
-- migration and no review. The policy is the durable record of intent; the
-- privilege is the enforcement. 0172 applied exactly this reasoning when it
-- dropped `appointment_audit_member_insert` outright rather than leaving
-- "residue that reads as an intentional grant".
--
-- So both layers move, and the shape follows the established precedent for this
-- exact problem: 0087 (`clinical RLS delete hardening`) replaced broad FOR ALL
-- policies with explicit per-command policies, omitting DELETE, for nine
-- tables. 0087's own header notes it left "the booking/availability tables
-- (operational, not clinical history; reported separately)" out of scope.
-- `services` is one of those deferred tables. This group finishes that job for
-- the two parents that can reach `appointments`.
--
-- `services_member_all` CANNOT simply be dropped: it is FOR ALL, so dropping it
-- without a replacement removes member SELECT/INSERT/UPDATE too and the
-- services settings page returns zero rows. The DROP and the three CREATEs are
-- therefore adjacent and inside this migration's single transaction, and each
-- replacement reuses `public.is_studio_member(studio_id)` VERBATIM — the
-- predicate is not rewritten, re-derived or widened, and `is_studio_member` is
-- not touched.
--
-- "practitioners: owners delete" IS dropped outright with no replacement: it is
-- a standalone DELETE policy, so after the revoke it permits an action no role
-- can reach. Its sibling policies — members read, owners insert, owners update
-- — are left exactly as 0001 wrote them.
--
-- THE ROLE CLAUSE NARROWS, AND THAT IS DELIBERATE
-- ===========================================================================
-- `services_member_all` carried NO `TO` clause, so it applied to PUBLIC —
-- `anon` included. The three replacements are `TO authenticated`, matching the
-- narrowing 0172 made for `appointments_member_select` and the shape every 0087
-- policy already uses.
--
-- This is behaviourally INERT, established two ways:
--
--   * By construction: `is_studio_member()` resolves `auth.uid()` to NULL for
--     `anon` and returns false, so `anon` reads zero `services` rows under the
--     OLD policy too. `service_role` and `postgres` carry `rolbypassrls`, so
--     policies never applied to them.
--   * By source census: the public booking surface does not read `services` as
--     `anon` at all. `app/book/[slug]/page.tsx:35`, `app/book/[slug]/actions.ts`
--     and `app/reschedule/[token]/actions.ts` all use `createAdminClient()`
--     ("Service-role read since this is public"), and every `createClient()`
--     based reader — `getActiveServices`, `getAllServices`,
--     `servicesHaveCalendarColor` — is called only from authenticated
--     `app/(app)/...` routes and `lib/onboarding/*`.
--
-- Both facts are pinned by tests so a future permissive `TO public` policy on
-- this table fails CI rather than silently granting the world a studio's menu.
--
-- WHAT THIS GROUP DOES NOT TOUCH
-- ===========================================================================
-- * SELECT, INSERT and UPDATE privileges are NEVER named. Only DELETE is
--   revoked, and only for `anon` and `authenticated`. There is no `revoke all`
--   anywhere in this file (the 0169 doctrine).
-- * `service_role` is NOT revoked on either table. Maintenance and any future
--   governed hard-delete command execute as `service_role`, and the studio
--   provisioning rollback in `app/admin/studios/new/actions.ts:164` already
--   deletes a `studios` row through the admin client. That capability is
--   intentionally retained.
-- * `postgres` unchanged. PUBLIC holds no table grant and is not mutated.
-- * NO FK is altered. The ON DELETE SET NULL semantics on
--   `appointments_service_same_studio_fk` and
--   `appointments_practitioner_same_studio_fk` are left exactly as 0151 wrote
--   them. Changing referential semantics to defend against a delete that can no
--   longer happen would be a schema change with real migration risk and no
--   security gain — the authority layer is where this belongs.
-- * `clients` and `studios` are not touched (already default-denied, above).
-- * B3's direct appointment boundary is untouched: nothing here grants any
--   table privilege to `anon` or `authenticated` on any table.
-- ---------------------------------------------------------------------------

-- GROUP 5.1 — the privilege. DELETE only; SELECT/INSERT/UPDATE never named.
revoke delete on table public.services      from anon, authenticated;
revoke delete on table public.practitioners from anon, authenticated;

-- GROUP 5.2 — policy residue on practitioners. Standalone DELETE policy, so it
-- is dropped outright with no replacement (the 0172 treatment of
-- appointment_audit_member_insert). Read/insert/update policies are untouched.
drop policy if exists "practitioners: owners delete" on public.practitioners;

-- GROUP 5.3 — policy residue on services. FOR ALL cannot be dropped without a
-- replacement or member reads break; DROP and CREATEs are adjacent and in this
-- migration's one transaction. Predicate reused verbatim. No DELETE policy.
drop policy if exists "services_member_all" on public.services;

drop policy if exists "services_member_select" on public.services;
create policy "services_member_select"
  on public.services for select to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "services_member_insert" on public.services;
create policy "services_member_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "services_member_update" on public.services;
create policy "services_member_update"
  on public.services for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

commit;
