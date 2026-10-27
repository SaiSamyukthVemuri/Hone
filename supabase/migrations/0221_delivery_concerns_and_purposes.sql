-- ===========================================================================
-- 0221 — CANCELLATION AND POSTCARE EMAIL PURPOSES; OWNER-REPORTED DELIVERY
-- CONCERNS (DELIVERY-VISIBILITY-04, #824)
-- ===========================================================================
--
-- Number 0221 allocated by the DB/WAIT lane from a full census (2026-10-12),
-- PROVISIONAL until 0220 is on a ref; if 0220 is dropped this renumbers DOWN.
--
-- Two additive things:
--
--   1. Two more email ledger purposes, appointment_cancellation and
--      appointment_postcare, so the client cancellation notice and the
--      postcare email join email_outbound_messages (0212) like the reminder
--      and confirmation already do. 0212's purpose check and
--      begin_appointment_email_message are replaced whole with the wider list,
--      the way 0210 widened the SMS ledger. Every purpose is still about one
--      appointment, so the subject check is unchanged.
--
--   2. public.delivery_concerns -- "the client says they did not receive it",
--      reported by the studio OWNER for one appointment, channel and purpose.
--      A concern is its own auditable record, NOT a delivery fact:
--        * it records who reported it and when, on the server's clock;
--        * it snapshots what the ledger said at that moment (the latest
--          attempt's status, or `no_record`), so support can see "the
--          provider reported delivered, the client says not received";
--        * it never changes a ledger status, never infers receipt or
--          non-receipt (there are no open pixels anywhere in Hone), and
--          never resends anything;
--        * at most one OPEN concern per (appointment, channel, purpose);
--        * platform support closes it with a resolution; closing is final.
--
-- WHAT THIS IS NOT. No notification, no provider call, no free text from the
-- client or the owner, no recipient address. No browser table grant; owners
-- report and read through two owner-only commands, support through
-- service_role. No existing table other than email_outbound_messages is
-- altered (one check replaced). Nothing is backfilled.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Two more email ledger purposes
-- ---------------------------------------------------------------------------

alter table public.email_outbound_messages
  drop constraint email_outbound_messages_purpose_ck;
alter table public.email_outbound_messages
  add constraint email_outbound_messages_purpose_ck check (purpose in (
    'appointment_confirmation',
    'appointment_reminder_24h',
    'appointment_reminder_2h',
    'appointment_cancellation',
    'appointment_postcare'
  ));

create or replace function public.begin_appointment_email_message(
  p_studio_id      uuid,
  p_appointment_id uuid,
  p_purpose        text
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_studio_id is null or p_appointment_id is null
     or p_purpose is null
     or p_purpose not in ('appointment_confirmation',
                          'appointment_reminder_24h',
                          'appointment_reminder_2h',
                          'appointment_cancellation',
                          'appointment_postcare') then
    return null;
  end if;

  -- The appointment must belong to the studio named. The composite FK would
  -- refuse the insert anyway; checking first answers with null rather than an
  -- exception, so a caller's send is never broken by bookkeeping.
  if not exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id and a.studio_id = p_studio_id
  ) then
    return null;
  end if;

  insert into public.email_outbound_messages (studio_id, purpose, appointment_id)
  values (p_studio_id, p_purpose, p_appointment_id)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Owner-reported delivery concerns
-- ---------------------------------------------------------------------------

create table if not exists public.delivery_concerns (
  id                          uuid primary key default gen_random_uuid(),
  studio_id                   uuid not null references public.studios(id) on delete cascade,
  appointment_id              uuid not null,
  channel                     text not null,
  purpose                     text not null,
  -- What the ledger said when the concern was raised: the latest attempt for
  -- this appointment, channel and purpose. Evidence, frozen at report time.
  ledger_status_at_report     text not null,
  email_message_id            uuid references public.email_outbound_messages(id) on delete set null,
  sms_message_id              uuid references public.sms_outbound_messages(id) on delete set null,
  -- The reporting owner. Evidence of an actor, not a relational edge: no FK,
  -- so the record survives the practitioner row and adds no PostgREST path
  -- between practitioners and studios (the 0204 lesson).
  reported_by_practitioner_id uuid not null,
  reported_at                 timestamptz not null default now(),
  state                       text not null default 'open',
  resolution                  text,
  closed_at                   timestamptz,

  -- Tenancy by construction, as in 0206 and 0212.
  constraint delivery_concerns_appointment_same_studio_fk
    foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete cascade,

  constraint delivery_concerns_channel_ck check (channel in ('email', 'sms')),
  constraint delivery_concerns_purpose_ck check (
    case channel
      when 'email' then purpose in ('appointment_confirmation', 'appointment_reminder_24h',
                                    'appointment_reminder_2h', 'appointment_cancellation',
                                    'appointment_postcare')
      else purpose in ('appointment_confirmation', 'appointment_reminder_24h', 'appointment_reminder_2h')
    end
  ),
  constraint delivery_concerns_ledger_status_ck check (
    ledger_status_at_report ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  constraint delivery_concerns_message_per_channel_ck check (
    (email_message_id is null or channel = 'email')
    and (sms_message_id is null or channel = 'sms')
  ),
  constraint delivery_concerns_state_ck check (
    state in ('open', 'closed')
    and (state = 'closed') = (closed_at is not null)
    and (state = 'closed') = (resolution is not null)
    and (resolution is null or resolution in (
      'explained', 'resent_by_studio', 'provider_issue', 'not_actionable'
    ))
  )
);

create unique index if not exists delivery_concerns_one_open
  on public.delivery_concerns (appointment_id, channel, purpose)
  where state = 'open';

create index if not exists delivery_concerns_studio_reported_idx
  on public.delivery_concerns (studio_id, reported_at desc);

create or replace function public.delivery_concerns_server_defaults()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.reported_at := now();
  new.state       := 'open';
  new.resolution  := null;
  new.closed_at   := null;
  return new;
end;
$$;

drop trigger if exists delivery_concerns_server_defaults on public.delivery_concerns;
create trigger delivery_concerns_server_defaults
  before insert on public.delivery_concerns
  for each row execute function public.delivery_concerns_server_defaults();

create or replace function public.delivery_concerns_identity_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- What was reported, by whom, when, and what the ledger said then never
  -- change. A closed concern stays closed with its resolution.
  if new.studio_id is distinct from old.studio_id
     or new.appointment_id is distinct from old.appointment_id
     or new.channel is distinct from old.channel
     or new.purpose is distinct from old.purpose
     or new.ledger_status_at_report is distinct from old.ledger_status_at_report
     or new.reported_by_practitioner_id is distinct from old.reported_by_practitioner_id
     or new.reported_at is distinct from old.reported_at
     or (old.email_message_id is not null and new.email_message_id is distinct from old.email_message_id
         and new.email_message_id is not null)
     or (old.sms_message_id is not null and new.sms_message_id is distinct from old.sms_message_id
         and new.sms_message_id is not null)
     or (old.state = 'closed'
         and (new.state is distinct from old.state
              or new.resolution is distinct from old.resolution
              or new.closed_at is distinct from old.closed_at))
  then
    raise exception 'delivery_concerns record is write-once' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists delivery_concerns_identity_guard on public.delivery_concerns;
create trigger delivery_concerns_identity_guard
  before update on public.delivery_concerns
  for each row execute function public.delivery_concerns_identity_guard();

alter table public.delivery_concerns enable row level security;

-- No policies: owners report and read through the two owner commands below,
-- support through service_role.

-- report_delivery_concern: the signed-in OWNER of p_studio_id records that a
-- client says they did not receive one message about one appointment.
-- Results: reported | already_open | not_found | invalid_input. Anyone who is
-- not that studio's owner is refused with 42501.

create or replace function public.report_delivery_concern(
  p_studio_id      uuid,
  p_appointment_id uuid,
  p_channel        text,
  p_purpose        text
) returns table (
  result         text,
  concern_id     uuid,
  ledger_status  text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_reporter uuid;
  v_status   text;
  v_email    uuid;
  v_sms      uuid;
  v_id       uuid;
begin
  if auth.uid() is null
     or p_studio_id is null
     or not public.is_studio_owner(p_studio_id) then
    raise exception 'not the owner of this studio' using errcode = '42501';
  end if;

  if p_appointment_id is null or p_channel is null or p_purpose is null
     or p_channel not in ('email', 'sms')
     or (p_channel = 'email' and p_purpose not in (
           'appointment_confirmation', 'appointment_reminder_24h', 'appointment_reminder_2h',
           'appointment_cancellation', 'appointment_postcare'))
     or (p_channel = 'sms' and p_purpose not in (
           'appointment_confirmation', 'appointment_reminder_24h', 'appointment_reminder_2h')) then
    return query select 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  if not exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id and a.studio_id = p_studio_id
  ) then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  select p.id into v_reporter
    from public.practitioners p
   where p.studio_id = p_studio_id
     and p.user_id = auth.uid()
     and p.active
     and p.role = 'owner'
   limit 1;

  -- The latest attempt the ledger holds for this appointment, channel and
  -- purpose, and what it said. `no_record` when there is none: the message may
  -- predate the ledger, or never have been attempted.
  if p_channel = 'email' then
    select m.id, m.status into v_email, v_status
      from public.email_outbound_messages m
     where m.appointment_id = p_appointment_id
       and m.studio_id = p_studio_id
       and m.purpose = p_purpose
     order by m.claimed_at desc
     limit 1;
  else
    select m.id, m.status into v_sms, v_status
      from public.sms_outbound_messages m
     where m.appointment_id = p_appointment_id
       and m.studio_id = p_studio_id
       and m.purpose = p_purpose
     order by m.claimed_at desc
     limit 1;
  end if;

  insert into public.delivery_concerns
    (studio_id, appointment_id, channel, purpose, ledger_status_at_report,
     email_message_id, sms_message_id, reported_by_practitioner_id)
  values
    (p_studio_id, p_appointment_id, p_channel, p_purpose, coalesce(v_status, 'no_record'),
     v_email, v_sms, v_reporter)
  on conflict (appointment_id, channel, purpose) where state = 'open' do nothing
  returning id into v_id;

  if v_id is null then
    select c.id, c.ledger_status_at_report into v_id, v_status
      from public.delivery_concerns c
     where c.appointment_id = p_appointment_id
       and c.channel = p_channel
       and c.purpose = p_purpose
       and c.state = 'open';
    return query select 'already_open'::text, v_id, v_status;
    return;
  end if;

  return query select 'reported'::text, v_id, coalesce(v_status, 'no_record');
end;
$$;

-- owner_delivery_concerns: the owner's own studio's concerns, open first, and
-- those closed in the last 30 days. Anyone else: 42501.
create or replace function public.owner_delivery_concerns(
  p_studio_id uuid
) returns table (
  concern_id              uuid,
  appointment_id          uuid,
  channel                 text,
  purpose                 text,
  ledger_status_at_report text,
  reported_at             timestamptz,
  state                   text,
  resolution              text,
  closed_at               timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null
     or p_studio_id is null
     or not public.is_studio_owner(p_studio_id) then
    raise exception 'not the owner of this studio' using errcode = '42501';
  end if;

  return query
  select c.id, c.appointment_id, c.channel, c.purpose, c.ledger_status_at_report,
         c.reported_at, c.state, c.resolution, c.closed_at
    from public.delivery_concerns c
   where c.studio_id = p_studio_id
     and (c.state = 'open' or c.closed_at > now() - interval '30 days')
   order by c.state = 'closed', c.reported_at desc
   limit 200;
end;
$$;

-- support_delivery_concerns: platform support's cross-studio list.
create or replace function public.support_delivery_concerns(
  p_include_closed boolean
) returns table (
  concern_id              uuid,
  studio_id               uuid,
  studio_name             text,
  appointment_id          uuid,
  channel                 text,
  purpose                 text,
  ledger_status_at_report text,
  current_ledger_status   text,
  reported_at             timestamptz,
  state                   text,
  resolution              text,
  closed_at               timestamptz
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select c.id, c.studio_id, s.name, c.appointment_id, c.channel, c.purpose,
         c.ledger_status_at_report,
         coalesce(e.status, m.status),
         c.reported_at, c.state, c.resolution, c.closed_at
    from public.delivery_concerns c
    join public.studios s on s.id = c.studio_id
    left join public.email_outbound_messages e on e.id = c.email_message_id
    left join public.sms_outbound_messages m on m.id = c.sms_message_id
   where c.state = 'open'
      or (coalesce(p_include_closed, false) and c.closed_at > now() - interval '30 days')
   order by c.state = 'closed', c.reported_at desc
   limit 300;
$$;

-- close_delivery_concern: support closes an open concern. Results: closed |
-- already_closed | not_found | invalid_input.
create or replace function public.close_delivery_concern(
  p_concern_id uuid,
  p_resolution text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_state text;
begin
  if p_concern_id is null or p_resolution is null
     or p_resolution not in ('explained', 'resent_by_studio', 'provider_issue', 'not_actionable') then
    return 'invalid_input';
  end if;

  select c.state into v_state
    from public.delivery_concerns c
   where c.id = p_concern_id
     for update;

  if not found then
    return 'not_found';
  end if;
  if v_state = 'closed' then
    return 'already_closed';
  end if;

  update public.delivery_concerns c
     set state = 'closed', resolution = p_resolution, closed_at = now()
   where c.id = p_concern_id;

  return 'closed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on public.delivery_concerns
  from public, anon, authenticated, service_role;

revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from public;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from anon;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from authenticated;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from service_role;

revoke execute on function public.report_delivery_concern(uuid, uuid, text, text) from public;
revoke execute on function public.report_delivery_concern(uuid, uuid, text, text) from anon;
revoke execute on function public.report_delivery_concern(uuid, uuid, text, text) from authenticated;
revoke execute on function public.report_delivery_concern(uuid, uuid, text, text) from service_role;

revoke execute on function public.owner_delivery_concerns(uuid) from public;
revoke execute on function public.owner_delivery_concerns(uuid) from anon;
revoke execute on function public.owner_delivery_concerns(uuid) from authenticated;
revoke execute on function public.owner_delivery_concerns(uuid) from service_role;

revoke execute on function public.support_delivery_concerns(boolean) from public;
revoke execute on function public.support_delivery_concerns(boolean) from anon;
revoke execute on function public.support_delivery_concerns(boolean) from authenticated;
revoke execute on function public.support_delivery_concerns(boolean) from service_role;

revoke execute on function public.close_delivery_concern(uuid, text) from public;
revoke execute on function public.close_delivery_concern(uuid, text) from anon;
revoke execute on function public.close_delivery_concern(uuid, text) from authenticated;
revoke execute on function public.close_delivery_concern(uuid, text) from service_role;

grant execute on function public.begin_appointment_email_message(uuid, uuid, text) to service_role;
grant execute on function public.report_delivery_concern(uuid, uuid, text, text) to authenticated;
grant execute on function public.owner_delivery_concerns(uuid) to authenticated;
grant execute on function public.support_delivery_concerns(boolean) to service_role;
grant execute on function public.close_delivery_concern(uuid, text) to service_role;

revoke all privileges on function public.delivery_concerns_server_defaults()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.delivery_concerns_identity_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.delivery_concerns is
  'DELIVERY-VISIBILITY-04: an owner-reported "client says they did not receive it" for one appointment, channel and purpose. Records the reporting owner, the server time and what the ledger said then; never changes a ledger status or infers receipt. At most one open concern per appointment, channel and purpose; support closes it. No browser grant and no RLS policy.';
comment on function public.report_delivery_concern(uuid, uuid, text, text) is
  'The owner of a studio records a delivery concern for one of its appointments. Returns (result, concern_id, ledger_status) with result reported | already_open | not_found | invalid_input; anyone else is refused with 42501. authenticated only.';
comment on function public.owner_delivery_concerns(uuid) is
  'The owner reads their studio''s open concerns and those closed in the last 30 days. Anyone else: 42501. authenticated only.';
comment on function public.support_delivery_concerns(boolean) is
  'Platform support''s cross-studio concern list with the studio name, the ledger status at report time and now. service_role only.';
comment on function public.close_delivery_concern(uuid, text) is
  'Platform support closes an open concern as explained | resent_by_studio | provider_issue | not_actionable. Returns closed | already_closed | not_found | invalid_input. service_role only.';

commit;
