-- #846 / 4310399068: partial retained-failure appointment projection.
-- No history reconstruction: current retained ledger status is the evidence.
-- Return-shape replacement is atomic; existing authenticated-only ACL restored.
begin;
set local lock_timeout = '5s';
drop function public.owner_delivery_incidents(uuid) restrict;
create function public.owner_delivery_incidents(p_studio_id uuid)
returns table (
  incident_id uuid, channel text, purpose text, failure_class text,
  occurrences integer, first_seen_at timestamptz, last_seen_at timestamptz,
  last_reason text, last_appointment_id uuid, resolved_at timestamptz,
  resolution text, retained_failed_appointments jsonb
)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null or p_studio_id is null
     or not public.is_studio_owner(p_studio_id) then
    raise exception 'not the owner of this studio' using errcode = '42501';
  end if;
  return query
  with visible_incidents as materialized (
    select d.* from public.delivery_incidents d
    where d.studio_id = p_studio_id
      and (d.resolved_at is null or d.resolved_at > now() - interval '14 days')
    order by d.resolved_at is not null, d.last_seen_at desc
    limit 200
  ), matching_attempts as (
    select d.id as incident_id, m.id as message_id, m.appointment_id,
           m.claimed_at, coalesce(m.provider_reason, m.bounce_type, m.provider_error) as reason
    from visible_incidents d
    join public.email_outbound_messages m on m.studio_id = d.studio_id
      and m.purpose = d.purpose and m.status = d.failure_class
    join public.appointments a on a.id = m.appointment_id and a.studio_id = d.studio_id
    where d.channel = 'email' and d.resolved_at is null
    union all
    select d.id, m.id, m.appointment_id, m.claimed_at,
           case when m.provider_error_code is not null
             then 'twilio_' || m.provider_error_code::text end
    from visible_incidents d
    join public.sms_outbound_messages m on m.studio_id = d.studio_id
      and m.purpose = d.purpose and m.status = d.failure_class
    join public.appointments a on a.id = m.appointment_id and a.studio_id = d.studio_id
    where d.channel = 'sms' and d.resolved_at is null
  ), distinct_appointments as (
    -- Latest still-retained matching failure attempt per appointment/open message group.
    -- This is not evidence of exact historical incident membership.
    select distinct on (m.incident_id, m.appointment_id) m.*
    from matching_attempts m
    order by m.incident_id, m.appointment_id, m.claimed_at desc, m.message_id desc
  ), bounded_appointments as (
    -- A global bound across open groups, not 200 links per incident.
    -- Newest selected latest-attempt evidence first; resolved groups have no links.
    select m.* from distinct_appointments m
    order by m.claimed_at desc, m.message_id desc, m.incident_id desc
    limit 200
  ), projections as (
    select m.incident_id,
      jsonb_agg(jsonb_build_object('appointment_id', m.appointment_id,
        'last_reason', m.reason, 'claimed_at', m.claimed_at)
        order by m.claimed_at desc, m.message_id desc) as appointments
    from bounded_appointments m group by m.incident_id
  )
  select d.id, d.channel, d.purpose, d.failure_class, d.occurrences,
    d.first_seen_at, d.last_seen_at, d.last_reason, d.last_appointment_id,
    d.resolved_at, d.resolution, coalesce(p.appointments, '[]'::jsonb)
  from visible_incidents d left join projections p on p.incident_id = d.id
  order by d.resolved_at is not null, d.last_seen_at desc;
end;
$$;
revoke all on function public.owner_delivery_incidents(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_delivery_incidents(uuid) to authenticated;
commit;
