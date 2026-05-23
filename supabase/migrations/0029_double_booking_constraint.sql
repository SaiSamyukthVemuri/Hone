-- Migration 0029: DB-level double-booking prevention + atomic
-- reschedule, using a trailing-only protected interval, with
-- transactional install and security-hardened functions.
--
-- Each appointment occupies [starts_at, ends_at + buffer). The
-- buffer is the minimum gap required AFTER one appointment before
-- the next can start. Adjacent appointments touching at the
-- boundary are allowed (half-open interval).
--
-- The DB owns the protected fields. The
-- snapshot_appointment_buffer trigger fires BEFORE INSERT OR UPDATE
-- on the entire appointments table (not just on time/studio
-- columns) so direct UPDATEs to buffer_minutes_snapshot or
-- blocked_ends_at by the app are reverted to the prior trigger-
-- computed values.
--
-- Both functions in this migration use
--   set search_path = pg_catalog, pg_temp
-- and reference every table with the public.* prefix, hardening
-- the SECURITY DEFINER attribute against schema-shadowing attacks.
--
-- Install procedure:
--
--   1. Outside the transaction below, run the pre-migration
--      protected-overlap diagnostic. Must return 0 rows. If it
--      returns rows, resolve those appointments before continuing.
--
--   2. Run this file as a single paste. Postgres will roll back the
--      entire transaction if any step fails, leaving the schema
--      untouched.
--
-- Re-runnable: every constraint and the exclusion constraint are
-- gated by pg_constraint existence checks; the trigger and
-- functions use create-or-replace. A functioning constraint is not
-- dropped and re-added on a no-op rerun.

begin;

-- ---------------------------------------------------------------------------
-- Step 1: add nullable columns. They become NOT NULL in step 7 once
-- the backfill is verified.
-- ---------------------------------------------------------------------------
alter table public.appointments
  add column if not exists buffer_minutes_snapshot integer,
  add column if not exists blocked_ends_at timestamptz;

-- ---------------------------------------------------------------------------
-- Step 2: hardened trigger function.
--
-- Behaviour:
--   * INSERT or UPDATE that changes studio_id, starts_at, or
--     ends_at:    recompute snapshot from the studio's current
--                 buffer_minutes.
--   * UPDATE that leaves studio_id, starts_at, and ends_at
--     unchanged AND has populated old.snapshot/old.blocked_ends_at:
--                 force NEW back to OLD on the two protected
--                 columns. This blocks app-side tampering.
--   * The "old values populated" guard exists so the migration's
--     own backfill UPDATE (where OLD.snapshot is NULL) falls
--     through to the recompute branch and gets the studio snapshot.
-- ---------------------------------------------------------------------------
create or replace function public.snapshot_appointment_buffer()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_buffer integer;
begin
  if tg_op = 'UPDATE'
     and new.studio_id = old.studio_id
     and new.starts_at = old.starts_at
     and new.ends_at   = old.ends_at
     and old.buffer_minutes_snapshot is not null
     and old.blocked_ends_at is not null
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
  new.blocked_ends_at := new.ends_at + make_interval(mins => v_buffer);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 3: install the trigger BEFORE the backfill so it is in place
-- for every write from this point on. CREATE OR REPLACE TRIGGER is
-- supported on Postgres 14+; Supabase runs 15+.
--
-- "before insert or update" (no column list) is intentional: an
-- "of studio_id, starts_at, ends_at" filter would let a malicious
-- or buggy caller bypass the snapshot via a direct UPDATE on the
-- protected columns themselves.
-- ---------------------------------------------------------------------------
create or replace trigger appointments_snapshot_buffer_trg
  before insert or update on public.appointments
  for each row
  execute function public.snapshot_appointment_buffer();

-- ---------------------------------------------------------------------------
-- Step 4: backfill. The trigger fires on every row touched; for
-- rows whose OLD snapshot is NULL it falls through to the recompute
-- branch and writes the studio's current buffer regardless of what
-- the SET clause attempts.
-- ---------------------------------------------------------------------------
update public.appointments a
set buffer_minutes_snapshot = coalesce(s.buffer_minutes, 0),
    blocked_ends_at = a.ends_at + make_interval(mins => coalesce(s.buffer_minutes, 0))
from public.studios s
where a.studio_id = s.id
  and (a.buffer_minutes_snapshot is null or a.blocked_ends_at is null);

-- ---------------------------------------------------------------------------
-- Step 5: validate backfill. Raises and rolls the whole transaction
-- back if any row violates the invariants.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from public.appointments
    where buffer_minutes_snapshot is null
       or blocked_ends_at is null
       or buffer_minutes_snapshot < 0
       or blocked_ends_at < ends_at
  ) then
    raise exception
      'Backfill validation failed: appointments table still has nulls or invariant violations';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 6: validate that no two existing confirmed appointments
-- overlap on their protected intervals. If any do, the exclusion
-- constraint added in step 9 would fail. We surface the diagnostic
-- as a clear error message instead of a postgres internal one.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from public.appointments a1
    join public.appointments a2
      on a1.studio_id = a2.studio_id
     and a1.id < a2.id
     and a1.status = 'confirmed'
     and a2.status = 'confirmed'
     and tstzrange(a1.starts_at, a1.blocked_ends_at, '[)')
         && tstzrange(a2.starts_at, a2.blocked_ends_at, '[)')
  ) then
    raise exception
      'Existing confirmed appointments overlap on protected interval; resolve before installing exclusion constraint';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 7: tighten the columns. NOT NULL plus invariant checks.
-- blocked_ends_at >= ends_at allows zero-buffer studios.
-- ---------------------------------------------------------------------------
alter table public.appointments
  alter column buffer_minutes_snapshot set not null,
  alter column blocked_ends_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_buffer_snapshot_non_negative'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_buffer_snapshot_non_negative
      check (buffer_minutes_snapshot >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_blocked_ends_at_after_ends_at'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_blocked_ends_at_after_ends_at
      check (blocked_ends_at >= ends_at);
  end if;

  -- Exact equality: every row's blocked_ends_at must equal
  -- ends_at + (snapshot minutes). If the trigger is bypassed or a
  -- direct write somehow lands an inconsistent pair, the row is
  -- rejected. With the trigger as sole writer this is belt-and-
  -- suspenders, but the constraint makes the invariant machine-
  -- checked rather than relying on trigger correctness alone.
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_blocked_end_matches_snapshot'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_blocked_end_matches_snapshot
      check (
        blocked_ends_at = ends_at + make_interval(mins => buffer_minutes_snapshot)
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 8: btree_gist for uuid equality inside the gist exclusion.
-- Idempotent.
-- ---------------------------------------------------------------------------
create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Step 9: exclusion constraint on [starts_at, blocked_ends_at) per
-- studio. The predicate matches lib/booking/slots.ts and only
-- confirmed rows block availability. Re-run safe: the constraint
-- is not dropped if it already exists.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'no_overlapping_active_appointments_per_studio'
      and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint no_overlapping_active_appointments_per_studio
      exclude using gist (
        studio_id with =,
        tstzrange(starts_at, blocked_ends_at, '[)') with &&
      ) where (status = 'confirmed');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step 10: atomic reschedule RPC.
--
-- All operations live in this single transaction so a failure on
-- any step rolls back to the pre-reschedule state. The INSERT
-- inside the function fires snapshot_appointment_buffer, which
-- picks up the studio's current buffer_minutes; the app does not
-- pass a buffer value.
--
-- Token verification: the caller must supply the SUBMITTED token
-- (the one from the URL the client opened). Mismatched tokens and
-- missing rows both return 'appointment_not_found' so a probing
-- caller cannot distinguish them.
--
-- Returned result values:
--   'success'                       - new appointment created
--   'appointment_not_found'         - id missing OR token mismatch
--   'appointment_not_reschedulable' - status is not 'confirmed'
--   'invalid_time_range'            - new ends_at <= new starts_at
-- ---------------------------------------------------------------------------
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
-- Step 11: tighten execute permissions for the RPC. The function is
-- intended for service_role callers only. Token verification inside
-- the function is defense in depth; the grant model is the primary
-- access control.
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

commit;
