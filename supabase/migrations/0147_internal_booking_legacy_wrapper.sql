-- PR B Part 4 — close the old 0142 creation-command bypass (Item 1).
--
-- Defect: create_internal_appointment (0142) is still service_role-executable and
-- still trusts a caller-controlled p_duration_minutes WITHOUT running the shared
-- availability validator. The current app calls v2, but a STALE deployment or a
-- second service-role adapter could still reach 0142 and bypass every v2
-- guarantee (authoritative duration, per-practitioner working hours, owner-only
-- custom length).
--
-- Fix: redefine the old signature as a thin, deployment-compatible WRAPPER around
-- create_internal_appointment_v2. Same 4-column return shape. It never treats the
-- caller's duration as authority:
--   * duration NULL or == the current active service default  -> normal booking
--     (v2 re-derives the duration from the LOCKED service row);
--   * any other duration -> passed as the v2 owner-only override, so a member
--     stale app is rejected (not_authorized) and only an owner booking a valid
--     15..360 / multiple-of-15 length succeeds.
-- Legacy callers never bypass working hours (p_allow_outside_availability=false),
-- so v2's validator + the per-resource GiST exclusion now govern EVERY path.
--
-- The default read here is a plain (unlocked) read used ONLY to classify
-- normal-vs-custom; v2 re-reads the authoritative default under the studios/advisory
-- locks, so a concurrent duration edit can never let a forged length through — the
-- worst case is a fail-closed rejection of a stale non-owner request.
--
-- Migration-first, additive, flag-OFF. Stacks on 0146. NOT hosted-applied.
-- Service_role only.

begin;

create or replace function public.create_internal_appointment(
  p_studio_id               uuid,
  p_actor_practitioner_id   uuid,
  p_target_practitioner_id  uuid,
  p_client_id               uuid,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_duration_minutes        integer,
  p_cancellation_token_hash text,
  p_notes                   text default null
) returns table (
  result         text,
  appointment_id uuid,
  starts_at      timestamptz,
  ends_at        timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_default  integer;
  v_override integer;
begin
  -- Current active-service default (plain read; v2 re-derives authoritatively
  -- under the lock). NULL when the service is missing/inactive/cross-studio — v2
  -- then returns the canonical 'invalid_service'.
  select sv.default_duration_minutes into v_default
    from public.services sv
   where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true;

  if v_default is null then
    v_override := null;                         -- let v2 emit invalid_service
  elsif p_duration_minutes is null or p_duration_minutes = v_default then
    v_override := null;                         -- normal booking, authoritative default
  else
    v_override := p_duration_minutes;           -- non-default: v2 gates to owner + validates shape
  end if;

  return query
    select r.result, r.appointment_id, r.starts_at, r.ends_at
    from public.create_internal_appointment_v2(
      p_studio_id, p_actor_practitioner_id, p_target_practitioner_id, p_client_id, p_service_id,
      p_starts_at, p_cancellation_token_hash, p_notes,
      v_override,   -- p_duration_override_minutes (NULL = use the locked default)
      false         -- p_allow_outside_availability: legacy callers never bypass hours
    ) r;
end;
$$;

revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from public;
revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from anon;
revoke execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) from authenticated;
grant execute on function public.create_internal_appointment(uuid, uuid, uuid, uuid, uuid, timestamptz, integer, text, text) to service_role;

commit;
