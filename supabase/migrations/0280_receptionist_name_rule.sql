-- 0280: the receptionist name rule (Sam, 2 Nov): a receptionist sees the PREFERRED NAME, otherwise the words "Name on file".
-- The stored name (clients.name) may be the client's legal name; it must not reach a receptionist in a payload, a search, a sort or a count.
--
-- WHAT THIS CHANGES (fix-forward of the applied 0274; 0274 and 0266 are NOT edited):
--   1. receptionist_client_directory: display_name = the preferred name, else the literal 'Name on file'. name_on_file stays true
--      exactly when the label is shown. Search matches the preferred name, email and phone only (never the stored name); the sort
--      orders by the shown value, then id (all unlabelled clients tie, so order reveals nothing about stored names); total_count
--      follows the same matched set. Same signature, same columns, same grants.
--   2. receptionist_calendar_v2: the same display_name rule. Same signature and columns.
--   3. receptionist_client_contacts_v2 (0266) is CLOSED: no code calls it (the desk reads receptionist_client_directory), it carried
--      the stored name, and no test ever exercised it. Execute is revoked from authenticated, by name, and from the other roles.
--   4. receptionist_cancel_appointment (0220): the free-text reason is capped at 500 characters, the same cap as the staff
--      cancellation (manual-fee-actions CANCEL_REASON_MAX). Longer is refused with 22023 'reason_too_long'; NULL stays allowed.
-- NOTHING ELSE: no table, policy, trigger or other function changes. create or replace keeps each function's grants.
-- Applied OUT OF ORDER if hosted max is above 0280 (one sealed stage, --include-all); see the stage README.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regprocedure('public.receptionist_client_directory(uuid, text, text[], text, integer, integer)') is null
     or to_regprocedure('public.receptionist_calendar_v2(uuid, timestamptz, timestamptz)') is null
     or to_regprocedure('public.receptionist_cancel_appointment(uuid, uuid, text)') is null then
    raise exception '0280 requires 0220 and 0274; not applying' using errcode = '55000';
  end if;
end;
$$;

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
             nullif(pg_catalog.btrim(c.preferred_name), '') is null                  as on_file,
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
       pg_catalog.lower(fl.dname),
       fl.id
     offset v_offset
     limit v_limit;
end;
$$;

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

create or replace function public.receptionist_cancel_appointment(
  p_studio_id      uuid,
  p_appointment_id uuid,
  p_reason         text
)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_desk uuid := public.receptionist_actor_id(p_studio_id);
begin
  if v_desk is null then
    return 'not_authorized';
  end if;
  if p_reason is not null and pg_catalog.char_length(p_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  return public.cancel_appointment_core(
    'receptionist', p_appointment_id, p_studio_id, v_desk, p_reason);
end;
$function$;

comment on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) is
  '0280 desk directory: ONE page of active clients; display_name is the preferred name else the literal Name on file (name_on_file true), never the stored name; search, sort and count follow what is shown (plus email and phone); phone, email, next appointment, last completed appointment as a studio-local date, intake status, consent boolean. No other client field.';

comment on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) is
  '0280 desk schedule: display_name is the preferred name else the literal Name on file (name_on_file true), never the stored name; service name, duration and the studio zone; no notes, prices, payment state or status reasons.';

revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from public;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from anon;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from authenticated;
revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from service_role;

comment on function public.receptionist_client_contacts_v2(uuid, text, integer) is
  'CLOSED by 0280 (receptionist name rule): carried the stored name. Use receptionist_client_directory.';

commit;
