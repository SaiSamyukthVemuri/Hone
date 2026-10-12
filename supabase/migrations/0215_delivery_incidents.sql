-- ===========================================================================
-- 0215 — DELIVERY INCIDENTS AND RECOVERY HEARTBEAT (DELIVERY-VISIBILITY-01, #824)
-- ===========================================================================
--
-- Operational failure visibility over BOTH delivery ledgers: 0206/0210's
-- sms_outbound_messages and 0212's email_outbound_messages. Four things, all
-- additive:
--
--   1. public.delivery_incidents -- ONE OPEN INCIDENT PER (studio, channel,
--      purpose, failure class). A failed attempt either opens one or adds to
--      the open one: occurrences, first and last seen, the latest attempt and
--      appointment, and the latest reason slug. A single outage that fails a
--      hundred reminders is one incident with a hundred occurrences, not a
--      hundred alerts. Resolution closes it; the next failure opens a new one.
--
--   2. Two AFTER UPDATE triggers, one per ledger, that open or extend an
--      incident in the SAME transaction as the status change that is the
--      failure. A failure recorded without its incident, or an incident
--      without its failure, cannot commit. Failure means a terminal or refused
--      outcome: email refused | bounced | failed | suppressed; SMS refused |
--      undelivered | failed. Retry-in-progress states (unknown, delayed,
--      accepted) are NOT incidents; they surface through the health read.
--
--   3. public.delivery_sweep_heartbeat (one row) and two service_role
--      commands: record_email_sweep_run (the recovery sweep reports each run)
--      and email_delivery_health (backlog, oldest pending receipt, quarantined
--      and unattributed receipts, accepted attempts with no report, open
--      incidents, last sweep). UNKNOWN is not false success: a missing sweep
--      reports a null last run, never a healthy one.
--
--   4. owner_delivery_incidents -- the studio OWNER'S read of their own
--      incidents (authenticated, owner of that studio, nothing else), and
--      resolve_delivery_incident -- platform support's close (service_role).
--
-- WHAT THIS IS NOT. No notification is sent and no ops alert is raised from
-- the database. No browser holds a table privilege; the owner read returns
-- operational metadata only: no client name, address, phone, message body or
-- clinical field. Nothing is backfilled. No existing function or grant changes;
-- the only existing objects touched are the two ledgers, each gaining one
-- AFTER trigger that writes nothing to the ledger itself.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Incidents
-- ---------------------------------------------------------------------------

create table if not exists public.delivery_incidents (
  id                    uuid primary key default gen_random_uuid(),
  studio_id             uuid not null references public.studios(id) on delete cascade,
  channel               text not null,
  purpose               text not null,
  failure_class         text not null,
  occurrences           integer not null default 1,
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  last_email_message_id uuid references public.email_outbound_messages(id) on delete set null,
  last_sms_message_id   uuid references public.sms_outbound_messages(id) on delete set null,
  -- Evidence of which appointment last failed, not a relational edge: no FK,
  -- so the record survives the appointment and adds no PostgREST relationship.
  last_appointment_id   uuid,
  last_reason           text,
  resolved_at           timestamptz,
  resolution            text,

  constraint delivery_incidents_channel_ck check (channel in ('email', 'sms')),
  constraint delivery_incidents_purpose_ck check (purpose ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint delivery_incidents_failure_class_ck check (failure_class in (
    'refused', 'bounced', 'failed', 'suppressed', 'undelivered'
  )),
  constraint delivery_incidents_class_per_channel_ck check (
    case channel
      when 'email' then failure_class in ('refused', 'bounced', 'failed', 'suppressed')
      else failure_class in ('refused', 'undelivered', 'failed')
    end
  ),
  constraint delivery_incidents_occurrences_ck check (occurrences >= 1),
  constraint delivery_incidents_seen_ck check (last_seen_at >= first_seen_at),
  constraint delivery_incidents_reason_ck check (
    last_reason is null or last_reason ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  constraint delivery_incidents_resolution_ck check (
    (resolved_at is null) = (resolution is null)
    and (resolution is null or resolution in ('fixed', 'acknowledged', 'not_actionable'))
  )
);

-- THE DEDUPLICATION RULE: at most one open incident per key.
create unique index if not exists delivery_incidents_one_open
  on public.delivery_incidents (studio_id, channel, purpose, failure_class)
  where resolved_at is null;

create index if not exists delivery_incidents_studio_seen_idx
  on public.delivery_incidents (studio_id, last_seen_at desc);

alter table public.delivery_incidents enable row level security;

-- No policies: owners read through owner_delivery_incidents, support through
-- service_role.

-- ---------------------------------------------------------------------------
-- 2. One trigger per ledger: the failure and its incident commit together
-- ---------------------------------------------------------------------------

create or replace function public.email_outbound_messages_open_incident()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.delivery_incidents as d
    (studio_id, channel, purpose, failure_class,
     last_email_message_id, last_appointment_id, last_reason)
  values
    (new.studio_id, 'email', new.purpose, new.status,
     new.id, new.appointment_id,
     coalesce(new.provider_reason, new.bounce_type, new.provider_error))
  on conflict (studio_id, channel, purpose, failure_class) where resolved_at is null
  do update set
    occurrences           = d.occurrences + 1,
    last_seen_at          = greatest(d.last_seen_at, now()),
    last_email_message_id = excluded.last_email_message_id,
    last_appointment_id   = excluded.last_appointment_id,
    last_reason           = coalesce(excluded.last_reason, d.last_reason);
  return null;
end;
$$;

drop trigger if exists email_outbound_messages_open_incident
  on public.email_outbound_messages;
create trigger email_outbound_messages_open_incident
  after update of status on public.email_outbound_messages
  for each row
  when (new.status is distinct from old.status
        and new.status in ('refused', 'bounced', 'failed', 'suppressed'))
  execute function public.email_outbound_messages_open_incident();

create or replace function public.sms_outbound_messages_open_incident()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into public.delivery_incidents as d
    (studio_id, channel, purpose, failure_class,
     last_sms_message_id, last_appointment_id, last_reason)
  values
    (new.studio_id, 'sms', new.purpose, new.status,
     new.id, new.appointment_id,
     case when new.provider_error_code is not null
          then 'twilio_' || new.provider_error_code::text end)
  on conflict (studio_id, channel, purpose, failure_class) where resolved_at is null
  do update set
    occurrences         = d.occurrences + 1,
    last_seen_at        = greatest(d.last_seen_at, now()),
    last_sms_message_id = excluded.last_sms_message_id,
    last_appointment_id = excluded.last_appointment_id,
    last_reason         = coalesce(excluded.last_reason, d.last_reason);
  return null;
end;
$$;

drop trigger if exists sms_outbound_messages_open_incident
  on public.sms_outbound_messages;
create trigger sms_outbound_messages_open_incident
  after update of status on public.sms_outbound_messages
  for each row
  when (new.status is distinct from old.status
        and new.status in ('refused', 'undelivered', 'failed'))
  execute function public.sms_outbound_messages_open_incident();

-- ---------------------------------------------------------------------------
-- 3. The recovery heartbeat and the health read
-- ---------------------------------------------------------------------------

create table if not exists public.delivery_sweep_heartbeat (
  singleton       boolean primary key default true,
  last_run_at     timestamptz not null,
  last_claimed    integer not null,
  last_processed  integer not null,
  last_failed     integer not null,
  constraint delivery_sweep_heartbeat_singleton_ck check (singleton),
  constraint delivery_sweep_heartbeat_counts_ck check (
    last_claimed >= 0 and last_processed >= 0 and last_failed >= 0
    and last_processed + last_failed <= last_claimed
  )
);

alter table public.delivery_sweep_heartbeat enable row level security;

create or replace function public.record_email_sweep_run(
  p_claimed   integer,
  p_processed integer,
  p_failed    integer
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if p_claimed is null or p_processed is null or p_failed is null
     or p_claimed < 0 or p_processed < 0 or p_failed < 0
     or p_processed + p_failed > p_claimed then
    return 'invalid_input';
  end if;

  insert into public.delivery_sweep_heartbeat as h
    (singleton, last_run_at, last_claimed, last_processed, last_failed)
  values (true, now(), p_claimed, p_processed, p_failed)
  on conflict (singleton) do update set
    last_run_at    = now(),
    last_claimed   = excluded.last_claimed,
    last_processed = excluded.last_processed,
    last_failed    = excluded.last_failed;

  return 'recorded';
end;
$$;

-- Accepted-but-silent uses the 24-hour floor of lib/delivery/status.ts.
create or replace function public.email_delivery_health()
returns table (
  pending_receipts        integer,
  oldest_pending_seconds  integer,
  exhausted_24h           integer,
  quarantined_24h         integer,
  unmatched_24h           integer,
  unreported_accepted     integer,
  open_incidents          integer,
  last_sweep_at           timestamptz,
  last_sweep_failed       integer
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    (select count(*)::integer from public.email_provider_events e
      where e.processing_state = 'pending'),
    (select extract(epoch from now() - min(e.received_at))::integer
       from public.email_provider_events e
      where e.processing_state = 'pending'),
    (select count(*)::integer from public.email_provider_events e
      where e.processing_result = 'processing_exhausted'
        and e.processed_at > now() - interval '24 hours'),
    (select count(*)::integer from public.email_provider_events e
      where e.processing_state = 'quarantined'
        and e.processed_at > now() - interval '24 hours'),
    (select count(*)::integer from public.email_provider_events e
      where e.processing_state = 'unmatched'
        and e.processed_at > now() - interval '24 hours'),
    (select count(*)::integer from public.email_outbound_messages m
      where m.status in ('accepted', 'sent')
        and coalesce(m.provider_status_at, m.settled_at, m.claimed_at) < now() - interval '24 hours'),
    (select count(*)::integer from public.delivery_incidents d
      where d.resolved_at is null),
    (select h.last_run_at from public.delivery_sweep_heartbeat h),
    (select h.last_failed from public.delivery_sweep_heartbeat h);
$$;

-- ---------------------------------------------------------------------------
-- 4. The owner's read and support's close
-- ---------------------------------------------------------------------------
--
-- owner_delivery_incidents: the signed-in OWNER of p_studio_id (active,
-- role 'owner', per is_studio_owner) reads that studio's open incidents and
-- those resolved in the last 14 days. Anyone else, including another studio's
-- owner, a practitioner or a receptionist, is refused with 42501. Operational
-- metadata only.

create or replace function public.owner_delivery_incidents(
  p_studio_id uuid
) returns table (
  incident_id         uuid,
  channel             text,
  purpose             text,
  failure_class       text,
  occurrences         integer,
  first_seen_at       timestamptz,
  last_seen_at        timestamptz,
  last_reason         text,
  last_appointment_id uuid,
  resolved_at         timestamptz,
  resolution          text
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
  select d.id, d.channel, d.purpose, d.failure_class, d.occurrences,
         d.first_seen_at, d.last_seen_at, d.last_reason, d.last_appointment_id,
         d.resolved_at, d.resolution
    from public.delivery_incidents d
   where d.studio_id = p_studio_id
     and (d.resolved_at is null or d.resolved_at > now() - interval '14 days')
   order by d.resolved_at is not null, d.last_seen_at desc
   limit 200;
end;
$$;

-- Results: resolved | already_resolved | not_found | invalid_input.
create or replace function public.resolve_delivery_incident(
  p_incident_id uuid,
  p_resolution  text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_resolved timestamptz;
begin
  if p_incident_id is null or p_resolution is null
     or p_resolution not in ('fixed', 'acknowledged', 'not_actionable') then
    return 'invalid_input';
  end if;

  select d.resolved_at into v_resolved
    from public.delivery_incidents d
   where d.id = p_incident_id
     for update;

  if not found then
    return 'not_found';
  end if;
  if v_resolved is not null then
    return 'already_resolved';
  end if;

  update public.delivery_incidents d
     set resolved_at = now(),
         resolution  = p_resolution
   where d.id = p_incident_id;

  return 'resolved';
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Revoked BY NAME from every default-granted role before anything is granted
-- (the 0129 / 0164 failure class).

revoke all on public.delivery_incidents
  from public, anon, authenticated, service_role;
revoke all on public.delivery_sweep_heartbeat
  from public, anon, authenticated, service_role;

revoke execute on function public.record_email_sweep_run(integer, integer, integer) from public;
revoke execute on function public.record_email_sweep_run(integer, integer, integer) from anon;
revoke execute on function public.record_email_sweep_run(integer, integer, integer) from authenticated;
revoke execute on function public.record_email_sweep_run(integer, integer, integer) from service_role;

revoke execute on function public.email_delivery_health() from public;
revoke execute on function public.email_delivery_health() from anon;
revoke execute on function public.email_delivery_health() from authenticated;
revoke execute on function public.email_delivery_health() from service_role;

revoke execute on function public.resolve_delivery_incident(uuid, text) from public;
revoke execute on function public.resolve_delivery_incident(uuid, text) from anon;
revoke execute on function public.resolve_delivery_incident(uuid, text) from authenticated;
revoke execute on function public.resolve_delivery_incident(uuid, text) from service_role;

revoke execute on function public.owner_delivery_incidents(uuid) from public;
revoke execute on function public.owner_delivery_incidents(uuid) from anon;
revoke execute on function public.owner_delivery_incidents(uuid) from authenticated;
revoke execute on function public.owner_delivery_incidents(uuid) from service_role;

grant execute on function public.record_email_sweep_run(integer, integer, integer) to service_role;
grant execute on function public.email_delivery_health() to service_role;
grant execute on function public.resolve_delivery_incident(uuid, text) to service_role;
grant execute on function public.owner_delivery_incidents(uuid) to authenticated;

revoke all privileges on function public.email_outbound_messages_open_incident()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.sms_outbound_messages_open_incident()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.delivery_incidents is
  'DELIVERY-VISIBILITY-01: one open incident per (studio, channel, purpose, failure class) over both delivery ledgers, opened or extended by an AFTER trigger in the same transaction as the failure. Operational metadata only. Read by owner_delivery_incidents (owner) and service_role; closed by resolve_delivery_incident (service_role). No browser grant and no RLS policy.';
comment on table public.delivery_sweep_heartbeat is
  'DELIVERY-VISIBILITY-01: the last run of the email delivery-event recovery sweep (record_email_sweep_run). A missing row means no sweep has ever run, which email_delivery_health reports as a null last run, never as healthy.';
comment on function public.owner_delivery_incidents(uuid) is
  'The signed-in owner of a studio reads its open incidents and those resolved in the last 14 days. Anyone else is refused with 42501. authenticated only.';
comment on function public.resolve_delivery_incident(uuid, text) is
  'Platform support closes an open incident as fixed | acknowledged | not_actionable. Returns resolved | already_resolved | not_found | invalid_input. service_role only.';
comment on function public.record_email_sweep_run(integer, integer, integer) is
  'The recovery sweep records one run: claimed, processed and failed receipts. Returns recorded | invalid_input. service_role only.';
comment on function public.email_delivery_health() is
  'One row of email delivery health: pending receipts and the oldest one''s age, receipts exhausted / quarantined / unattributed in 24 hours, accepted attempts with no report for 24 hours, open incidents and the last sweep. service_role only.';

commit;
