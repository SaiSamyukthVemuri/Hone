-- 0288 — ROLES R3 (HELD), SECTION 1 (Team, Q-1): the actor-explicit permission function, plus the shared helpers it needs.
--
-- Built on 0287. This file carries ONLY Team's section; Machines adds the money/price sections (services, client_pricing, money path) after it.
-- Requirements: insurance/R3-DESIGN-REVIEW.md (Q-1), privacy/R3-DESIGN-REVIEW.md, machines/R3-DESIGN-0288-v3.md section 7, team/R3-DESIGN-REVIEW.md.
--
--   * `has_studio_permission_for_target(p_user, p_key, p_target_kind, p_target_id)`: the same answer `has_studio_permission` gives that user,
--     for a caller that is not that user (a service-role step continuing an attempt a verified user started). Boolean only.
--   * ONE implementation. The decision after "who is the actor" moves into `perm_decide`; the actor lookup moves into `perm_actor_of(studio, user)`.
--     `perm_actor` and `has_studio_permission` are re-created as thin callers, with the same signatures, volatility, security and grants as in 0287,
--     so both entry points share every line of the decision and cannot drift.
--   * The studio is DERIVED from the target row. There is no studio argument, so no argument can name another studio. An unknown kind, a missing
--     target, a null user, a user who is not an ACTIVE member of that studio, or an unknown key all answer false.
--   * `service_role` EXECUTE only. `public`, `anon`, `authenticated` are revoked by name: an API caller would otherwise get an oracle on anyone's rights.
--   * Receptionist resolution and the `receptionist_finance` ship gate are the engine's own (perm_effective_scope), unchanged.
-- Target kinds (closed list, static branches, no dynamic SQL): 'appointment', 'session', 'attempt', 'client'.
--   own-scope context is DERIVED, never accepted: appointment <- the row (session: sessions.appointment_id; attempt: its appointment_id, else its
--   session's appointment). A target with no appointment cannot satisfy an `own` appointment key: it fails closed; `studio` scope still works.
-- No data is read or written beyond the target's ids. HELD: not applied anywhere; hosted state untouched.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) The actor lookup, for any user. `perm_actor(p_studio)` keeps its contract and now calls this with auth.uid().
-- ---------------------------------------------------------------------------
create or replace function public.perm_actor_of(p_studio uuid, p_user uuid)
returns table (membership_id uuid, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select pr.id, pr.role from public.practitioners pr
     where pr.studio_id = p_studio and pr.user_id = p_user and pr.active
    union all
    select r.id, 'receptionist'::text from public.studio_receptionists r
     where r.studio_id = p_studio and r.user_id = p_user and r.active
  ) x
  where p_user is not null
  limit 1
$$;

create or replace function public.perm_actor(p_studio uuid)
returns table (membership_id uuid, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.perm_actor_of(p_studio, auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- 2) The decision, once. Body moved unchanged from has_studio_permission (0287): the owner holds every catalogued key; otherwise the effective
--    scope decides, and `own` is evaluated against the CURRENT appointment rows on every call.
-- ---------------------------------------------------------------------------
create or replace function public.perm_decide(
  p_studio uuid,
  p_key text,
  p_membership uuid,
  p_role text,
  p_client uuid default null,
  p_appointment uuid default null,
  p_practitioner uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.permission_catalog%rowtype;
  v_scope text;
begin
  select * into c from public.permission_catalog where key = p_key;
  if not found then return false; end if;
  if p_role = 'owner' then return true; end if;
  v_scope := public.perm_effective_scope(p_studio, p_role, p_key);
  if v_scope = 'studio' then return true; end if;
  if v_scope <> 'own' then return false; end if;
  if c.own_kind = 'appointment' then
    return p_appointment is not null and exists (
      select 1 from public.appointments ap
       where ap.id = p_appointment and ap.studio_id = p_studio and ap.practitioner_id = p_membership);
  elsif c.own_kind = 'client' then
    -- Sam, batch 4 + clarification: a non-cancelled appointment in THIS studio, past or upcoming, CURRENTLY assigned to the actor.
    return p_client is not null and exists (
      select 1 from public.appointments ap
       where ap.studio_id = p_studio and ap.client_id = p_client and ap.practitioner_id = p_membership and ap.status <> 'cancelled');
  elsif c.own_kind = 'practitioner' then
    return p_practitioner is not null and p_practitioner = p_membership;
  end if;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) The JWT-called entry point, now a thin caller. Same signature, STABLE, SECURITY DEFINER and ACL as in 0287 (create or replace keeps the ACL).
-- ---------------------------------------------------------------------------
create or replace function public.has_studio_permission(
  p_studio uuid,
  p_key text,
  p_client uuid default null,
  p_appointment uuid default null,
  p_practitioner uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from public.perm_actor(p_studio);
  if not found then return false; end if;
  return public.perm_decide(p_studio, p_key, a.membership_id, a.role, p_client, p_appointment, p_practitioner);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) The actor-explicit entry point (service_role only).
-- ---------------------------------------------------------------------------
create or replace function public.has_studio_permission_for_target(
  p_user uuid,
  p_key text,
  p_target_kind text,
  p_target_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_studio uuid;
  v_client uuid;
  v_appointment uuid;
  v_practitioner uuid;
  a record;
begin
  if p_user is null or p_key is null or p_target_kind is null or p_target_id is null then return false; end if;
  if p_target_kind = 'appointment' then
    select ap.studio_id, ap.client_id, ap.id, ap.practitioner_id
      into v_studio, v_client, v_appointment, v_practitioner
      from public.appointments ap where ap.id = p_target_id;
  elsif p_target_kind = 'session' then
    select s.studio_id, s.client_id, s.appointment_id, s.practitioner_id
      into v_studio, v_client, v_appointment, v_practitioner
      from public.sessions s where s.id = p_target_id;
  elsif p_target_kind = 'attempt' then
    select pa.studio_id, pa.client_id, coalesce(pa.appointment_id, s.appointment_id), s.practitioner_id
      into v_studio, v_client, v_appointment, v_practitioner
      from public.payment_charge_attempts pa
      left join public.sessions s on s.id = pa.session_id and s.studio_id = pa.studio_id
     where pa.id = p_target_id;
  elsif p_target_kind = 'client' then
    select c.studio_id, c.id into v_studio, v_client from public.clients c where c.id = p_target_id;
  else
    return false;
  end if;
  if v_studio is null then return false; end if;
  select * into a from public.perm_actor_of(v_studio, p_user);
  if not found then return false; end if;
  return public.perm_decide(v_studio, p_key, a.membership_id, a.role, v_client, v_appointment, v_practitioner);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Privileges. Internal helpers are callable by nobody through the API; the explicit entry point by service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.perm_actor_of(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.perm_decide(uuid, text, uuid, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.has_studio_permission_for_target(uuid, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.has_studio_permission_for_target(uuid, text, text, uuid) to service_role;

commit;
