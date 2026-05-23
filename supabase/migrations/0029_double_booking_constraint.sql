-- Migration 0029: DB-level double-booking prevention + atomic
-- reschedule, using a trailing-only protected interval.
--
-- The first draft of this migration constrained the raw
-- [starts_at, ends_at) window, which did not match
-- lib/booking/slots.ts. A second draft used symmetric blocked
-- windows (expand both sides by buffer_minutes), which double-
-- counted the buffer: with a 15 minute buffer, 10:00 to 11:00 and
-- 11:15 to 12:15 ended up overlapping on the symmetric windows
-- even though there is a full 15 minute gap between them.
--
-- This revision uses a one-sided trailing buffer: each appointment
-- protects the interval [starts_at, ends_at + buffer). The buffer
-- is the minimum gap required AFTER one appointment before the
-- next can start. With a 15 minute buffer:
--
--   A 10:00-11:00 occupies [10:00, 11:15)
--   B 11:15-12:15 occupies [11:15, 12:30)
--   half-open overlap test: no conflict. Correct.
--
--   A 10:00-11:00 occupies [10:00, 11:15)
--   B 11:10-11:40 occupies [11:10, 11:55) (with same buffer policy)
--   half-open overlap: [10:00, 11:15) && [11:10, 11:55) -> reject.
--   Correct.
--
-- Pieces, in order:
--
--   1. buffer_minutes_snapshot integer column on appointments.
--   2. blocked_ends_at timestamptz column on appointments.
--   3. Backfill snapshot from studios.buffer_minutes (default 0 if
--      a row is null) and blocked_ends_at from ends_at + snapshot.
--   4. Manual diagnostic (must return 0 rows before continuing).
--   5. NOT NULL + invariant checks on the new columns.
--   6. snapshot_appointment_buffer trigger so the values are
--      derived inside the DB, not passed from the app.
--   7. btree_gist + exclusion constraint on
--      tstzrange(starts_at, blocked_ends_at, '[)') per studio.
--   8. reschedule_appointment RPC, signature reduced (no buffer
--      param: the INSERT inside the RPC triggers a fresh snapshot
--      using the studio's current buffer_minutes).
--   9. Revoke execute from public/anon/authenticated; grant only
--      to service_role.
--
-- SOLO-PRACTITIONER SCOPE: studio-scoped predicate on purpose.
-- Multi-practitioner support requires revising the predicate, see
-- prior session notes.
--
-- Re-runnable: every alter is guarded, the function uses
-- create or replace, the trigger is dropped before re-creation.

-- ---------------------------------------------------------------------------
-- Step 1 + 2: add columns. Nullable initially so the backfill in
-- step 3 can populate existing rows.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists buffer_minutes_snapshot integer,
  add column if not exists blocked_ends_at timestamptz;

-- ---------------------------------------------------------------------------
-- Step 3: backfill. Snapshot the studio's CURRENT buffer at apply
-- time and derive blocked_ends_at from it. Guarded by `is null` so
-- re-runs are no-ops on already-populated rows.
-- ---------------------------------------------------------------------------
update public.appointments a
set buffer_minutes_snapshot = coalesce(s.buffer_minutes, 0),
    blocked_ends_at = a.ends_at + (coalesce(s.buffer_minutes, 0) || ' minutes')::interval
from public.studios s
where a.studio_id = s.id
  and (a.buffer_minutes_snapshot is null or a.blocked_ends_at is null);

-- ---------------------------------------------------------------------------
-- Step 4 (manual): the next query must return 0 rows before
-- continuing. If it does not, stop and investigate.
--
-- select id, studio_id, starts_at, ends_at, buffer_minutes_snapshot, blocked_ends_at
-- from public.appointments
-- where buffer_minutes_snapshot is null
--    or blocked_ends_at is null
--    or buffer_minutes_snapshot < 0
--    or blocked_ends_at < ends_at;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Step 5: tighten the new columns. NOT NULL plus invariant checks.
-- blocked_ends_at >= ends_at allows zero-buffer studios.
-- ---------------------------------------------------------------------------
alter table public.appointments
  alter column buffer_minutes_snapshot set not null,
  alter column blocked_ends_at set not null;

alter table public.appointments
  drop constraint if exists appointments_buffer_snapshot_non_negative;
alter table public.appointments
  add constraint appointments_buffer_snapshot_non_negative
  check (buffer_minutes_snapshot >= 0);

alter table public.appointments
  drop constraint if exists appointments_blocked_ends_at_after_ends_at;
alter table public.appointments
  add constraint appointments_blocked_ends_at_after_ends_at
  check (blocked_ends_at >= ends_at);

-- ---------------------------------------------------------------------------
-- Step 6: BEFORE INSERT OR UPDATE trigger that snapshots the
-- studio's current buffer and derives blocked_ends_at. The trigger
-- is the only intended writer of these two columns; any value the
-- caller tries to write is overwritten.
--
-- On INSERT: always snapshot.
-- On UPDATE: only re-snapshot if studio_id, starts_at, or ends_at
-- changed. If those are stable, the existing snapshot is preserved
-- (so studios changing buffer_minutes later does not retroactively
-- alter their existing appointments).
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_appointment_buffer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_buffer integer;
begin
  if tg_op = 'UPDATE'
     and new.studio_id = old.studio_id
     and new.starts_at = old.starts_at
     and new.ends_at   = old.ends_at
  then
    new.buffer_minutes_snapshot := old.buffer_minutes_snapshot;
    new.blocked_ends_at := old.blocked_ends_at;
    return new;
  end if;

  select coalesce(s.buffer_minutes, 0) into v_buffer
  from public.studios s
  where s.id = new.studio_id;

  if v_buffer is null then
    v_buffer := 0;
  end if;

  new.buffer_minutes_snapshot := v_buffer;
  new.blocked_ends_at := new.ends_at + (v_buffer || ' minutes')::interval;

  return new;
end;
$$;

drop trigger if exists appointments_snapshot_buffer_trg on public.appointments;
create trigger appointments_snapshot_buffer_trg
  before insert or update of studio_id, starts_at, ends_at
  on public.appointments
  for each row
  execute function public.snapshot_appointment_buffer();

-- ---------------------------------------------------------------------------
-- Step 7: btree_gist + exclusion constraint on the one-sided
-- protected interval. The predicate matches lib/booking/slots.ts:
-- only confirmed rows block availability. Cancelled, completed,
-- and no_show rows do not, so a cancellation re-opens the slot
-- immediately.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

alter table public.appointments
  drop constraint if exists no_overlapping_active_appointments_per_studio;
alter table public.appointments
  add constraint no_overlapping_active_appointments_per_studio
  exclude using gist (
    studio_id with =,
    tstzrange(starts_at, blocked_ends_at, '[)') with &&
  ) where (status = 'confirmed');

-- ---------------------------------------------------------------------------
-- Step 8: atomic reschedule RPC.
--
-- The INSERT inside this function fires the buffer-snapshot
-- trigger, so the replacement row picks up the studio's CURRENT
-- buffer_minutes. The caller does not pass buffer minutes and
-- cannot tamper with the snapshot.
--
-- Token verification: the caller must supply the current
-- cancellation_token alongside the id. Mismatched tokens and
-- missing rows both return 'appointment_not_found' so the response
-- cannot be used to distinguish them.
--
-- Returned result values:
--   'success'                       - new appointment created
--   'appointment_not_found'         - id missing OR token mismatch
--   'appointment_not_reschedulable' - status is not 'confirmed'
--   'invalid_time_range'            - new ends_at <= new starts_at
-- ---------------------------------------------------------------------------
drop function if exists public.reschedule_appointment(
  uuid, timestamptz, timestamptz, integer, text
);
drop function if exists public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text, integer
);
drop function if exists public.reschedule_appointment(
  uuid, text, timestamptz, timestamptz, integer, text
);

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
set search_path = public
as $$
declare
  v_original public.appointments%rowtype;
  v_new_id uuid;
begin
  select * into v_original
  from public.appointments
  where id = p_original_appointment_id
  for update;

  if not found
     or v_original.cancellation_token is null
     or v_original.cancellation_token <> p_current_cancellation_token
  then
    return query select 'appointment_not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_original.status <> 'confirmed' then
    return query select 'appointment_not_reschedulable'::text,
                        null::uuid,
                        format('current status: %s', v_original.status);
    return;
  end if;

  if p_new_ends_at <= p_new_starts_at then
    return query select 'invalid_time_range'::text, null::uuid, null::text;
    return;
  end if;

  update public.appointments
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = 'client',
        cancellation_reason = 'Rescheduled via email link',
        updated_at = now()
    where id = p_original_appointment_id;

  -- The INSERT below fires snapshot_appointment_buffer, which sets
  -- buffer_minutes_snapshot and blocked_ends_at from the studio's
  -- current buffer_minutes. We do NOT pass these columns.
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

-- ---------------------------------------------------------------------------
-- Step 9: tighten execute permissions. The RPC is service_role only.
-- ---------------------------------------------------------------------------
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
