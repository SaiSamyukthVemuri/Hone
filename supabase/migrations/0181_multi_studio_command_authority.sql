-- ===========================================================================
-- MULTI-STUDIO COMMAND AUTHORITY — 0181
-- ===========================================================================
--
-- P1 PRODUCTION INCIDENT. A practitioner with TWO active studio memberships
-- could open /clients/<id>/sessions/new (HTTP 200) and then receive HTTP 500
-- on selecting a modality:
--
--   Error: Failed to start session: Client not found in this studio.
--   digest: 2140849265
--
-- THE DEFECT, exactly. 0167's `start_session` resolved the acting studio as:
--
--   select p.studio_id into v_studio_id
--     from public.practitioners p
--    where p.user_id = auth.uid()
--      and p.active = true
--    limit 1;
--
-- No selected-studio input, no studio predicate, NO ORDER BY. For one active
-- membership that is exact. For two it is an ARBITRARY PICK, and the command
-- then validated the client against whichever membership came back.
--
-- Meanwhile the application resolves the studio CORRECTLY:
-- `getCurrentPractitionerWithStudio()` honours the user's validated studio
-- selection and never auto-picks across memberships. So the page rendered
-- against the SELECTED studio (client found → 200) while the command ran
-- against the ARBITRARY one (client absent → raise → 500).
--
-- `start_session` is the ONLY session command that had to resolve a studio at
-- all: every other command in 0167 anchors to an EXISTING session row through
-- `assert_session_writable` / `assert_session_studio_for_actor`. A start has no
-- session yet, so it was the one place forced to guess — and it guessed.
--
-- WHY NOT JUST ADD `order by`. There is no correct ordering rule. Neither
-- created_at, nor role, nor studio name expresses "the studio this human is
-- currently working in". Only the application knows that, so the application
-- must say it, and the database must verify it.
--
-- THE FIX. `start_session` gains an EXPLICIT `p_studio_id`, which is NOT
-- trusted: the command re-proves, at the SECURITY DEFINER boundary, that
-- auth.uid() holds an ACTIVE practitioner row IN THAT STUDIO, and derives the
-- practitioner id from that same row. A studio the caller is not an active
-- member of is refused before any read of the client.
--
-- ZERO-DOWNTIME ROLLOUT. A hosted migration and a Vercel deployment do not
-- switch in the same instant, so the OLD four-argument caller MUST keep working
-- while the new application rolls out. The four-argument signature is therefore
-- RETAINED as a thin delegating wrapper — but with the arbitrary pick REMOVED.
-- It derives the target studio deterministically from the CLIENT's own studio
-- (a client belongs to exactly one) and admits it only if auth.uid() is an
-- active practitioner there, then delegates into the explicit command. There is
-- no second copy of the body to drift, and no membership is ever chosen at
-- random. Migration-first is safe; the application then binds explicitly.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT TOUCH
--   * `treatment_image_actor`. 0168 shipped the same defect class, but 0178
--     ALREADY FIXED IT — the live function is `treatment_image_actor(p_studio_id
--     uuid)`, studio-constrained, and the zero-argument form no longer exists.
--     Verified against the live schema, not against migration file text. A
--     LIVE-SCHEMA census of every SECURITY DEFINER function that resolves a
--     practitioner from auth.uid() found `start_session` as the SOLE remaining
--     unconstrained resolver; `amend_finalized_session`,
--     `amend_finalized_session_with_image`, `correct_finalized_session`,
--     `finalize_session`, `record_keeping_audit_actor`, `soft_delete_session_area`
--     and `treatment_image_actor` all constrain by a known studio first, and
--     `reconcile_my_pending_invitation`'s unconstrained read is a `count(*)`
--     used to decide whether a chooser is needed — not an actor pick.
--   * Every other 0167 command, and `session_actor_practitioner` itself. The
--     helper is already exactly the primitive this fix needs (studio in, active
--     membership proven, practitioner id out) and is reused verbatim.
--   * Any table. This is a FUNCTION/AUTHORITY migration: no DDL on tables, no
--     backfill, no row mutation. Existing rows are valid; the defect was
--     command resolution, not stored data.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- COMMAND — start (or reuse) a session IN AN EXPLICIT, PROVEN STUDIO.
--
-- Body is 0167's, unchanged except for the actor/studio resolution at the top.
-- Every downstream invariant is preserved verbatim: client-in-studio, the three
-- appointment lineage checks, the FOR UPDATE coalesce window keyed on
-- (studio, client, practitioner, modality, time), NULL-only appointment-link
-- promotion, and electrolysis-only exactly-one-active-plan auto-attach.
-- ---------------------------------------------------------------------------
create or replace function public.start_session(
  p_client_id        uuid,
  p_modality         text,
  p_appointment_id   uuid,
  p_coalesce_minutes integer,
  p_studio_id        uuid
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

  -- The studio is NAMED by the caller and PROVEN here. A missing value is an
  -- unresolvable actor context, not a licence to pick one.
  if p_studio_id is null then
    raise exception 'No active practitioner found for the signed-in user.'
      using errcode = 'check_violation';
  end if;
  v_studio_id := p_studio_id;

  -- THE TRUST BOUNDARY. session_actor_practitioner re-reads
  -- practitioners WHERE studio_id = <named> AND user_id = auth.uid() AND
  -- active, so a studio the caller does not actively belong to yields no row
  -- and is refused ('Inactive practitioners cannot edit sessions.', already a
  -- mapped safe message). The practitioner id used for attribution, coalescing
  -- and appointment lineage therefore comes from the NAMED studio's own
  -- membership row — never from another tenant's.
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
  -- produce two sessions for one visit. Keyed on the PROVEN studio, so a reuse
  -- can never cross tenants.
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
    -- Scoped to the PROVEN studio.
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

-- ---------------------------------------------------------------------------
-- LEGACY FOUR-ARGUMENT SIGNATURE — migration-first compatibility ONLY.
--
-- Retained so the currently-deployed application keeps working between the
-- hosted apply and the Vercel deploy. It is a thin delegation, NOT a second
-- implementation: there is exactly one body, above.
--
-- The arbitrary membership pick is GONE. The studio is derived from the
-- CLIENT — `clients.studio_id` is single-valued, so the target studio is a
-- fact of the resource, not a choice — and admitted only when auth.uid() holds
-- an ACTIVE practitioner row in that same studio. A caller who is not an active
-- member of the client's studio gets the same refusal a non-member always got.
-- Deterministic for one membership and for many.
--
-- PostgREST resolves overloads by the argument-name set in the request body,
-- and `p_studio_id` deliberately carries NO DEFAULT, so a four-key payload can
-- only match this function and a five-key payload can only match the explicit
-- command. No ambiguous candidate.
--
-- Once the application binds explicitly this signature has no caller. It is
-- kept for the rollout window and may be dropped by a later migration.
-- ---------------------------------------------------------------------------
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
  v_studio_id uuid;
begin
  select c.studio_id into v_studio_id
    from public.clients c
    join public.practitioners p
      on p.studio_id = c.studio_id
   where c.id = p_client_id
     and p.user_id = auth.uid()
     and p.active = true;

  -- Unknown client, or the caller is not an active member of that client's
  -- studio. Same message the 0167 command raised for the same situation.
  if v_studio_id is null then
    raise exception 'Client not found in this studio.' using errcode = 'check_violation';
  end if;

  return query
    select s.session_id, s.reused
      from public.start_session(
             p_client_id,
             p_modality,
             p_appointment_id,
             p_coalesce_minutes,
             v_studio_id
           ) s;
end;
$$;

-- ---------------------------------------------------------------------------
-- PRIVILEGES
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time. An authenticated-only command must
-- revoke from all three explicitly, by name, plus PUBLIC (0129 leaked `anon`;
-- 0164 left `service_role`). Literal, per-signature statements so the grant
-- guard can see them. Both signatures are re-stated because CREATE OR REPLACE
-- re-applies the default privileges.
-- ---------------------------------------------------------------------------

revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from public;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from anon;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from service_role;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from authenticated;

revoke execute on function public.start_session(uuid, text, uuid, integer) from public;
revoke execute on function public.start_session(uuid, text, uuid, integer) from anon;
revoke execute on function public.start_session(uuid, text, uuid, integer) from service_role;
revoke execute on function public.start_session(uuid, text, uuid, integer) from authenticated;

grant execute on function public.start_session(uuid, text, uuid, integer, uuid) to authenticated;
grant execute on function public.start_session(uuid, text, uuid, integer) to authenticated;

comment on function public.start_session(uuid, text, uuid, integer, uuid) is
  'Start or reuse a session in an EXPLICIT studio. p_studio_id is named by the '
  'server-resolved selection and re-proved here against an ACTIVE practitioner '
  'row for auth.uid() in that studio (0181).';

comment on function public.start_session(uuid, text, uuid, integer) is
  'DEPRECATED migration-first compatibility wrapper (0181). Derives the studio '
  'from the client and an active membership, then delegates to the explicit '
  'five-argument command. Carries no arbitrary membership selection.';

commit;
