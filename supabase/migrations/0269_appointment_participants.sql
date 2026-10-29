-- 0269 / HON-59: several practitioners' contributions to ONE visit.
-- PREPARE-ONLY stage head (number reserved by OPS). Additive; no data rewrite,
-- no billing, unit or charge field, no inference of payer units.
--
-- A session already carries exactly one practitioner and its blocks inherit that
-- author, so a multi-practitioner visit is several sessions linked to one
-- appointment. The only barrier on an ASSIGNED appointment is start_session
-- refusing a second practitioner. This adds:
--   1. public.appointment_participants: who the owner recorded as taking part;
--   2. public.add_appointment_participant: the ONLY writer;
--   3. start_session (5-arg, 0241 body) amended in one condition: an active
--      participant of that appointment may link their own chart to it.
-- Everything else in start_session (authority, studio proof, client/appointment
-- identity, advisory lock, coalescing, no relink) is the 0241 body unchanged.
--
-- WHO MAY ADD A PARTICIPANT: the owner only. That is ONE isolated check, marked
-- below; whether the assigned practitioner may also add a colleague is a pending
-- decision and changes only that predicate.
--
-- Rollout: schema first. An older app that never calls the new command is
-- unaffected: with no participant rows, start_session behaves exactly as 0241.

begin;
set local lock_timeout = '5s';

create table public.appointment_participants (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios(id) on delete cascade,
  appointment_id              uuid not null,
  practitioner_id             uuid not null,
  added_by_practitioner_id    uuid not null,
  added_at                    timestamptz not null default now(),
  constraint appointment_participants_appointment_fk
    foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete cascade,
  constraint appointment_participants_practitioner_fk
    foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete cascade,
  constraint appointment_participants_added_by_fk
    foreign key (added_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint appointment_participants_one_per_visit unique (appointment_id, practitioner_id)
);

create index appointment_participants_practitioner_idx
  on public.appointment_participants (studio_id, practitioner_id);

alter table public.appointment_participants enable row level security;

create policy "appointment_participants_member_select"
  on public.appointment_participants for select to authenticated
  using (public.is_studio_member(studio_id));

-- No direct write for any runtime role: the command below is the only writer.
revoke all on public.appointment_participants from public;
revoke all on public.appointment_participants from anon;
revoke all on public.appointment_participants from authenticated;
revoke all on public.appointment_participants from service_role;
grant select on public.appointment_participants to authenticated;
grant select on public.appointment_participants to service_role;

create or replace function public.add_appointment_participant(
  p_studio_id        uuid,
  p_appointment_id   uuid,
  p_practitioner_id  uuid
)
returns table (result text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor        uuid;
  v_appt_studio  uuid;
  v_appt_status  text;
  v_appt_pract   uuid;
  v_inserted     integer;
begin
  if auth.uid() is null then
    raise exception 'An authenticated practitioner is required.'
      using errcode = 'check_violation';
  end if;
  if p_studio_id is null or p_appointment_id is null or p_practitioner_id is null then
    return query select 'invalid_input'::text;
    return;
  end if;

  -- The actor is proven from the NAMED studio's own membership row.
  v_actor := public.session_actor_practitioner(p_studio_id);

  -- >>> THE ONE ISOLATED AUTHORITY CHECK (owner only). <<<
  -- To let the assigned practitioner add a colleague as well, change ONLY this
  -- predicate (the assigned practitioner is read below as v_appt_pract).
  if not public.is_studio_owner(p_studio_id) then
    return query select 'not_owner'::text;
    return;
  end if;

  select a.studio_id, a.status, a.practitioner_id
    into v_appt_studio, v_appt_status, v_appt_pract
    from public.appointments a
   where a.id = p_appointment_id
     for share;
  if v_appt_studio is null or v_appt_studio <> p_studio_id then
    return query select 'not_found'::text;
    return;
  end if;
  if v_appt_status not in ('confirmed', 'completed') then
    return query select 'appointment_not_active'::text;
    return;
  end if;

  perform 1 from public.practitioners p
   where p.id = p_practitioner_id and p.studio_id = p_studio_id and p.active = true;
  if not found then
    return query select 'practitioner_not_found'::text;
    return;
  end if;
  if v_appt_pract is not null and v_appt_pract = p_practitioner_id then
    return query select 'already_assigned'::text;
    return;
  end if;

  insert into public.appointment_participants
    (studio_id, appointment_id, practitioner_id, added_by_practitioner_id)
  values (p_studio_id, p_appointment_id, p_practitioner_id, v_actor)
  on conflict (appointment_id, practitioner_id) do nothing;
  get diagnostics v_inserted = row_count;

  return query select case when v_inserted = 1 then 'added' else 'already_participant' end;
end;
$$;

revoke execute on function public.add_appointment_participant(uuid, uuid, uuid) from public;
revoke execute on function public.add_appointment_participant(uuid, uuid, uuid) from anon;
revoke execute on function public.add_appointment_participant(uuid, uuid, uuid) from authenticated;
revoke execute on function public.add_appointment_participant(uuid, uuid, uuid) from service_role;
grant execute on function public.add_appointment_participant(uuid, uuid, uuid) to authenticated;

comment on function public.add_appointment_participant(uuid, uuid, uuid) is
  '0269: records a practitioner as a participant in one appointment so their own chart may link to it. Owner only (single isolated predicate). Idempotent; never changes the assigned practitioner or any session. No billing or unit inference.';

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
    -- 0269 / HON-59: the assigned practitioner, OR a practitioner the owner
    -- recorded as a participant in THIS appointment, may link a chart to it.
    -- Everyone else is refused exactly as before.
    if v_appt_pract is not null and v_appt_pract <> v_practitioner
       and not exists (
         select 1 from public.appointment_participants ap
          where ap.appointment_id = p_appointment_id
            and ap.studio_id = v_studio_id
            and ap.practitioner_id = v_practitioner
       ) then
      raise exception 'Appointment is assigned to a different practitioner.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- SERIALIZE THE COALESCE IDENTITY BEFORE LOOKING.
  --
  -- 0167 claimed "FOR UPDATE closes the read-then-insert race that could
  -- produce two sessions for one visit". That claim is only true when the
  -- window already CONTAINS a row: `for update` locks rows, and an empty
  -- result set locks nothing. Two overlapping first taps therefore both saw an
  -- empty window and both inserted, and no unique constraint stops them — i.e.
  -- the guarantee failed in exactly the double-tap case the coalescing exists
  -- to prevent. Carried into this file verbatim, so the false claim is fixed
  -- here rather than re-published.
  --
  -- A transaction-scoped advisory lock keyed on the COALESCE DIMENSIONS
  -- (studio, client, practitioner, modality) makes the lookup-then-insert
  -- atomic for one visit while leaving every other start unblocked. Taken
  -- AFTER authority is proven, so an unauthenticated or non-member caller can
  -- never make the database take a lock on its behalf; released automatically
  -- at commit or rollback. It is the only advisory lock in the session command
  -- surface and it is taken before any row lock, so it introduces no ordering
  -- cycle. pg_catalog-qualified because search_path is empty.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_studio_id::text || ':' || p_client_id::text || ':' ||
      v_practitioner::text || ':' || p_modality,
      0
    )
  );

  -- Coalesce window. Under the lock above, the read and the insert below are
  -- one atomic decision for this visit: a concurrent caller blocks here and
  -- then finds — and reuses — the row the first one created. Keyed on the
  -- PROVEN studio, so a reuse can never cross tenants.
  select s.id, s.appointment_id
    into v_session_id, v_existing_appt
    from public.sessions s
   where s.studio_id = v_studio_id
     and s.client_id = p_client_id
     and s.practitioner_id = v_practitioner
     and s.modality = p_modality
     and s.deleted_at is null
     and s.started_at >= (now() - make_interval(mins => coalesce(p_coalesce_minutes, 90)))
     -- A requested appointment may use its own chart or promote a NULL link,
     -- never another appointment's chart. No appointment context retains the
     -- existing recent-chart lookup without changing any existing link.
     and (p_appointment_id is null
          or s.appointment_id = p_appointment_id
          or s.appointment_id is null)
   -- Prefer an exact appointment match even when an unlinked chart is newer.
   -- Otherwise repeated/concurrent B starts could consume a different NULL
   -- chart despite an eligible B chart already existing under this same lock.
   order by case when p_appointment_id is not null
                      and s.appointment_id = p_appointment_id then 0 else 1 end,
            s.started_at desc
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

-- Re-close every default grantee; retain authenticated-only command authority.
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from public;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from anon;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from authenticated;
revoke execute on function public.start_session(uuid, text, uuid, integer, uuid) from service_role;
grant execute on function public.start_session(uuid, text, uuid, integer, uuid) to authenticated;

comment on function public.start_session(uuid, text, uuid, integer, uuid) is
  '0269: the 0241 body with ONE condition widened: an active participant of the requested appointment may link their own chart to it. Authority, studio proof, identity checks, advisory lock, coalescing and no-relink are unchanged.';

commit;
