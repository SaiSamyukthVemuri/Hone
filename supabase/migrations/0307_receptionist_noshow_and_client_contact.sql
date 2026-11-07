-- 0307: front-desk commands from the Roles brief section C.4 (IG-2, IG-3). Additive: three new functions and one new table. Nothing
-- existing is changed. Number reserved for willow in 01-ops/MIGRATION-NUMBER-RESERVATIONS.md. If a lower reserved number is applied after
-- this one is sealed, renumber before sealing. authorizes_nothing.
--
-- What it does, and nothing else:
--   1. receptionist_mark_no_show (IG-2): the signed-in receptionist marks a confirmed, already-ended appointment of THEIR studio as a
--      no-show. Mirrors mark_appointment_no_show (0033:334) exactly: wrong_status unless confirmed, too_early until the end time has
--      passed, one status update and one appointment_audit row (actor_type 'receptionist'). No money row, no message.
--   2. receptionist_create_client (IG-3): creates a client with a name, an optional preferred name, phone and email.
--   3. receptionist_update_client_contact (IG-3): changes ONLY preferred_name, phone and email, and only when the caller's expected
--      current values still match (the 0281 save pattern). It can never touch the stored name, the legal identity, date of birth,
--      address, health or any other column.
--   4. receptionist_client_audit: who (the receptionist), which client, which action, which FIELD NAMES changed. No value, ever (the
--      0281 audit rule). Nobody can read it through the API yet: no grant, no policy; the audience is a separate decision (RQ4), and
--      the masked old/new audit on clients is the held 0290 design, which will need a 'receptionist' actor kind.
--
-- The actor is always receptionist_actor_id(p_studio_id) (0216), resolved from the JWT. It is never an argument. A caller who is not an
-- active receptionist of that studio (anon, service_role, owner, practitioner, another studio, deactivated) gets 42501.
-- NOT here: scheduling notes (waiting for the separate-field confirmation and a Privacy read), reassign or any other booking command,
-- archive, merge, import, any read of a client record.
begin;
set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.receptionist_actor_id(uuid)') is null
     or to_regclass('public.studio_receptionists') is null then
    raise exception '0307 requires 0216 (receptionist_actor_id); not applying' using errcode = '55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conname = 'appointment_audit_actor_receptionist_type_ck'
  ) then
    raise exception '0307 requires 0220 (receptionist audit actor); not applying' using errcode = '55000';
  end if;
end;
$$;

-- 1) The audit table. Append-only by construction: no role has insert, update or delete; the definer functions below write it.
create table public.receptionist_client_audit (
  id              uuid primary key default gen_random_uuid(),
  studio_id       uuid not null references public.studios(id) on delete cascade,
  client_id       uuid not null,
  receptionist_id uuid,
  action          text not null check (action in ('created', 'contact_updated')),
  fields          text[] not null default '{}'::text[],
  created_at      timestamptz not null default pg_catalog.now(),
  foreign key (client_id, studio_id) references public.clients(id, studio_id) on delete cascade,
  -- A removed receptionist must never be blocked by, or erase, the history they made (the 0258 / 0281 pointer rule).
  constraint receptionist_client_audit_receptionist_fk
    foreign key (receptionist_id) references public.studio_receptionists(id) on delete set null,
  constraint receptionist_client_audit_fields_ck
    check (fields <@ array['preferred_name', 'phone', 'email', 'name']::text[])
);
alter table public.receptionist_client_audit enable row level security;
revoke all on public.receptionist_client_audit from public, anon, authenticated, service_role;
comment on table public.receptionist_client_audit is
  '0307. One row per receptionist create or contact change: who, which client, which field NAMES. Never a value. No role can read or write it through the API; the reader audience is undecided (RQ4).';

-- 2) IG-2: mark no-show.
create or replace function public.receptionist_mark_no_show(
  p_studio_id      uuid,
  p_appointment_id uuid
) returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
  v_appt public.appointments%rowtype;
begin
  if v_desk is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform 1 from public.studio_receptionists sr
   where sr.id = v_desk and sr.studio_id = p_studio_id and sr.active
   for share;
  if not found then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_appt from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id
   for update;
  if not found or v_appt.status <> 'confirmed' then
    return 'wrong_status';
  end if;
  if v_appt.ends_at > pg_catalog.now() then
    return 'too_early';
  end if;

  update public.appointments set status = 'no_show', updated_at = pg_catalog.now() where id = p_appointment_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (p_appointment_id, 'receptionist', v_desk, 'marked_no_show',
          pg_catalog.jsonb_build_object('marked_at', pg_catalog.now(), 'source', 'receptionist_action'));
  return 'marked';
end;
$function$;

-- 3) IG-3: create a client.
create or replace function public.receptionist_create_client(
  p_studio_id      uuid,
  p_name           text,
  p_preferred_name text default null,
  p_phone          text default null,
  p_email          text default null
) returns table (outcome text, client_id uuid)
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk  uuid := public.receptionist_actor_id(p_studio_id);
  v_name  text := pg_catalog.btrim(coalesce(p_name, ''));
  v_pref  text := nullif(pg_catalog.btrim(coalesce(p_preferred_name, '')), '');
  v_phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(pg_catalog.btrim(coalesce(p_email, '')), '');
  v_id    uuid;
  v_fields text[] := array['name']::text[];
begin
  if v_desk is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform 1 from public.studio_receptionists sr
   where sr.id = v_desk and sr.studio_id = p_studio_id and sr.active
   for share;
  if not found then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_name = '' or pg_catalog.char_length(v_name) > 200 then
    return query select 'invalid_name'::text, null::uuid;
    return;
  end if;
  if v_pref is not null and pg_catalog.char_length(v_pref) > 200 then
    return query select 'invalid_preferred_name'::text, null::uuid;
    return;
  end if;
  if v_phone is not null and pg_catalog.char_length(v_phone) > 40 then
    return query select 'invalid_phone'::text, null::uuid;
    return;
  end if;
  if v_email is not null and (pg_catalog.char_length(v_email) > 254
       or v_email ~ '\s' or pg_catalog.strpos(v_email, '@') < 2
       or pg_catalog.strpos(v_email, '@') = pg_catalog.char_length(v_email)) then
    return query select 'invalid_email'::text, null::uuid;
    return;
  end if;

  begin
    insert into public.clients (studio_id, name, preferred_name, phone, email)
    values (p_studio_id, v_name, v_pref, v_phone, v_email)
    returning id into v_id;
  exception when unique_violation then
    -- The studio already has a client with this email. Say so, and nothing about who.
    return query select 'duplicate_email'::text, null::uuid;
    return;
  end;

  if v_pref is not null then v_fields := pg_catalog.array_append(v_fields, 'preferred_name'::text); end if;
  if v_phone is not null then v_fields := pg_catalog.array_append(v_fields, 'phone'::text); end if;
  if v_email is not null then v_fields := pg_catalog.array_append(v_fields, 'email'::text); end if;
  insert into public.receptionist_client_audit (studio_id, client_id, receptionist_id, action, fields)
  values (p_studio_id, v_id, v_desk, 'created', v_fields);

  return query select 'created'::text, v_id;
end;
$function$;

-- 4) IG-3: change preferred name, phone or email, only if the caller's expected current values still match.
create or replace function public.receptionist_update_client_contact(
  p_studio_id uuid,
  p_client_id uuid,
  p_patch     jsonb,
  p_expected  jsonb
) returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  c_keys constant text[] := array['preferred_name', 'phone', 'email']::text[];
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
  v_key  text;
  v_c    public.clients%rowtype;
  v_new  text;
  v_fields text[] := '{}'::text[];
  v_pref text;
  v_phone text;
  v_email text;
begin
  if v_desk is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform 1 from public.studio_receptionists sr
   where sr.id = v_desk and sr.studio_id = p_studio_id and sr.active
   for share;
  if not found then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_patch is null or pg_catalog.jsonb_typeof(p_patch) <> 'object'
     or p_expected is null or pg_catalog.jsonb_typeof(p_expected) <> 'object' or p_patch = '{}'::jsonb then
    raise exception 'receptionist_update_client_contact: patch and expected must be non-empty JSON objects' using errcode = '22023';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_patch) loop
    if not (v_key = any (c_keys)) then
      raise exception 'receptionist_update_client_contact: a receptionist may change only preferred_name, phone and email' using errcode = '22023';
    end if;
    if not (p_expected ? v_key) then
      raise exception 'receptionist_update_client_contact: a patched key has no expected value' using errcode = '22023';
    end if;
  end loop;
  for v_key in select pg_catalog.jsonb_object_keys(p_expected) loop
    if not (v_key = any (c_keys)) then
      raise exception 'receptionist_update_client_contact: unknown expected key' using errcode = '22023';
    end if;
  end loop;

  select * into v_c from public.clients c
   where c.id = p_client_id and c.studio_id = p_studio_id and c.archived_at is null
   for update;
  if not found then
    return 'not_found';
  end if;

  -- Stale check: every patched key's expected value must equal what is stored now.
  if (p_expected ? 'preferred_name' and v_c.preferred_name is distinct from (p_expected ->> 'preferred_name'))
     or (p_expected ? 'phone' and v_c.phone is distinct from (p_expected ->> 'phone'))
     or (p_expected ? 'email' and v_c.email is distinct from (p_expected ->> 'email')) then
    return 'stale';
  end if;

  v_pref := v_c.preferred_name;
  v_phone := v_c.phone;
  v_email := v_c.email;

  if p_patch ? 'preferred_name' then
    v_new := nullif(pg_catalog.btrim(coalesce(p_patch ->> 'preferred_name', '')), '');
    if v_new is not null and pg_catalog.char_length(v_new) > 200 then return 'invalid_preferred_name'; end if;
    if v_new is distinct from v_c.preferred_name then v_pref := v_new; v_fields := pg_catalog.array_append(v_fields, 'preferred_name'::text); end if;
  end if;
  if p_patch ? 'phone' then
    v_new := nullif(pg_catalog.btrim(coalesce(p_patch ->> 'phone', '')), '');
    if v_new is not null and pg_catalog.char_length(v_new) > 40 then return 'invalid_phone'; end if;
    if v_new is distinct from v_c.phone then v_phone := v_new; v_fields := pg_catalog.array_append(v_fields, 'phone'::text); end if;
  end if;
  if p_patch ? 'email' then
    v_new := nullif(pg_catalog.btrim(coalesce(p_patch ->> 'email', '')), '');
    if v_new is not null and (pg_catalog.char_length(v_new) > 254 or v_new ~ '\s'
         or pg_catalog.strpos(v_new, '@') < 2
         or pg_catalog.strpos(v_new, '@') = pg_catalog.char_length(v_new)) then
      return 'invalid_email';
    end if;
    if v_new is distinct from v_c.email then v_email := v_new; v_fields := pg_catalog.array_append(v_fields, 'email'::text); end if;
  end if;

  if pg_catalog.cardinality(v_fields) = 0 then
    return 'no_change';
  end if;

  begin
    update public.clients
       set preferred_name = v_pref, phone = v_phone, email = v_email
     where id = p_client_id and studio_id = p_studio_id;
  exception when unique_violation then
    return 'duplicate_email';
  end;

  insert into public.receptionist_client_audit (studio_id, client_id, receptionist_id, action, fields)
  values (p_studio_id, p_client_id, v_desk, 'contact_updated', v_fields);
  return 'updated';
end;
$function$;

-- Authenticated only, by name (CLAUDE.md: default privileges grant public, anon, authenticated and service_role).
revoke all on function public.receptionist_mark_no_show(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.receptionist_create_client(uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.receptionist_update_client_contact(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.receptionist_mark_no_show(uuid, uuid) to authenticated;
grant execute on function public.receptionist_create_client(uuid, text, text, text, text) to authenticated;
grant execute on function public.receptionist_update_client_contact(uuid, uuid, jsonb, jsonb) to authenticated;

comment on function public.receptionist_mark_no_show(uuid, uuid) is
  '0307 (IG-2). Receptionist marks a confirmed, ended appointment of their studio as no_show. 42501 for anyone who is not an active receptionist of the studio.';
comment on function public.receptionist_create_client(uuid, text, text, text, text) is
  '0307 (IG-3). Receptionist creates a client (name, optional preferred name, phone, email). Returns an outcome; duplicate_email names no one.';
comment on function public.receptionist_update_client_contact(uuid, uuid, jsonb, jsonb) is
  '0307 (IG-3). Receptionist changes preferred_name, phone or email only, when the expected current values still match. Never the stored name or any other column.';

commit;
