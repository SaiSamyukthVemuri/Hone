-- HON-48: check-in lifecycle. OPS reservation 0268. PREPARE-ONLY: sealed
-- discipline, no hosted apply without its own approval.
--
-- A front-desk fact the calendar cannot derive: this client has arrived.
-- ORTHOGONAL to appointments.status. No status value is added, so the
-- overlap/capacity triggers (0134, 0152) and every status-keyed reader are
-- untouched; arriving is not a terminal state.
--
--   * appointments.arrived_at: null = not checked in. Written only by
--     set_appointment_arrived. Nothing else holds UPDATE on appointments
--     (0172, 0174, 0177), so the new column is unwritable by every API role.
--   * set_appointment_arrived: authenticated only. The actor is derived IN the
--     database from auth.uid() for p_studio_id, never caller-supplied.
--   * WHO MAY SET IT is one isolated predicate, arrival_receptionist_allowed(),
--     which returns false. Owner and practitioner are the active practitioners
--     rows of the studio (the owner is a practitioners row with role 'owner').
--     Letting a receptionist check clients in is a later one-line
--     create or replace of that predicate, nothing else.
--   * Cancelling or marking a no-show clears the arrival (trigger below), so a
--     closed appointment never reads as "checked in".
--   * Idempotent, audited through the existing appointment_audit trail.
begin;
set local lock_timeout = '5s';

alter table public.appointments add column arrived_at timestamptz;

comment on column public.appointments.arrived_at is
  'HON-48/0268. When the client was checked in at the front desk; null = not checked in. Written only by set_appointment_arrived. Cleared when the appointment is cancelled or marked no-show.';

-- ---------------------------------------------------------------------------
-- The isolated receptionist decision. Constant false until OPS/Sam decides.
-- ---------------------------------------------------------------------------
create function public.arrival_receptionist_allowed()
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$ select false $$;

comment on function public.arrival_receptionist_allowed() is
  'HON-48/0268. The ONE switch for whether a studio receptionist may check clients in. false = owner and practitioner only. Changing the decision is a create or replace of this function in a later migration; no other object depends on the answer being false.';

revoke all on function public.arrival_receptionist_allowed() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The actor: the signed-in user's own row for p_studio_id, else nothing.
-- ---------------------------------------------------------------------------
create function public.appointment_arrival_actor(p_studio_id uuid)
returns table (actor_type text, actor_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  select pr.id into v_id
    from public.practitioners pr
   where pr.studio_id = p_studio_id
     and pr.user_id = auth.uid()
     and pr.active
   limit 1;
  if v_id is not null then
    return query select 'practitioner'::text, v_id;
    return;
  end if;

  if public.arrival_receptionist_allowed() then
    v_id := public.receptionist_actor_id(p_studio_id);
    if v_id is not null then
      return query select 'receptionist'::text, v_id;
      return;
    end if;
  end if;
  return;
end;
$$;

revoke all on function public.appointment_arrival_actor(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The command. Returns: arrived | cleared | unchanged | not_authorized |
-- not_found | wrong_status.
-- ---------------------------------------------------------------------------
create function public.set_appointment_arrived(
  p_studio_id uuid,
  p_appointment_id uuid,
  p_arrived boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor_type text;
  v_actor_id uuid;
  v_appt public.appointments%rowtype;
begin
  select a.actor_type, a.actor_id into v_actor_type, v_actor_id
    from public.appointment_arrival_actor(p_studio_id) a;
  if v_actor_id is null then
    return 'not_authorized';
  end if;
  if p_arrived is null then
    return 'wrong_status';
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_found';
  end if;

  if p_arrived then
    if v_appt.status <> 'confirmed' then
      return 'wrong_status';
    end if;
    if v_appt.arrived_at is not null then
      return 'unchanged';
    end if;
    update public.appointments set arrived_at = now() where id = v_appt.id;
    insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
    values (v_appt.id, v_actor_type, v_actor_id, 'checked_in',
            jsonb_build_object('source', 'front_desk'));
    return 'arrived';
  end if;

  if v_appt.arrived_at is null then
    return 'unchanged';
  end if;
  update public.appointments set arrived_at = null where id = v_appt.id;
  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (v_appt.id, v_actor_type, v_actor_id, 'check_in_undone',
          jsonb_build_object('source', 'front_desk'));
  return 'cleared';
end;
$$;

comment on function public.set_appointment_arrived(uuid, uuid, boolean) is
  'HON-48/0268. Check a client in (true) or undo it (false). Actor derived from auth.uid() for p_studio_id: an active owner/practitioner of that studio (a receptionist only if arrival_receptionist_allowed()). Arrival requires status confirmed; idempotent; audited.';

revoke all on function public.set_appointment_arrived(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_appointment_arrived(uuid, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- A closed appointment is never "checked in".
-- ---------------------------------------------------------------------------
create function public.clear_arrival_on_close()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status in ('cancelled', 'no_show') then
    new.arrived_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.clear_arrival_on_close() from public, anon, authenticated, service_role;

create trigger appointments_clear_arrival_on_close_trg
  before update of status on public.appointments
  for each row
  execute function public.clear_arrival_on_close();

commit;
