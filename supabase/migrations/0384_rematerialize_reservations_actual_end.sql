-- 0384 · rematerialize_studio_reservations stores an appointment's ACTUAL end (HON-114).
--
-- THE DEFECT. 0152 made an appointment's reservation (studio_calendar_reservations) hold the ACTUAL treatment interval: its per-appointment sync trigger
-- function stores ends_at, and its backfill narrowed existing rows. The buffer is re-applied by every reader (lib/booking/slots.ts protectedIntervals,
-- public_booking_slot_candidates, appointment_buffer_conflict). rematerialize_studio_reservations (0137, still the live body) was not changed by 0152: it
-- inserted a.blocked_ends_at (the real end PLUS the studio buffer). It runs from the practitioner refan trigger (insert, delete, studio move) and from the
-- studio capacity-flag trigger, so after any of those an appointment's reservation was one buffer too long and the readers protected it for TWO buffers:
-- openings after existing visits disappeared until each appointment was touched again.
--
-- THE FIX (function only). The insert stores a.ends_at, the same value the 0152 sync and its backfill store. Nothing else in the function changes: lock,
-- capacity-flag mirror, delete-and-rebuild, scoped blocks, blockouts and recurring breaks are byte-identical to 0137. CREATE OR REPLACE keeps the owner,
-- the grants and the 0134 revokes.
--
-- WHAT THIS DOES NOT DO. It changes no existing row. Reservations already written with the buffer stay stale until an appointment is touched or until the
-- next rematerialize (which now repairs them for that studio). Correcting live rows is a separate, reviewed script that needs the owner's approval.
begin;
set local lock_timeout = '5s';

create or replace function public.rematerialize_studio_reservations(p_studio_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_enabled boolean := public.studio_capacity_enabled(p_studio_id);
  v_tz text;
  r record;
begin
  -- Serialize the full rebuild with scoped-source mutations, so a capacity flip
  -- (this runs inside the flag-flip trigger AND the retirement RPC) cannot race
  -- a concurrent block/occurrence write.
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select coalesce(s.timezone, 'America/Toronto') into v_tz
  from public.studios s where s.id = p_studio_id;

  update public.appointments
    set capacity_enabled = v_enabled
    where studio_id = p_studio_id and capacity_enabled is distinct from v_enabled;

  delete from public.studio_calendar_reservations where studio_id = p_studio_id;

  insert into public.studio_calendar_reservations
    (studio_id, practitioner_id, resource_key, source_kind, source_id, starts_at, ends_at)
  select a.studio_id, a.practitioner_id,
         case when v_enabled then a.practitioner_id else a.studio_id end,
         'appointment', a.id, a.starts_at, a.ends_at
  from public.appointments a
  where a.studio_id = p_studio_id
    and public.appointment_participates_in_capacity(a.status, a.blocked_ends_at);

  for r in
    select id, practitioner_id, starts_at, ends_at
    from public.studio_timed_blocks where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, r.practitioner_id, 'timed_block', r.id, r.starts_at, r.ends_at);
  end loop;
  for r in
    select id,
           (starts_on::timestamp) at time zone v_tz as s_at,
           ((ends_on + 1)::timestamp) at time zone v_tz as e_at
    from public.studio_blockouts where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, null, 'full_day_blockout', r.id, r.s_at, r.e_at);
  end loop;
  for r in
    select id, practitioner_id, starts_at, ends_at
    from public.studio_recurring_break_occurrences where studio_id = p_studio_id
  loop
    perform public.sync_scoped_calendar_reservation(
      p_studio_id, r.practitioner_id, 'recurring_break_occurrence', r.id, r.starts_at, r.ends_at);
  end loop;
end;
$$;

commit;
