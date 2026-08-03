-- ---------------------------------------------------------------------------
-- 0167 — L18 Phase 3: narrow write commands for public.sessions
--
-- WHAT THIS REPLACES
-- ===========================================================================
-- Verified runtime writer census on the current tree (statement-chain accurate,
-- walked to bracket depth zero — reads are NOT counted):
--
--   sessions (10)
--     updateSessionPriceAction          UPDATE  sessions/[sessionId]/actions.ts:540
--     updateNextSessionNoteAction       UPDATE  sessions/[sessionId]/actions.ts:579
--     updateSessionPerformerAction      UPDATE  sessions/[sessionId]/actions.ts:623
--     editSessionStartedAtAction        UPDATE  sessions/[sessionId]/actions.ts:740
--     softDeleteSessionAction           UPDATE  sessions/[sessionId]/actions.ts:793
--     startSessionAction                UPDATE  sessions/new/actions.ts:214  (link promotion)
--     startSessionAction                INSERT  sessions/new/actions.ts:259
--     attachChartEntryToPlanAction      UPDATE  treatment-plans-actions.ts:345
--     detachChartEntryFromPlanAction    UPDATE  treatment-plans-actions.ts:372
--     markAftercareExplainedAction      UPDATE  records/actions.ts:236
--
-- AFTER this migration and its application half the same census reports
-- sessions 0. treatment_images REMAINS 3 and is deliberately untouched — it
-- moves in a later phase.
--
-- EIGHT fixed-purpose commands, one per writer FAMILY (not per call site):
-- start_session covers both startSessionAction writers, and
-- set_session_treatment_plan covers both attach and detach.
--
-- THE RACE THIS CLOSES
-- ===========================================================================
-- startSessionAction read a recent same-client/same-practitioner/same-modality
-- session inside a coalesce window and then INSERTed if it found none — a
-- read-then-write window in which two concurrent "Start session" clicks could
-- both miss and create DUPLICATE sessions for one visit. `start_session` does
-- the lookup with FOR UPDATE inside the same transaction as the insert, so the
-- second caller blocks and then reuses the row the first one created.
--
-- WHAT IS PRESERVED, DELIBERATELY
-- ===========================================================================
-- * SECURITY DEFINER bypasses RLS, so every command re-establishes the tenant
--   boundary itself: the studio is DERIVED from the session (or, for
--   start_session, from the actor's active membership) and never accepted from
--   the caller, and every UPDATE is additionally scoped by studio_id.
-- * All four `sessions` triggers still fire for DEFINER writes —
--   sessions_guard_finalized, sessions_guard_retired_finalization,
--   sessions_immutable_lineage and sessions_aftercare_audit — so retired
--   finalization, the immutable legacy artifact and the aftercare audit trail
--   are enforced exactly as before, by the database.
-- * Every writer already required an ACTIVE practitioner: the application's
--   getCurrentPractitionerWithStudio() resolves membership with
--   .eq("active", true). Requiring active membership here therefore PRESERVES
--   behaviour; it does not tighten it.
-- * Column sets match the direct writers exactly. No column any writer
--   persisted is dropped, and no command writes a column its writer did not.
--
-- L18 REMAINS OPEN. Direct authenticated table DML on `sessions` is NOT revoked
-- here — this migration is purely additive. Revocation is a separate, final L18
-- migration once sessions AND treatment_images both reach zero direct writers.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson).
--
-- Migration max 0166 -> 0167.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- INTERNAL HELPER — resolve the actor's practitioner row within a studio.
--
-- The actor is ALWAYS auth.uid(). current_user is deliberately not consulted:
-- inside a SECURITY DEFINER function it is the function owner, not the
-- authenticated practitioner.
-- ===========================================================================
create or replace function public.session_actor_practitioner(
  p_studio_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;

  select p.id into v_id
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id = auth.uid()
     and p.active = true;

  if v_id is null then
    raise exception 'Inactive practitioners cannot edit sessions.'
      using errcode = 'check_violation';
  end if;

  return v_id;
end;
$$;

-- ===========================================================================
-- INTERNAL HELPER — authorize by SESSION ALONE (no client assertion).
--
-- Used only by set_session_aftercare_explained, whose existing writer scopes
-- by (id, studio_id) and has no client id in scope. Every other command uses
-- 0166's assert_session_writable, which additionally asserts the client.
-- ===========================================================================
create or replace function public.assert_session_studio_for_actor(
  p_session_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;

  select s.studio_id into v_studio_id
    from public.sessions s
   where s.id = p_session_id
     and exists (
       select 1
         from public.practitioners p
        where p.studio_id = s.studio_id
          and p.user_id = auth.uid()
          and p.active = true
     );

  if v_studio_id is null then
    raise exception 'Session not found or not writable by this practitioner.'
      using errcode = 'check_violation';
  end if;

  return v_studio_id;
end;
$$;

-- ===========================================================================
-- COMMAND 1 — start (or reuse) a session. Replaces BOTH startSessionAction
-- writers: the coalesce-window reuse + appointment-link promotion, and the
-- insert. Atomic, so concurrent starts cannot duplicate a visit.
-- ===========================================================================
create or replace function public.start_session(
  p_client_id        uuid,
  p_modality         text,
  p_appointment_id   uuid,
  p_coalesce_minutes integer
)
returns table (session_id uuid, reused boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id      uuid;
  v_practitioner   uuid;
  v_session_id     uuid;
  v_existing_appt  uuid;
  v_appt_client    uuid;
  v_appt_studio    uuid;
  v_appt_pract     uuid;
  v_auto_plan      uuid;
  v_plan_count     integer;
  v_reused         boolean := false;
begin
  if p_modality is null or p_modality not in ('electrolysis', 'laser') then
    raise exception 'Unsupported session modality.' using errcode = 'check_violation';
  end if;

  -- The studio comes from the ACTOR's active membership, never the caller.
  select p.studio_id into v_studio_id
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.active = true
   limit 1;

  if v_studio_id is null then
    raise exception 'No active practitioner found for the signed-in user.'
      using errcode = 'check_violation';
  end if;
  v_practitioner := public.session_actor_practitioner(v_studio_id);

  -- The client must belong to the same studio.
  perform 1 from public.clients c
    where c.id = p_client_id and c.studio_id = v_studio_id;
  if not found then
    raise exception 'Client not found in this studio.' using errcode = 'check_violation';
  end if;

  -- Appointment linkage is validated exactly as the application did: same
  -- studio, same client, and either unassigned or assigned to this actor.
  if p_appointment_id is not null then
    select a.studio_id, a.client_id, a.practitioner_id
      into v_appt_studio, v_appt_client, v_appt_pract
      from public.appointments a
     where a.id = p_appointment_id;

    if v_appt_studio is null or v_appt_studio <> v_studio_id then
      raise exception 'Appointment is not in your studio.' using errcode = 'check_violation';
    end if;
    if v_appt_client <> p_client_id then
      raise exception 'Appointment is for a different client.' using errcode = 'check_violation';
    end if;
    if v_appt_pract is not null and v_appt_pract <> v_practitioner then
      raise exception 'Appointment is assigned to a different practitioner.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Coalesce window. FOR UPDATE closes the read-then-insert race that could
  -- produce two sessions for one visit.
  select s.id, s.appointment_id
    into v_session_id, v_existing_appt
    from public.sessions s
   where s.studio_id = v_studio_id
     and s.client_id = p_client_id
     and s.practitioner_id = v_practitioner
     and s.modality = p_modality
     and s.deleted_at is null
     and s.started_at >= (now() - make_interval(mins => coalesce(p_coalesce_minutes, 90)))
   order by s.started_at desc
   limit 1
     for update;

  if v_session_id is not null then
    v_reused := true;
    -- Promote a NULL link only. An existing different link is never overwritten.
    if p_appointment_id is not null and v_existing_appt is null then
      update public.sessions s
         set appointment_id = p_appointment_id
       where s.id = v_session_id
         and s.appointment_id is null;
    end if;
  else
    -- Auto-attach (electrolysis only) when the client has EXACTLY one active
    -- plan. Zero or multiple → unattached, same as the application helper.
    if p_modality = 'electrolysis' then
      select count(*) into v_plan_count
        from public.treatment_plans tp
       where tp.studio_id = v_studio_id
         and tp.client_id = p_client_id
         and tp.status = 'active';
      -- EXACTLY one active plan auto-attaches; zero or several leave the
      -- session unattached, matching getActiveTreatmentPlansForClient.
      if v_plan_count = 1 then
        select tp.id into v_auto_plan
          from public.treatment_plans tp
         where tp.studio_id = v_studio_id
           and tp.client_id = p_client_id
           and tp.status = 'active'
         limit 1;
      end if;
    end if;

    insert into public.sessions (
      studio_id, client_id, practitioner_id, performed_by_practitioner_id,
      modality, treatment_plan_id, appointment_id
    ) values (
      v_studio_id, p_client_id, v_practitioner, v_practitioner,
      p_modality, v_auto_plan, p_appointment_id
    )
    returning id into v_session_id;
  end if;

  return query select v_session_id, v_reused;
end;
$$;

-- ===========================================================================
-- COMMAND 2 — session price. NULL clears, exactly as the writer allowed.
-- ===========================================================================
create or replace function public.set_session_price(
  p_session_id  uuid,
  p_client_id   uuid,
  p_price_cents integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_price_cents is not null and p_price_cents < 0 then
    raise exception 'Price must be a non-negative number.' using errcode = 'check_violation';
  end if;

  update public.sessions s
     set price_paid_cents = p_price_cents
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;

-- ===========================================================================
-- COMMAND 3 — the note for the client's NEXT visit. NULL clears.
-- ===========================================================================
create or replace function public.set_next_session_note(
  p_session_id uuid,
  p_client_id  uuid,
  p_note       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  update public.sessions s
     set next_session_note = p_note
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;

-- ===========================================================================
-- COMMAND 4 — who performed the session. NULL clears the attribution.
-- The chosen practitioner must belong to the SAME studio.
-- ===========================================================================
create or replace function public.set_session_performer(
  p_session_id   uuid,
  p_client_id    uuid,
  p_performer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_performer_id is not null then
    perform 1 from public.practitioners p
      where p.id = p_performer_id and p.studio_id = v_studio_id;
    if not found then
      raise exception 'Practitioner not found in this studio.' using errcode = 'check_violation';
    end if;
  end if;

  update public.sessions s
     set performed_by_practitioner_id = p_performer_id
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;

-- ===========================================================================
-- COMMAND 5 — correct the session start time, with its audit row written in
-- the SAME transaction. Previously the update committed first and the audit
-- insert followed with only a console log on failure, so a corrected time
-- could exist with no audit trail. Returns true when a change was written.
-- ===========================================================================
create or replace function public.edit_session_started_at(
  p_session_id uuid,
  p_client_id  uuid,
  p_started_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id    uuid;
  v_practitioner uuid;
  v_old          timestamptz;
  v_ended        timestamptz;
begin
  if p_started_at is null then
    raise exception 'A session start time is required.' using errcode = 'check_violation';
  end if;

  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);
  v_practitioner := public.session_actor_practitioner(v_studio_id);

  select s.started_at, s.ended_at into v_old, v_ended
    from public.sessions s
   where s.id = p_session_id
     and s.studio_id = v_studio_id
     for update;

  if not found then
    raise exception 'Session not found.' using errcode = 'check_violation';
  end if;

  if v_ended is not null and p_started_at > v_ended then
    raise exception 'Session start cannot be after the session end time.'
      using errcode = 'check_violation';
  end if;

  -- Unchanged value: no write, no audit row — matching the writer's early exit.
  if v_old = p_started_at then
    return false;
  end if;

  update public.sessions s
     set started_at = p_started_at
   where s.id = p_session_id
     and s.studio_id = v_studio_id;

  insert into public.session_audit (
    session_id, edited_by_practitioner_id, field, old_value, new_value
  ) values (
    p_session_id, v_practitioner, 'started_at', v_old::text, p_started_at::text
  );

  return true;
end;
$$;

-- ===========================================================================
-- COMMAND 6 — soft-retire a session. SOFT only: `deleted_at` is stamped, never
-- a hard DELETE. `deleted_by` is DERIVED from auth.uid(), never accepted, so a
-- removal cannot be attributed to another practitioner.
-- ===========================================================================
create or replace function public.soft_delete_session(
  p_session_id uuid,
  p_client_id  uuid,
  p_reason     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id    uuid;
  v_practitioner uuid;
  v_id           uuid;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then
    raise exception 'Reason must be at least 10 characters.' using errcode = 'check_violation';
  end if;

  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  select p.id into v_practitioner
    from public.practitioners p
   where p.studio_id = v_studio_id
     and p.user_id = auth.uid()
     and p.active = true;

  if v_practitioner is null then
    raise exception 'Inactive practitioners cannot delete sessions.'
      using errcode = 'check_violation';
  end if;

  update public.sessions s
     set deleted_at    = now(),
         deleted_by    = v_practitioner,
         delete_reason = btrim(p_reason)
   where s.id = p_session_id
     and s.studio_id = v_studio_id
     and s.deleted_at is null
  returning s.id into v_id;

  if v_id is null then
    raise exception 'This session has already been removed.' using errcode = 'check_violation';
  end if;

  return v_id;
end;
$$;

-- ===========================================================================
-- COMMAND 7 — attach or detach the session's treatment plan. Replaces BOTH
-- attachChartEntryToPlanAction and detachChartEntryFromPlanAction: a NULL plan
-- detaches (always permitted), a non-NULL plan must be ACTIVE and belong to
-- the same studio AND the same client.
-- ===========================================================================
create or replace function public.set_session_treatment_plan(
  p_session_id uuid,
  p_client_id  uuid,
  p_plan_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id uuid;
  v_status    text;
  v_plan_cli  uuid;
begin
  v_studio_id := public.assert_session_writable(p_session_id, p_client_id);

  if p_plan_id is not null then
    select tp.status, tp.client_id into v_status, v_plan_cli
      from public.treatment_plans tp
     where tp.id = p_plan_id
       and tp.studio_id = v_studio_id;

    if v_status is null then
      raise exception 'Plan not found.' using errcode = 'check_violation';
    end if;
    if v_status <> 'active' then
      raise exception 'Cannot attach to a closed plan.' using errcode = 'check_violation';
    end if;
    if v_plan_cli <> p_client_id then
      raise exception 'Plan does not belong to this client.' using errcode = 'check_violation';
    end if;
  end if;

  update public.sessions s
     set treatment_plan_id = p_plan_id
   where s.id = p_session_id
     and s.studio_id = v_studio_id
     and s.client_id = p_client_id;
end;
$$;

-- ===========================================================================
-- COMMAND 8 — the practitioner-marked "risks explained + aftercare provided"
-- stamp. Set stamps both columns from server state; clear nulls both. This is
-- the ONLY writer of those columns, and the sessions_aftercare_audit trigger
-- still records the change.
--
-- Scoped by session + studio only: its writer has no client id in scope, so
-- this command uses assert_session_studio_for_actor rather than asserting a
-- client the caller never supplied.
-- ===========================================================================
create or replace function public.set_session_aftercare_explained(
  p_session_id uuid,
  p_explained  boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_id    uuid;
  v_practitioner uuid;
begin
  if p_explained is null then
    raise exception 'An explicit aftercare value is required.' using errcode = 'check_violation';
  end if;

  v_studio_id := public.assert_session_studio_for_actor(p_session_id);
  v_practitioner := public.session_actor_practitioner(v_studio_id);

  update public.sessions s
     set aftercare_and_risks_explained_at =
           case when p_explained then now() else null end,
         aftercare_and_risks_explained_by =
           case when p_explained then v_practitioner else null end
   where s.id = p_session_id
     and s.studio_id = v_studio_id;
end;
$$;

-- ===========================================================================
-- PRIVILEGES
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
-- AND service_role at function-create time. An authenticated-only command must
-- revoke from all three explicitly, by name, plus PUBLIC. 0129 revoked only
-- from PUBLIC and leaked `anon`; 0164 revoked PUBLIC+anon and left
-- `service_role`. Both are literal, per-signature statements here so the grant
-- guard can see them and a reader can audit them without executing anything.
--
-- The two INTERNAL helpers are revoked from authenticated as well and never
-- granted back: they are callable only by the DEFINER-owned commands above.
-- ===========================================================================

revoke execute on function public.session_actor_practitioner(uuid) from public;
revoke execute on function public.session_actor_practitioner(uuid) from anon;
revoke execute on function public.session_actor_practitioner(uuid) from service_role;
revoke execute on function public.session_actor_practitioner(uuid) from authenticated;

revoke execute on function public.assert_session_studio_for_actor(uuid) from public;
revoke execute on function public.assert_session_studio_for_actor(uuid) from anon;
revoke execute on function public.assert_session_studio_for_actor(uuid) from service_role;
revoke execute on function public.assert_session_studio_for_actor(uuid) from authenticated;

revoke execute on function public.start_session(uuid, text, uuid, integer) from public;
revoke execute on function public.start_session(uuid, text, uuid, integer) from anon;
revoke execute on function public.start_session(uuid, text, uuid, integer) from service_role;
revoke execute on function public.start_session(uuid, text, uuid, integer) from authenticated;

revoke execute on function public.set_session_price(uuid, uuid, integer) from public;
revoke execute on function public.set_session_price(uuid, uuid, integer) from anon;
revoke execute on function public.set_session_price(uuid, uuid, integer) from service_role;
revoke execute on function public.set_session_price(uuid, uuid, integer) from authenticated;

revoke execute on function public.set_next_session_note(uuid, uuid, text) from public;
revoke execute on function public.set_next_session_note(uuid, uuid, text) from anon;
revoke execute on function public.set_next_session_note(uuid, uuid, text) from service_role;
revoke execute on function public.set_next_session_note(uuid, uuid, text) from authenticated;

revoke execute on function public.set_session_performer(uuid, uuid, uuid) from public;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from anon;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from service_role;
revoke execute on function public.set_session_performer(uuid, uuid, uuid) from authenticated;

revoke execute on function public.edit_session_started_at(uuid, uuid, timestamptz) from public;
revoke execute on function public.edit_session_started_at(uuid, uuid, timestamptz) from anon;
revoke execute on function public.edit_session_started_at(uuid, uuid, timestamptz) from service_role;
revoke execute on function public.edit_session_started_at(uuid, uuid, timestamptz) from authenticated;

revoke execute on function public.soft_delete_session(uuid, uuid, text) from public;
revoke execute on function public.soft_delete_session(uuid, uuid, text) from anon;
revoke execute on function public.soft_delete_session(uuid, uuid, text) from service_role;
revoke execute on function public.soft_delete_session(uuid, uuid, text) from authenticated;

revoke execute on function public.set_session_treatment_plan(uuid, uuid, uuid) from public;
revoke execute on function public.set_session_treatment_plan(uuid, uuid, uuid) from anon;
revoke execute on function public.set_session_treatment_plan(uuid, uuid, uuid) from service_role;
revoke execute on function public.set_session_treatment_plan(uuid, uuid, uuid) from authenticated;

revoke execute on function public.set_session_aftercare_explained(uuid, boolean) from public;
revoke execute on function public.set_session_aftercare_explained(uuid, boolean) from anon;
revoke execute on function public.set_session_aftercare_explained(uuid, boolean) from service_role;
revoke execute on function public.set_session_aftercare_explained(uuid, boolean) from authenticated;

grant execute on function public.start_session(uuid, text, uuid, integer) to authenticated;
grant execute on function public.set_session_price(uuid, uuid, integer) to authenticated;
grant execute on function public.set_next_session_note(uuid, uuid, text) to authenticated;
grant execute on function public.set_session_performer(uuid, uuid, uuid) to authenticated;
grant execute on function public.edit_session_started_at(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.soft_delete_session(uuid, uuid, text) to authenticated;
grant execute on function public.set_session_treatment_plan(uuid, uuid, uuid) to authenticated;
grant execute on function public.set_session_aftercare_explained(uuid, boolean) to authenticated;

commit;
