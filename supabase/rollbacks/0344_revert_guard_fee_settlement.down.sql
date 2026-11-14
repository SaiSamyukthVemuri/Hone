-- Down for 0344: restore 0177's appointment_has_blocking_dependents body BYTE FOR BYTE and its comment and ACL.
-- Touches no data. It reinstates the narrower guard: a no-show / late-cancellation fee or a live settlement no longer blocks reverting an outcome.
begin;

set local lock_timeout = '5s';

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

commit;
