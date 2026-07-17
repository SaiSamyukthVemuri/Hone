-- Practitioner "Move appointment" — one atomic SAME-RECORD command.
--
-- Moving an appointment is NOT cancellation + rebooking. This RPC updates ONLY the
-- scheduling window (starts_at, ends_at, updated_at) of an existing CONFIRMED FUTURE
-- appointment, on the SAME appointments row, preserving the appointment id and every
-- relationship (client/practitioner/service/duration/notes/token hash/payment/
-- clinical/intake/audit/calendar-event-link identity). It changes only starts_at,
-- ends_at, updated_at and the TRIGGER-OWNED derived fields:
--   * snapshot_appointment_buffer()            (0029) recomputes buffer_minutes_snapshot + blocked_ends_at
--   * sync_appointment_to_calendar_reservation (0030) re-syncs the SAME shadow reservation to the new interval
--   * bump_appointment_sync_version()          (0125) bumps sync_version (starts_at/ends_at changed)
-- Conflicts are enforced by the existing GiST exclusion constraints (23P01):
--   * no_overlapping_active_appointments_per_studio   (appointment vs appointment, buffered)
--   * no_overlapping_calendar_reservations_per_studio (appointment vs timed_block / recurring_break / full_day_blockout)
-- This RPC does NOT catch 23P01 — the exclusion violation rolls the whole transaction
-- back and reaches the server adapter for safe conflict mapping.
--
-- Conventions match the sensitive appointment-lifecycle RPCs (practitioner_cancel_appointment,
-- reschedule_appointment): plpgsql, SECURITY DEFINER, hardened search_path, schema-qualified,
-- closed result set, no raw exception detail, execute revoked from public/anon/authenticated
-- and granted only to service_role. Additive; no schema/column/constraint/trigger change.

create or replace function public.practitioner_move_appointment(
  p_appointment_id uuid,
  p_studio_id uuid,
  p_practitioner_id uuid,
  p_expected_starts_at timestamptz,
  p_expected_ends_at timestamptz,
  p_new_starts_at timestamptz
)
returns table (
  result text,
  appointment_id uuid,
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  new_starts_at timestamptz,
  new_ends_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
  v_new_ends_at timestamptz;
  v_now timestamptz := now();
begin
  -- 1. Authorization: p_practitioner_id must be an ACTIVE practitioner in p_studio_id.
  --    This RPC runs as service_role (no auth.uid()), so authorization is parameter-
  --    based — identical to practitioner_cancel_appointment. The server action resolves
  --    p_studio_id / p_practitioner_id server-side; they are never client-supplied. A
  --    non-authorized caller learns nothing about the appointment.
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active = true
  ) then
    return query select 'not_authorized'::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 9. Target must be a valid FUTURE instant (checked before touching the row).
  if p_new_starts_at is null or p_new_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 2-4. Lock the row, scoped by (id, studio_id). A missing row OR a row in another
  --      studio is indistinguishable -> appointment_not_found (no cross-studio leak).
  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 5-6. Movable iff status = confirmed AND the ORIGINAL start is in the future.
  if v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now then
    return query select 'appointment_not_movable'::text, v_appt.id,
      v_appt.starts_at, v_appt.ends_at, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 7-8. Optimistic concurrency: BOTH stored endpoints must still match the caller's
  --      expected snapshot; any drift -> stale_appointment (changes nothing). This is
  --      what makes two concurrent moves from the same expected state mutually exclusive.
  if v_appt.starts_at is distinct from p_expected_starts_at
     or v_appt.ends_at is distinct from p_expected_ends_at then
    return query select 'stale_appointment'::text, v_appt.id,
      v_appt.starts_at, v_appt.ends_at, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- 10-11. Preserve duration_minutes from the LOCKED row; compute the authoritative
  --        new ends_at in-DB (never trust a caller-supplied end).
  v_new_ends_at := p_new_starts_at + make_interval(mins => v_appt.duration_minutes);

  -- 12. No-op when the target start equals the current start.
  if p_new_starts_at = v_appt.starts_at then
    return query select 'no_change'::text, v_appt.id,
      v_appt.starts_at, v_appt.ends_at, v_appt.starts_at, v_appt.ends_at;
    return;
  end if;

  -- 13-16. Update ONLY starts_at/ends_at/updated_at on the SAME row. The buffer-
  --        snapshot (BEFORE) + reservation-sync (AFTER) + sync_version-bump triggers
  --        own everything else. A GiST 23P01 (appointment or reservation exclusion)
  --        raised here is NOT caught -> the whole transaction (incl. the audit row)
  --        rolls back, so a conflict means no appointment change and no audit row.
  update public.appointments
     set starts_at = p_new_starts_at,
         ends_at = v_new_ends_at,
         updated_at = v_now
   where id = v_appt.id
     and studio_id = p_studio_id;

  -- 17. One atomic audit row (same appointment id; PHI-free safe details only). An
  --     audit-insert failure rolls back the appointment update in the same transaction.
  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt.id, 'practitioner', p_practitioner_id, 'moved',
    jsonb_build_object(
      'source', 'practitioner_ui',
      'previous_starts_at', v_appt.starts_at,
      'previous_ends_at', v_appt.ends_at,
      'new_starts_at', p_new_starts_at,
      'new_ends_at', v_new_ends_at
    )
  );

  -- 18. Return the authoritative final times.
  return query select 'moved'::text, v_appt.id,
    v_appt.starts_at, v_appt.ends_at, p_new_starts_at, v_new_ends_at;
  return;
end;
$$;

revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from anon;
revoke execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from authenticated;
grant execute on function public.practitioner_move_appointment(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;
