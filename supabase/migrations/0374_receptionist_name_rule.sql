-- The database no longer returns a client's stored name to a receptionist.
--
-- Replaces three read functions with the SAME signatures and the SAME return columns:
--   receptionist_client_directory, receptionist_calendar_v2 and receptionist_client_contacts_v2.
-- (Replaced bodies below: only the display, search and order expressions differ from the bodies they replace; every
-- guard, the intake and consent facts, the length and window checks and the caps are byte for byte the same.)
--
--   * DISPLAY is the preferred name, else the fixed words 'Name on file'. name_on_file is still true exactly when there
--     is no usable (non-blank) preferred name. The stored client name appears in no output column and no error text.
--   * SEARCH matches the preferred name, email and phone, and never the stored name. It does not match the fixed words,
--     so typing part of them finds nothing. The query minimum, the LIKE escaping and the page caps are unchanged.
--     Email often contains a name; 'Name on file' is a statement about the name column only, not about contact details.
--   * ORDER never uses the stored name: preferred name first (clients with one), then the rest, ties by id.
--   * The legal-name switch (studio_legal_name_access) is NOT consulted and is unchanged: these functions return no
--     stored name whether it is on or off. That switch still governs only client_legal_identities.
--
-- The other receptionist commands (create, move and cancel appointment, booking options, calendar closures, studio
-- timezone) return no client name and are not touched.
--
-- GUARDS IN THIS FILE: a preamble refuses to run unless each of the three functions still has exactly the body that is
-- on the hosted database (md5 of its source), is a security definer with search_path pg_catalog, pg_temp; a grants
-- check refuses to commit unless only `authenticated` may execute each of them (anon, service_role and PUBLIC may not);
-- an after-check records the md5 of each new body and refuses if the stored-name column is referenced.
-- Rollback: supabase/rollbacks/0374_receptionist_name_rule.down.sql (an emergency measure: it restores the old bodies).

begin;

set local lock_timeout = '5s';

-- 0) Preamble: the three bodies must be exactly the ones this change was reviewed against.
do $guard$
declare
  r record;
begin
  for r in
    select * from (values
      ('receptionist_client_directory', 'd2cb9ea68f5696213cc8bf98b4cd58a4'),
      ('receptionist_calendar_v2', 'e826a57397d3609874b6687cf659fc0d'),
      ('receptionist_client_contacts_v2', '116bad9455089d32ec7ee14310ed5a7b')
    ) as t(fname, expected_md5)
  loop
    if not exists (
      select 1 from pg_catalog.pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname = r.fname
         and pg_catalog.md5(p.prosrc) = r.expected_md5
         and p.prosecdef
         and p.proconfig = array['search_path=pg_catalog, pg_temp']
    ) then
      raise exception '0374 refuses to run: % is not the reviewed body', r.fname using errcode = '55000';
    end if;
  end loop;
end
$guard$;

-- receptionist_client_directory
create or replace function public.receptionist_client_directory(
  p_studio_id uuid,
  p_query     text    default null,
  p_filters   text[]  default null,
  p_sort      text    default 'name',
  p_offset    integer default 0,
  p_limit     integer default 25
)
returns table (
  client_id           uuid,
  display_name        text,
  name_on_file        boolean,
  phone               text,
  email               text,
  next_appointment_at timestamptz,
  last_visit_on       date,
  intake_state        text,
  consent_signed      boolean,
  total_count         bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_query   text    := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  v_sort    text    := coalesce(p_sort, 'name');
  v_filters text[]  := coalesce(p_filters, array[]::text[]);
  v_pattern text;
  v_tz      text;
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The studio's own clock (the definer reads it; the receptionist cannot). A missing or
  -- unusable zone falls back to UTC rather than failing the page.
  select coalesce(
           (select z.name from pg_catalog.pg_timezone_names z where z.name = s.timezone limit 1),
           'UTC')
    into v_tz
    from public.studios s
   where s.id = p_studio_id;
  v_tz := coalesce(v_tz, 'UTC');

  -- Closed sets: anything else is refused, never ignored.
  if v_sort not in ('name', 'next') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_filters) f where f is null or f not in ('intake_review', 'no_upcoming')
  ) then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;

  -- R2: a front desk finds a client, it does not export a list.
  if v_query is not null then
    if char_length(v_query) > 80 then
      raise exception 'query_too_long' using errcode = '22023';
    end if;
    if char_length(v_query) < 2 then
      raise exception 'query_too_short' using errcode = '22023';
    end if;
    -- Escape LIKE metacharacters so the search is literal.
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  elsif v_offset > 0 then
    raise exception 'query_required' using errcode = '22023';
  end if;
  if v_offset + v_limit > 200 then
    raise exception 'page_out_of_range' using errcode = '22023';
  end if;

  return query
    with base as (
      select c.id,
             coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file') as dname,
             nullif(pg_catalog.btrim(c.preferred_name), '')                          as pname,
             nullif(pg_catalog.btrim(c.preferred_name), '') is null           as on_file,
             c.phone as cphone,
             c.email as cemail
        from public.clients c
       where c.studio_id = p_studio_id
         and c.archived_at is null
    ),
    searched as (
      select b.*
        from base b
       where v_pattern is null
          or b.pname  ilike v_pattern
          or b.cemail ilike v_pattern
          or b.cphone ilike v_pattern
    ),
    facts as (
      select s.*,
             (select min(a.starts_at)
                from public.appointments a
               where a.studio_id = p_studio_id
                 and a.client_id = s.id
                 and a.status = 'confirmed'
                 and a.starts_at > pg_catalog.now())                            as nxt,
             (select max(a.starts_at)
                from public.appointments a
               where a.studio_id = p_studio_id
                 and a.client_id = s.id
                 and a.status = 'completed'
                 and a.starts_at <= pg_catalog.now())                           as lastv,
             -- Newest non-deleted form decides (the canonical rule); status only.
             (select f.status
                from public.client_intake_forms f
               where f.studio_id = p_studio_id
                 and f.client_id = s.id
                 and f.deleted_at is null
               order by f.created_at desc, f.id desc
               limit 1)                                                         as istatus,
             -- CURRENT treatment consent: the studio has at least one LIVE, ACTIVE
             -- treatment_consent template, and for EVERY such template the client's NEWEST
             -- signature is an acceptance of that template's CURRENT version. A superseded
             -- version, a later denial, or an archived template never reads as signed.
             (exists (
                select 1 from public.consent_form_templates t
                 where t.studio_id = p_studio_id
                   and t.form_type = 'treatment_consent'
                   and t.is_live and t.status = 'active')
              and not exists (
                select 1 from public.consent_form_templates t
                 where t.studio_id = p_studio_id
                   and t.form_type = 'treatment_consent'
                   and t.is_live and t.status = 'active'
                   and coalesce((select sg.response = 'accepted' and sg.template_version = t.version
                                   from public.client_consent_signatures sg
                                  where sg.studio_id = p_studio_id
                                    and sg.client_id = s.id
                                    and sg.template_id = t.id
                                  order by sg.signed_at desc, sg.id desc
                                  limit 1), false) is not true))                as consent
        from searched s
    ),
    shaped as (
      select f.id, f.dname, f.on_file, f.cphone, f.cemail, f.nxt,
             (f.lastv at time zone v_tz)::date as lastv_on,
             case f.istatus
               when 'submitted' then 'awaiting_review'
               when 'reviewed'  then 'reviewed'
               else 'not_submitted'
             end as intake,
             f.consent
        from facts f
    ),
    filtered as (
      select sh.*
        from shaped sh
       where ('intake_review' <> all (v_filters) or sh.intake = 'awaiting_review')
         and ('no_upcoming'   <> all (v_filters) or sh.nxt is null)
    )
    select fl.id, fl.dname, fl.on_file, fl.cphone, fl.cemail, fl.nxt, fl.lastv_on,
           fl.intake, fl.consent,
           pg_catalog.count(*) over ()
      from filtered fl
     order by
       case when v_sort = 'next' then (fl.nxt is null) end nulls last,
       case when v_sort = 'next' then fl.nxt end,
       fl.on_file,
       pg_catalog.lower(fl.dname),
       fl.id
     offset v_offset
     limit v_limit;
end;
$$;

-- receptionist_calendar_v2
create or replace function public.receptionist_calendar_v2(
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
  display_name              text,
  name_on_file              boolean,
  duration_minutes          integer,
  studio_timezone           text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_tz text;
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if public.receptionist_actor_id(p_studio_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Privacy C1 (PEER-0274-SQL): the studio's timezone, read for p_studio_id ONLY, validated
  -- against pg_timezone_names with a UTC fallback, returned as that one string.
  select coalesce(
           (select z.name from pg_catalog.pg_timezone_names z where z.name = s.timezone limit 1),
           'UTC')
    into v_tz
    from public.studios s
   where s.id = p_studio_id;
  v_tz := coalesce(v_tz, 'UTC');
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '93 days' then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  -- Fixed columns only. Appointment notes, prices, payment state, status reasons
  -- and every clinical field stay out (0216 section 2.1; R8).
  return query
    select a.id, a.starts_at, a.ends_at, a.status,
           a.practitioner_id, pr.display_name, pr.color,
           a.service_id, sv.name,
           a.client_id,
           coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file'),
           nullif(pg_catalog.btrim(c.preferred_name), '') is null,
           a.duration_minutes,
           v_tz
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

-- receptionist_client_contacts_v2
create or replace function public.receptionist_client_contacts_v2(
  p_studio_id uuid,
  p_query     text    default null,
  p_limit     integer default 25
)
returns table (
  client_id    uuid,
  display_name text,
  phone        text,
  email        text,
  name_on_file boolean
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
    v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select d.id, d.display_name, d.phone, d.email, d.name_on_file
      from (
        select c.id, c.phone, c.email,
               coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), 'Name on file') as display_name,
               nullif(pg_catalog.btrim(c.preferred_name), '') as pname,
               nullif(pg_catalog.btrim(c.preferred_name), '') is null as name_on_file
          from public.clients c
         where c.studio_id = p_studio_id
           and c.archived_at is null
      ) d
     where v_pattern is null
        or d.pname ilike v_pattern
        or d.email ilike v_pattern
        or d.phone ilike v_pattern
     order by d.name_on_file, d.display_name, d.id
     limit v_limit;
end;
$$;

comment on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) is
  '0374 desk directory: ONE page of active clients. The display name is the preferred name, else the fixed words Name on file (name_on_file true when there is no usable preferred name); the stored client name is never returned and never searched. Search matches the preferred name, email and phone. Same signature, columns, guards and caps as 0274.';

comment on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) is
  '0374 desk schedule: the display name is the preferred name, else the fixed words Name on file (name_on_file true when there is none); the stored client name is never returned. Same signature, columns and guards as 0274.';

comment on function public.receptionist_client_contacts_v2(uuid, text, integer) is
  '0374 receptionist client finder: the display name is the preferred name, else the fixed words Name on file; the stored client name is never returned and never searched. Search matches the preferred name, email and phone. Same signature, columns and guards as 0266.';

-- Grants are kept by create or replace; they are re-stated by name and then CHECKED. Supabase grants EXECUTE to anon,
-- authenticated and service_role at function-create time, so each role is revoked by name.
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from public;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from anon;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from service_role;
grant execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) to authenticated;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from service_role;
grant execute on function public.receptionist_client_contacts_v2(uuid, text, integer) to authenticated;

-- 1) After-check: grants, stored-name reference, and the md5 of each new body.
do $check$
declare
  r record;
  v_fn regprocedure;
begin
  for r in
    select * from (values
      ('receptionist_client_directory', 'public.receptionist_client_directory(uuid, text, text[], text, integer, integer)', '602bca224cc6ce50cab70c5692ea0902'),
      ('receptionist_calendar_v2', 'public.receptionist_calendar_v2(uuid, timestamptz, timestamptz)', '911df019f695523168b39fd6e43afbc7'),
      ('receptionist_client_contacts_v2', 'public.receptionist_client_contacts_v2(uuid, text, integer)', 'b157fca004345dddd4ad15586d92dc1d')
    ) as t(fname, sig, new_md5)
  loop
    v_fn := to_regprocedure(r.sig);
    if v_fn is null then
      raise exception '0374 check: % is missing', r.fname using errcode = '55000';
    end if;
    if not pg_catalog.has_function_privilege('authenticated', v_fn, 'execute') then
      raise exception '0374 check: authenticated cannot execute %', r.fname using errcode = '55000';
    end if;
    if pg_catalog.has_function_privilege('anon', v_fn, 'execute')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'execute') then
      raise exception '0374 check: anon or service_role can execute %', r.fname using errcode = '55000';
    end if;
    if exists (
      select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
       where p.oid = v_fn and a.grantee = 0
    ) then
      raise exception '0374 check: PUBLIC can execute %', r.fname using errcode = '55000';
    end if;
    if exists (
      select 1 from pg_catalog.pg_proc p
       where p.oid = v_fn and p.prosrc ~ '\mc\.name\M'
    ) then
      raise exception '0374 check: % still references the stored client name', r.fname using errcode = '55000';
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc p where p.oid = v_fn and pg_catalog.md5(p.prosrc) = r.new_md5
    ) then
      raise exception '0374 check: % is not the reviewed new body', r.fname using errcode = '55000';
    end if;
  end loop;
end
$check$;

commit;
