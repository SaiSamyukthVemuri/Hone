-- 0274: the receptionist DESK projection (restricted clients directory and the
-- display-identity schedule).
--
-- DRAFT, HELD, PREPARE-ONLY. Never applied or activated without Sam's per-change
-- approval; Privacy SQL review first, then Insurance. Reservation: OPS, 0274.
--
-- ORDERING (stated, and enforced below). This file depends on 0258 (the
-- clients.preferred_name column) and on 0266 (receptionist_client_contacts_v2,
-- which sets the display-identity rule for the desk and closes the v1 contacts
-- finder). It must NOT be applied before either. The preamble fails closed if
-- the column or the v2 function is missing, so an out-of-order apply stops here
-- and writes nothing.
--
-- WHAT IT ADDS (additive, one transaction):
--   1. receptionist_client_directory: ONE page of the active clients with the
--      display identity (preferred name, else the stored name flagged
--      name_on_file), permitted contact, next appointment, last visit (a DATE)
--      and two closed completion facts. Search, filters, sort and the total are
--      computed in the database over the whole studio set.
--   2. receptionist_calendar_v2: the schedule with the same display identity
--      (display_name, name_on_file) and no other client column. (Privacy R1)
--   3. v1 receptionist_calendar is CLOSED for authenticated, by privilege.
--
-- WHAT A RECEPTIONIST NEVER GETS, in a column, a filter or a join: clinical
-- records, session notes or any sessions row, treatment photos or portraits,
-- intake ANSWERS, consent text, date of birth, address, financial data, and
-- client_legal_identities / any legal_* column. The two functions below read
-- clients, appointments, services, practitioners, client_intake_forms (STATUS
-- only) and client_consent_signatures joined to consent_form_templates (a
-- boolean only). Nothing else.
--
-- PRIVACY CONDITIONS WRITTEN IN (privacy/RECEPTIONIST-DESIGN-REVIEW-END.json):
--   R1  receptionist_calendar_v2 carries display_name + name_on_file; v1 is
--       closed to every role but its owner (revoke by name, all four roles).
--   R2  no enumeration: a query of at least 2 characters is required for any
--       page after the first; an empty-query browse returns the first page
--       only; offset + limit is capped at 200.
--   R7  intake is a closed enum (not_submitted | awaiting_review | reviewed);
--       consent is a boolean for the studio's treatment_consent template only
--       (never photo, card, SMS or policy consent), no timestamp finer than a
--       date. A fact that cannot be read is NOT defaulted to a positive one.
--   R8  the schedule carries the service name (booking information); no
--       appointment notes, prices, payment state or status reasons.
-- D1-D3 (Insurance peer review of #1303): consent is CURRENT-version only, last visit is a
-- studio-local date from the studios.timezone the definer reads, and a too-long term is
-- refused with its own message (query_too_long).
-- R3 (ship dark), R4 (cross-studio), R5, R6 are application conditions and live
-- in the desk package, not in this file.
--
-- LAST VISIT. Privacy asked (Q2) for a definer that never reads sessions. This
-- draft therefore uses the COMPLETED-APPOINTMENTS source only: the newest
-- appointment with status completed and starts_at <= now(), returned as a date.
-- That is a NARROWER rule than the staff directory's R2 (which also counts a live
-- non-void session). Whether the desk's number may differ from the staff number
-- is Insurance's call; if the staff definition is required, it needs a single
-- max-date read of sessions, allowed by name, and Privacy's conditions on it.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0) Preamble: fail closed on a missing dependency.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'clients' and column_name = 'preferred_name'
  ) then
    raise exception '0274 requires 0258 (clients.preferred_name); not applying' using errcode = '55000';
  end if;
  if to_regprocedure('public.receptionist_client_contacts_v2(uuid, text, integer)') is null then
    raise exception '0274 requires 0266 (receptionist_client_contacts_v2); not applying' using errcode = '55000';
  end if;
  if to_regprocedure('public.receptionist_actor_id(uuid)') is null then
    raise exception '0274 requires 0216 (receptionist_actor_id); not applying' using errcode = '55000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1) The restricted directory.
-- ---------------------------------------------------------------------------
create function public.receptionist_client_directory(
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
             coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name) as dname,
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
          or b.dname  ilike v_pattern
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

revoke all on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer)
  from public, anon, authenticated, service_role;
-- Per-role statements as well: tests/security/clinical-rpc-grant-guard.test.ts pins these names.
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from public;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from anon;
revoke execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) from service_role;
grant execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) to authenticated;

comment on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) is
  '0274 desk directory: ONE page of active clients, display identity (preferred name else the stored name flagged name_on_file), phone, email, next appointment, last completed appointment as a studio-local date (completed appointments only; not the staff Last visit), intake enum and a boolean that is true only when the newest client signature on every live treatment-consent template accepts its current version. Active receptionist of the studio only. A query of 2+ characters is required for any page after the first; offset + limit is capped at 200. Never reads sessions, client_legal_identities, any legal_ column, intake answers or consent text.';

-- ---------------------------------------------------------------------------
-- 2) The schedule with the display identity (Privacy R1).
-- ---------------------------------------------------------------------------
create function public.receptionist_calendar_v2(
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
  name_on_file              boolean
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

  -- Fixed columns only. Appointment notes, prices, payment state, status reasons
  -- and every clinical field stay out (0216 section 2.1; R8).
  return query
    select a.id, a.starts_at, a.ends_at, a.status,
           a.practitioner_id, pr.display_name, pr.color,
           a.service_id, sv.name,
           a.client_id,
           coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name),
           nullif(pg_catalog.btrim(c.preferred_name), '') is null
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

revoke all on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) from service_role;
grant execute on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) to authenticated;

comment on function public.receptionist_calendar_v2(uuid, timestamptz, timestamptz) is
  '0274 desk schedule (Privacy R1): the display identity (preferred name else the stored name, name_on_file true when the stored name is shown) and the service name. No notes, prices, payment state, status reasons or clinical field. Active receptionist of the studio only.';

-- ---------------------------------------------------------------------------
-- 3) Close v1 for every role (Privacy R1), by privilege, source untouched.
-- ---------------------------------------------------------------------------
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from authenticated;
revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from service_role;

comment on function public.receptionist_calendar(uuid, timestamptz, timestamptz) is
  'CLOSED by 0274 (Privacy R1): no name_on_file flag. Use receptionist_calendar_v2.';

commit;
