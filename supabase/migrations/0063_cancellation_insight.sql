-- ===========================================================================
-- Migration 0063: cancellation insight on the client public-token path.
--
-- Why this migration exists
-- -------------------------
-- The existing public_cancel_appointment_with_token(text, text) RPC writes
-- one audit row per client cancellation with details JSON of the form:
--
--   {"reason": "<free text>", "source": "public_token"}
--
-- A real client cancelled a New Client Consultation 7.5 minutes after
-- booking with reason="" because the cancel form only offered a free
-- textarea that they left blank. The practitioner now has no signal for
-- WHY the cancellation happened, whether they should follow up, or
-- whether the cancellation was a fast-mistake or a considered decision.
--
-- This migration adds a new overloaded variant of the RPC that accepts
-- structured insight fields:
--
--   * p_reason             - machine value, one of a fixed allowed set
--                            (validated in the application; the RPC
--                            stores it verbatim and the app refuses
--                            unknown values before reaching the RPC).
--   * p_reason_label       - the human label snapshot the client saw
--                            in the dropdown. Stored alongside the
--                            machine value so a future label change
--                            does not rewrite history.
--   * p_note               - optional free-form note (max length is
--                            enforced in the application layer; the
--                            DB column is unbounded text).
--   * p_follow_up_allowed  - boolean, true if the client opted in to
--                            being contacted about the cancellation.
--
-- The old 2-arg variant is NOT dropped. PostgreSQL function overloading
-- by parameter list lets both variants coexist during the deploy
-- window. The application code will switch to the new 5-arg variant
-- once this migration lands; a future migration can drop the legacy
-- 2-arg variant when nothing references it. Keeping both alive avoids
-- the failure window where an in-flight request from the previous
-- deploy hits the new DB and finds the old signature missing.
--
-- cancellation_reason column behavior
-- -----------------------------------
-- The new RPC writes p_reason_label (NOT the machine value) into
-- appointments.cancellation_reason. The existing practitioner-facing
-- surfaces (app/(app)/calendar/[id]/page.tsx, CSV exports) render the
-- column verbatim; a stored label reads as a clean human phrase
-- ("Schedule changed") rather than the underscored machine value
-- ("schedule_changed"). When no label is supplied the column stores
-- null. The richer audit details (machine reason, note,
-- follow_up_allowed) live exclusively in appointment_audit.details so
-- the appointments row schema is unchanged.
--
-- No appointment column additions, no RLS changes, no policy changes,
-- no payment / Stripe / SMS / middleware changes. Schema delta is one
-- new overloaded RPC and its grants.
-- ===========================================================================

create or replace function public.public_cancel_appointment_with_token(
  p_token              text,
  p_reason             text,
  p_reason_label       text,
  p_note               text,
  p_follow_up_allowed  boolean
) returns table (
  result          text,
  appointment_id  uuid,
  studio_id       uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_appt public.appointments%rowtype;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  select * into v_appt
    from public.appointments a
   where a.cancellation_token = p_token
   for update;
  if not found then
    return query select 'invalid_token'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_appt.status = 'cancelled' then
    return query select 'already_cancelled'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  if v_appt.status <> 'confirmed' then
    -- completed / no_show: refuse silently with neutral result; client
    -- cannot use this surface to flip terminal status.
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  if v_appt.starts_at <= now() then
    return query select 'not_cancelable'::text, v_appt.id, v_appt.studio_id;
    return;
  end if;

  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = 'client',
         -- Store the human label in the column for clean rendering on
         -- the practitioner appointment-detail page and CSV exports.
         -- The machine value lives in audit details below for
         -- aggregation. Both are nullable.
         cancellation_reason = nullif(p_reason_label, ''),
         updated_at          = now()
   where id = v_appt.id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    v_appt.id, 'client', null, 'cancelled',
    jsonb_build_object(
      'source',             'public_token',
      'reason',             coalesce(p_reason, ''),
      'reason_label',       coalesce(p_reason_label, ''),
      'note',               coalesce(p_note, ''),
      'follow_up_allowed',  coalesce(p_follow_up_allowed, false)
    )
  );

  return query select 'cancelled'::text, v_appt.id, v_appt.studio_id;
end;
$$;

-- Lock the new variant down to service_role. The application calls
-- this via createAdminClient() exclusively; anon / authenticated must
-- not be able to invoke it.
revoke execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.public_cancel_appointment_with_token(
  text, text, text, text, boolean
) to service_role;
