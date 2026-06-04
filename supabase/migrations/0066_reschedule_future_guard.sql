-- ===========================================================================
-- Migration 0066: public reschedule RPC future-instant guard.
-- ===========================================================================
--
-- What this migration does
-- ------------------------
-- Replaces public.reschedule_appointment so the RPC independently rejects:
--
--   1. Original appointment.status <> 'confirmed' (already enforced; kept).
--   2. Original appointment.starts_at <= now()         (NEW).
--   3. p_new_starts_at <= now()                        (NEW).
--   4. p_new_ends_at <= p_new_starts_at (already enforced; kept).
--
-- Why this matters
-- ----------------
-- Public reschedule is reached from a token in a client's email. The
-- action layer already enforces these guards on the well-behaved
-- happy path, but the RPC must independently reject the same shapes
-- so a future caller that bypasses the action (a forged form, a
-- direct service-role invocation, a future refactor) cannot
-- accidentally cancel-and-recreate an appointment in the past or
-- reschedule a non-confirmed row.
--
-- Status codes returned
-- ---------------------
-- The status string surface is preserved; the original_in_past and
-- new_in_past shapes both map to the existing
-- 'appointment_not_reschedulable' code via the action layer's
-- generic-collapse rule, so the public surface still sees only the
-- generic "This reschedule link can't be used right now." message.
-- error_detail carries a sanitized internal string for the operator
-- log; it never reaches the public client (the action layer drops
-- it before returning).
--
-- Preserved behavior
-- ------------------
-- * Token verification: row is locked WHERE id = p_original_appointment_id
--   AND cancellation_token = p_current_cancellation_token. A mismatch
--   collapses to appointment_not_found.
-- * Atomic cancel-original + insert-new + appointment_audit twin
--   inserts inside the same transaction.
-- * 23P01 exclusion-constraint behavior (double-booking) bubbles up
--   unchanged.
-- * SECURITY DEFINER, search_path = pg_catalog, pg_temp.
-- * Grants: service_role only (revoked from public, anon,
--   authenticated). Re-asserted at the bottom to be safe across
--   environments.
--
-- Strictly additive shape: the migration uses CREATE OR REPLACE
-- on an existing function signature, so a rollback is "re-paste the
-- 0029 body". The function signature does NOT change; no overloads
-- are created. The behavior change is the new guards only.
-- ===========================================================================

create or replace function public.reschedule_appointment(
  p_original_appointment_id uuid,
  p_current_cancellation_token text,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_duration_minutes integer,
  p_new_cancellation_token text
) returns table (
  result text,
  new_appointment_id uuid,
  error_detail text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_original public.appointments%rowtype;
  v_new_id uuid;
begin
  -- Lock the row matching BOTH id and submitted token. A mismatched
  -- token (or a NULL submitted token vs a populated column) means
  -- no row is locked and the function returns appointment_not_found,
  -- indistinguishable from a missing id by a probing caller.
  select * into v_original
  from public.appointments
  where id = p_original_appointment_id
    and cancellation_token = p_current_cancellation_token
  for update;

  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_original.status <> 'confirmed' then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        format('current status: %s', v_original.status);
    return;
  end if;

  -- NEW (PR #149): the original appointment must still be in the
  -- future. A past or in-progress original cannot be rescheduled
  -- via the public link; the practitioner cancel/no-show paths are
  -- the correct surface.
  if v_original.starts_at <= now() then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        'original starts_at is not in the future';
    return;
  end if;

  -- NEW (PR #149): the proposed new starts_at must be strictly
  -- in the future. The action layer already filters slot lists
  -- to future-only and rejects the submission ahead of this RPC,
  -- but the RPC enforces the same invariant independently so a
  -- bypass cannot cancel-and-recreate an appointment in the past.
  if p_new_starts_at <= now() then
    return query select 'invalid_time_range'::text,
                        null::uuid,
                        'new starts_at must be in the future';
    return;
  end if;

  if p_new_ends_at <= p_new_starts_at then
    return query select 'invalid_time_range'::text,
                        null::uuid,
                        'new ends_at must be after new starts_at';
    return;
  end if;

  update public.appointments
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = 'client',
        cancellation_reason = 'Rescheduled via email link',
        updated_at = now()
    where id = p_original_appointment_id;

  insert into public.appointments (
    studio_id,
    practitioner_id,
    client_id,
    service_id,
    starts_at,
    ends_at,
    duration_minutes,
    status,
    notes,
    cancellation_token
  )
  values (
    v_original.studio_id,
    v_original.practitioner_id,
    v_original.client_id,
    v_original.service_id,
    p_new_starts_at,
    p_new_ends_at,
    p_new_duration_minutes,
    'confirmed',
    v_original.notes,
    p_new_cancellation_token
  )
  returning id into v_new_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    p_original_appointment_id,
    'client',
    null,
    'cancelled',
    jsonb_build_object(
      'reason', 'rescheduled',
      'new_appointment_id', v_new_id
    )
  );

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  )
  values (
    v_new_id,
    'client',
    null,
    'created',
    jsonb_build_object(
      'source', 'reschedule_link',
      'original_appointment_id', p_original_appointment_id
    )
  );

  return query select 'success'::text, v_new_id, null::text;
end;
$$;

-- Re-assert the grants. CREATE OR REPLACE preserves existing grants
-- on the same signature, but re-asserting makes the migration safe
-- to apply in an environment whose grants drifted.

revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from public;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from anon;
revoke execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) from authenticated;
grant execute on function public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
) to service_role;
