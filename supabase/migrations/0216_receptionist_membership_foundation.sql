-- 0216 — STUDIO-READY-02a (#824): the receptionist membership foundation.
--
-- A receptionist is NOT a `practitioners` row. Every existing RLS policy reads
-- membership through `is_studio_member` / `is_studio_owner`, which select from
-- `practitioners`, and every existing definer command resolves its actor from
-- `practitioners`. A user whose only membership is a `studio_receptionists`
-- row is therefore refused by ALL of them BY CONSTRUCTION: no existing policy,
-- command or grant is changed here, and nothing that is forgotten can leak.
-- The only access a receptionist gets is what the objects below grant:
--
--   * `receptionist_calendar`          appointment times, status, service,
--                                      practitioner name/colour, client name
--   * `receptionist_calendar_closures` blocks/breaks/blockouts per resource,
--                                      kind and interval only (no labels)
--   * `receptionist_client_contacts`   client id, name, phone, email, and
--                                      intake/consent COMPLETION only
--
-- Not here (separate, reviewed slices): receptionist booking/move/cancel over a
-- shared booking core and its audit attribution (STUDIO-READY-02b — the one
-- seam shared with WAIT v4), invitation acceptance for the receptionist role,
-- and every server route and UI (STUDIO-READY-02c). `pending_invitations.role`
-- is deliberately UNCHANGED, so no receptionist invitation can exist yet.
--
-- Also excluded by construction: a receptionist has no `practitioners` id, so
-- it can never be a booking target, a `service_practitioners` row, a capacity
-- fan-out key, an assignment candidate or a capacity count.
--
-- Migration-first, forward-only, additive: one new table, guards, and new
-- functions. No existing row, column, policy or function is altered except the
-- one new BEFORE trigger on `practitioners` (the dual-membership guard), which
-- refuses only a state no existing row can be in (no receptionist rows exist).

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) The membership.
--
-- `user_id` mirrors `practitioners.user_id` (nullable, ON DELETE SET NULL), so
-- a membership row outlives a deleted auth user as history, and the later
-- audit references (02b) can never be cascaded away. `created_by_practitioner_id`
-- is EVIDENCE, deliberately without an FK: a second relationship between
-- `studio_receptionists` and `practitioners` would make PostgREST embeds of the
-- pair ambiguous, and an actor id must survive the actor's deletion.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_receptionists (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios(id) on delete cascade,
  user_id                     uuid references auth.users(id) on delete set null,
  display_name                text not null,
  email                       text,
  active                      boolean not null default true,
  created_at                  timestamptz not null default now(),
  created_by_practitioner_id  uuid,
  deactivated_at              timestamptz,
  constraint studio_receptionists_studio_user_key unique (studio_id, user_id),
  constraint studio_receptionists_id_studio_key unique (id, studio_id),
  constraint studio_receptionists_display_name_check
    check (char_length(btrim(display_name)) between 1 and 120),
  constraint studio_receptionists_deactivated_check
    check (active or deactivated_at is not null)
);

comment on table public.studio_receptionists is
  'STUDIO-READY-02a/0216 (#824). Receptionist membership, deliberately separate from practitioners so every existing policy and command refuses a receptionist by construction. Writes only through the service-role lifecycle commands.';

create index if not exists studio_receptionists_user_active_idx
  on public.studio_receptionists (user_id)
  where active;

-- ---------------------------------------------------------------------------
-- 2) One person is never both an active practitioner and an active
--    receptionist in the same studio. Both sides take the same transaction
--    advisory lock on (studio, user), so two concurrent inserts serialize and
--    the second sees the first.
-- ---------------------------------------------------------------------------
create or replace function public.studio_membership_kind_lock(p_studio_id uuid, p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
  select pg_advisory_xact_lock(
    hashtextextended('hone:membership-kind:' || p_studio_id::text || ':' || p_user_id::text, 0)
  );
$$;

revoke execute on function public.studio_membership_kind_lock(uuid, uuid) from public;
revoke execute on function public.studio_membership_kind_lock(uuid, uuid) from anon;
revoke execute on function public.studio_membership_kind_lock(uuid, uuid) from authenticated;
revoke execute on function public.studio_membership_kind_lock(uuid, uuid) from service_role;

create or replace function public.studio_receptionists_membership_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.active and new.user_id is not null then
    perform public.studio_membership_kind_lock(new.studio_id, new.user_id);
    if exists (
      select 1 from public.practitioners pr
       where pr.studio_id = new.studio_id
         and pr.user_id = new.user_id
         and pr.active
    ) then
      raise exception 'receptionist_is_active_practitioner'
        using errcode = '23514',
              detail = 'An active practitioner cannot also be an active receptionist in the same studio.';
    end if;
  end if;
  return new;
end;
$$;

-- A trigger fires without an EXECUTE check, so no role needs to call it directly.
revoke execute on function public.studio_receptionists_membership_guard() from public;
revoke execute on function public.studio_receptionists_membership_guard() from anon;
revoke execute on function public.studio_receptionists_membership_guard() from authenticated;
revoke execute on function public.studio_receptionists_membership_guard() from service_role;

drop trigger if exists studio_receptionists_membership_guard_trg on public.studio_receptionists;
create trigger studio_receptionists_membership_guard_trg
  before insert or update of active, user_id, studio_id on public.studio_receptionists
  for each row execute function public.studio_receptionists_membership_guard();

create or replace function public.practitioners_receptionist_membership_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.active and new.user_id is not null then
    perform public.studio_membership_kind_lock(new.studio_id, new.user_id);
    if exists (
      select 1 from public.studio_receptionists sr
       where sr.studio_id = new.studio_id
         and sr.user_id = new.user_id
         and sr.active
    ) then
      raise exception 'practitioner_is_active_receptionist'
        using errcode = '23514',
              detail = 'An active receptionist cannot also be an active practitioner in the same studio.';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.practitioners_receptionist_membership_guard() from public;
revoke execute on function public.practitioners_receptionist_membership_guard() from anon;
revoke execute on function public.practitioners_receptionist_membership_guard() from authenticated;
revoke execute on function public.practitioners_receptionist_membership_guard() from service_role;

drop trigger if exists practitioners_receptionist_membership_guard_trg on public.practitioners;
create trigger practitioners_receptionist_membership_guard_trg
  before insert or update of active, user_id, studio_id on public.practitioners
  for each row execute function public.practitioners_receptionist_membership_guard();

-- ---------------------------------------------------------------------------
-- 3) Row-level security. A receptionist reads their OWN row; the studio owner
--    reads the studio's rows. No browser role writes at all.
-- ---------------------------------------------------------------------------
alter table public.studio_receptionists enable row level security;

drop policy if exists "studio_receptionists: self or owner select" on public.studio_receptionists;
create policy "studio_receptionists: self or owner select"
  on public.studio_receptionists
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_studio_owner(studio_id));

revoke all on table public.studio_receptionists from anon;
revoke insert, update, delete, truncate on table public.studio_receptionists from authenticated;
grant select on table public.studio_receptionists to authenticated;

-- ---------------------------------------------------------------------------
-- 4) The server-resolved receptionist identity. Internal: every projection
--    derives the actor from the JWT (auth.uid()), never from an argument.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_actor_id(p_studio_id uuid)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select sr.id
    from public.studio_receptionists sr
   where sr.studio_id = p_studio_id
     and sr.user_id = auth.uid()
     and sr.active
   limit 1;
$$;

revoke execute on function public.receptionist_actor_id(uuid) from public;
revoke execute on function public.receptionist_actor_id(uuid) from anon;
revoke execute on function public.receptionist_actor_id(uuid) from authenticated;
revoke execute on function public.receptionist_actor_id(uuid) from service_role;

-- ---------------------------------------------------------------------------
-- 5) Projections. Authenticated-only (revoked from public, anon AND
--    service_role by name — tests/security/clinical-rpc-grant-guard.test.ts),
--    each refusing a non-receptionist caller with 42501 and bounding its window
--    or result size so it cannot become a bulk export.
-- ---------------------------------------------------------------------------
create or replace function public.receptionist_calendar(
  p_studio_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
)
returns table (
  appointment_id            uuid,
  starts_at                 timestamptz,
  ends_at                   timestamptz,
  status                    text,
  practitioner_id           uuid,
  practitioner_display_name text,
  practitioner_color        text,
  service_id                uuid,
  service_name              text,
  client_id                 uuid,
  client_display_name       text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  -- Fixed columns only. Appointment notes, prices, payment state and every
  -- clinical field stay out until a product decision adds one (#824 §2.1).
  return query
    select a.id, a.starts_at, a.ends_at, a.status,
           a.practitioner_id, pr.display_name, pr.color,
           a.service_id, sv.name,
           a.client_id, c.name
      from public.appointments a
      left join public.practitioners pr on pr.id = a.practitioner_id and pr.studio_id = a.studio_id
      left join public.services sv on sv.id = a.service_id and sv.studio_id = a.studio_id
      left join public.clients c on c.id = a.client_id and c.studio_id = a.studio_id
     where a.studio_id = p_studio_id
       and a.starts_at < p_to
       and a.ends_at > p_from
     order by a.starts_at, a.id;
end;
$$;

revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz)
  to authenticated;

create or replace function public.receptionist_calendar_closures(
  p_studio_id uuid,
  p_from      timestamptz,
  p_to        timestamptz
)
returns table (
  source_kind              text,
  starts_at                timestamptz,
  ends_at                  timestamptz,
  resource_practitioner_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  -- Per resource, straight from the canonical reservation shadow: a capacity-ON
  -- studio's studio-wide block appears once per practitioner (its fan-out); a
  -- capacity-OFF studio's appears once with a NULL resource. Kind and interval
  -- only — block labels can carry personal text and stay out.
  return query
    select r.source_kind, r.starts_at, r.ends_at,
           case when r.resource_key = r.studio_id then null else r.resource_key end
      from public.studio_calendar_reservations r
     where r.studio_id = p_studio_id
       and r.source_kind <> 'appointment'
       and r.starts_at < p_to
       and r.ends_at > p_from
     order by r.starts_at, r.source_kind, r.resource_key;
end;
$$;

revoke execute on function public.receptionist_calendar_closures(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_calendar_closures(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_calendar_closures(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.receptionist_calendar_closures(uuid, timestamptz, timestamptz)
  to authenticated;

create or replace function public.receptionist_client_contacts(
  p_studio_id uuid,
  p_query     text    default null,
  p_limit     integer default 25
)
returns table (
  client_id           uuid,
  name                text,
  phone               text,
  email               text,
  intake_status       text,
  intake_submitted_at timestamptz,
  consent_accepted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query   text    := nullif(btrim(coalesce(p_query, '')), '');
  v_pattern text;
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_query is not null then
    if char_length(v_query) < 2 then
      raise exception 'query_too_short' using errcode = '22023';
    end if;
    -- Escape LIKE metacharacters so the search is literal.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  -- Contact fields and COMPLETION facts only. Health answers, signed document
  -- content, date of birth, address, allergies, contraindications, notes and
  -- every other clinical column stay out.
  return query
    select c.id, c.name, c.phone, c.email,
           coalesce(latest_intake.status, 'none'),
           latest_intake.submitted_at,
           accepted_consent.signed_at
      from public.clients c
      left join lateral (
        select f.status, f.submitted_at
          from public.client_intake_forms f
         where f.client_id = c.id
           and f.studio_id = c.studio_id
           and f.deleted_at is null
         order by f.created_at desc, f.id desc
         limit 1
      ) latest_intake on true
      left join lateral (
        select max(s.signed_at) as signed_at
          from public.client_consent_signatures s
         where s.client_id = c.id
           and s.studio_id = c.studio_id
           and s.response = 'accepted'
      ) accepted_consent on true
     where c.studio_id = p_studio_id
       and c.archived_at is null
       and (
         v_pattern is null
         or c.name ilike v_pattern
         or c.email ilike v_pattern
         or c.phone ilike v_pattern
       )
     order by c.name, c.id
     limit v_limit;
end;
$$;

revoke execute on function public.receptionist_client_contacts(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts(uuid, text, integer) from service_role;
grant execute on function public.receptionist_client_contacts(uuid, text, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Lifecycle commands. Service-role only: the trusted server resolves the
--    signed-in OWNER and passes their practitioner id, which is re-verified
--    here (active owner of this studio) exactly as the scheduling commands do.
-- ---------------------------------------------------------------------------
create or replace function public.add_studio_receptionist(
  p_studio_id              uuid,
  p_owner_practitioner_id  uuid,
  p_user_id                uuid,
  p_display_name           text,
  p_email                  text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_owner_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active
       and pr.role = 'owner'
  ) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'invalid_user' using errcode = '22023';
  end if;

  perform public.studio_membership_kind_lock(p_studio_id, p_user_id);

  select sr.id into v_id
    from public.studio_receptionists sr
   where sr.studio_id = p_studio_id and sr.user_id = p_user_id
   for update;

  if found then
    -- Reactivate in place; the membership guard re-checks the practitioner side.
    update public.studio_receptionists
       set active = true,
           deactivated_at = null,
           display_name = btrim(p_display_name),
           email = nullif(btrim(coalesce(p_email, '')), '')
     where id = v_id;
    return v_id;
  end if;

  insert into public.studio_receptionists
    (studio_id, user_id, display_name, email, active, created_by_practitioner_id)
  values
    (p_studio_id, p_user_id, btrim(p_display_name),
     nullif(btrim(coalesce(p_email, '')), ''), true, p_owner_practitioner_id)
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.add_studio_receptionist(uuid, uuid, uuid, text, text) from public;
revoke execute on function public.add_studio_receptionist(uuid, uuid, uuid, text, text) from anon;
revoke execute on function public.add_studio_receptionist(uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.add_studio_receptionist(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.set_studio_receptionist_active(
  p_studio_id              uuid,
  p_owner_practitioner_id  uuid,
  p_receptionist_id        uuid,
  p_active                 boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.studio_receptionists%rowtype;
begin
  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_owner_practitioner_id
       and pr.studio_id = p_studio_id
       and pr.active
       and pr.role = 'owner'
  ) then
    return 'not_authorized';
  end if;
  if p_active is null then
    raise exception 'invalid_active' using errcode = '22004';
  end if;

  select * into v_row
    from public.studio_receptionists sr
   where sr.id = p_receptionist_id and sr.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.active = p_active then
    return 'no_change';
  end if;

  update public.studio_receptionists
     set active = p_active,
         deactivated_at = case when p_active then null else now() end
   where id = v_row.id;
  return 'updated';
end;
$$;

revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from public;
revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from anon;
revoke execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) from authenticated;
grant execute on function public.set_studio_receptionist_active(uuid, uuid, uuid, boolean) to service_role;

commit;
