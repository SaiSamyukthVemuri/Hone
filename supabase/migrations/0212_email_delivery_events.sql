-- ===========================================================================
-- 0212 — EMAIL DELIVERY EVENTS (DELIVERY-EVENTS-01, #824)
-- ===========================================================================
--
-- Provider-reported delivery truth for email: the counterpart of 0206 for
-- SMS. Hone sends email through ONE Resend path (sendEmailSafely in
-- lib/email/send-appointment.ts). This migration adds what that path has never
-- had: a record of each attempt that Resend's signed delivery webhooks can
-- land on. Three things, all additive:
--
--   1. public.email_outbound_messages -- ONE ROW PER OUTBOUND EMAIL ATTEMPT,
--      shaped like 0206's sms_outbound_messages. It is claimed BEFORE the
--      provider is called, settled with what the provider answered, and
--      advanced by signed delivery events. It holds no recipient address, no
--      subject and no body: purpose, subject, status, the provider email id
--      and normalised reason slugs, nothing else.
--
--   2. public.email_provider_events -- ONE ROW PER SIGNED WEBHOOK DELIVERY. It
--      is written BEFORE the route acknowledges the delivery, deduplicated on
--      the provider's delivery id (svix-id, which Resend keeps across every
--      retry of one event), and processed exactly once, in its own transaction.
--      A receipt whose processing never finished is found again by the claim
--      sweep; one that keeps failing is quarantined after a bounded number of
--      attempts instead of being retried forever.
--
--   3. Five service_role-only commands, the tables' ONLY writers:
--        begin_appointment_email_message  create the ledger row for an attempt
--        settle_email_message             record what the provider answered
--        record_email_provider_event      the durable receipt
--        claim_email_provider_events      take receipts to process (bounded)
--        process_email_provider_event     apply one receipt, exactly once
--
-- WHAT THIS IS NOT. It is not a sender: nothing here calls a provider, and no
-- send path calls these commands yet. The tables stay empty until a producer
-- slice wires one in. It raises no alert and sends no notification. Neither
-- table has a policy or a grant, so no browser session reads them; the studio
-- view of delivery failures is a later, reviewed projection. There is no
-- trigger on any existing table, and no change to the email claim pairs
-- (0028/0080), the SMS ledger (0206/0210) or any existing grant. Nothing is
-- backfilled.
--
-- ATTRIBUTION. A receipt reaches a studio ONLY through the ledger row it
-- matched, never through anything in the payload. The row is addressed by the
-- `hone_m` tag Hone attaches to the send (the ledger row id, carried inside
-- Resend's signed payload) or else by the provider email id. A receipt that
-- matches nothing keeps email_message_id NULL and so stays platform-only by
-- construction. Examples: an untracked send, another deployment sharing the
-- Resend account, or an id that contradicts the row it names.
--
-- ORDER. Resend does not promise delivery order, and retries interleave.
-- Statuses move forward only (claimed/unknown < accepted < sent <
-- delivery_delayed < delivered < bounced | failed | suppressed), so the end
-- state does not depend on the order in which events arrive. A complaint
-- records complained_at and implies delivery. Opens and clicks are not
-- delivery facts and never change a status.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------

create table if not exists public.email_outbound_messages (
  id                 uuid primary key default gen_random_uuid(),
  studio_id          uuid not null references public.studios(id) on delete cascade,
  purpose            text not null,
  appointment_id     uuid,
  status             text not null default 'claimed',
  skip_reason        text,
  provider_email_id  text,
  provider_error     text,
  bounce_type        text,
  provider_reason    text,
  complained_at      timestamptz,
  claimed_at         timestamptz not null default now(),
  settled_at         timestamptz,
  provider_status_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Tenancy by construction: an appointment row can only be referenced
  -- together with the studio that owns it.
  constraint email_outbound_messages_appointment_same_studio_fk
    foreign key (appointment_id, studio_id)
    references public.appointments (id, studio_id) on delete cascade,

  constraint email_outbound_messages_purpose_ck check (purpose in (
    'appointment_confirmation',
    'appointment_reminder_24h',
    'appointment_reminder_2h'
  )),

  -- Every purpose so far is about one appointment. A later purpose with a
  -- different subject replaces this check, as 0210 did for the SMS ledger.
  constraint email_outbound_messages_subject_ck check (appointment_id is not null),

  constraint email_outbound_messages_status_ck check (status in (
    -- Hone's own lifecycle.
    'claimed', 'skipped', 'refused', 'unknown', 'accepted',
    -- Resend's delivery lifecycle, as normalised by process_email_provider_event.
    'sent', 'delivery_delayed', 'delivered', 'bounced', 'failed', 'suppressed'
  )),

  -- A skip carries a reason and nothing else does. A slug from a closed
  -- application vocabulary; the shape check makes it impossible to park an
  -- address or a provider message here.
  constraint email_outbound_messages_skip_reason_ck check (
    (status = 'skipped') = (skip_reason is not null)
    and (skip_reason is null or skip_reason ~ '^[a-z][a-z0-9_]{2,63}$')
  ),

  constraint email_outbound_messages_email_id_shape_ck check (
    provider_email_id is null
    or provider_email_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),

  -- Every state that means "the provider has this message" names it.
  constraint email_outbound_messages_email_id_when_reached_ck check (
    status not in ('accepted', 'sent', 'delivery_delayed', 'delivered',
                   'bounced', 'failed', 'suppressed')
    or provider_email_id is not null
  ),

  -- Slugs only: the provider's free-text messages (a bounce message can quote
  -- the recipient's address) are never stored.
  constraint email_outbound_messages_provider_error_ck check (
    provider_error is null or provider_error ~ '^[a-z][a-z0-9_]{1,63}$'
  ),
  constraint email_outbound_messages_bounce_type_ck check (
    bounce_type is null
    or (status = 'bounced' and bounce_type ~ '^[a-z][a-z0-9_]{1,63}$')
  ),
  constraint email_outbound_messages_provider_reason_ck check (
    provider_reason is null
    or (status in ('bounced', 'failed', 'suppressed')
        and provider_reason ~ '^[a-z][a-z0-9_]{1,63}$')
  ),

  -- A complaint is a report about a message the provider has.
  constraint email_outbound_messages_complaint_ck check (
    complained_at is null or provider_email_id is not null
  )
);

create unique index if not exists email_outbound_messages_provider_email_id_unique
  on public.email_outbound_messages (provider_email_id)
  where provider_email_id is not null;

create index if not exists email_outbound_messages_appointment_idx
  on public.email_outbound_messages (appointment_id)
  where appointment_id is not null;

create index if not exists email_outbound_messages_studio_created_idx
  on public.email_outbound_messages (studio_id, created_at);

create or replace function public.email_outbound_messages_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.claimed_at := now();
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists email_outbound_messages_server_timestamps
  on public.email_outbound_messages;
create trigger email_outbound_messages_server_timestamps
  before insert on public.email_outbound_messages
  for each row execute function public.email_outbound_messages_server_timestamps();

create or replace function public.email_outbound_messages_identity_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- What an attempt IS never changes: its studio, purpose, subject and claim
  -- instant. A provider email id, once written, is the attempt's identity on
  -- the provider's side; overwriting it would point later events at a
  -- different message. A complaint, once recorded, stays recorded.
  if new.studio_id is distinct from old.studio_id
     or new.purpose is distinct from old.purpose
     or new.appointment_id is distinct from old.appointment_id
     or new.claimed_at is distinct from old.claimed_at
     or new.created_at is distinct from old.created_at
     or (old.provider_email_id is not null
         and new.provider_email_id is distinct from old.provider_email_id)
     or (old.complained_at is not null
         and new.complained_at is distinct from old.complained_at)
  then
    raise exception 'email_outbound_messages identity is write-once'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists email_outbound_messages_identity_guard
  on public.email_outbound_messages;
create trigger email_outbound_messages_identity_guard
  before update on public.email_outbound_messages
  for each row execute function public.email_outbound_messages_identity_guard();

alter table public.email_outbound_messages enable row level security;

-- No policies: no browser session reads or writes this table.

-- ---------------------------------------------------------------------------
-- 2. The receipts
-- ---------------------------------------------------------------------------

create table if not exists public.email_provider_events (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null default 'resend',
  -- The webhook delivery id (svix-id). Resend keeps it across every retry of
  -- one event, so it is the deduplication key.
  provider_event_id     text not null,
  event_type            text not null,
  provider_email_id     text,
  -- The `hone_m` tag as the provider reported it. Deliberately NOT a foreign
  -- key: it can name a row this database never had (another deployment
  -- sharing the account), and it is evidence of what was claimed, not a link.
  hone_message_id       uuid,
  provider_created_at   timestamptz,
  bounce_type           text,
  bounce_subtype        text,
  failure_reason        text,
  suppression_type      text,
  received_at           timestamptz not null default now(),
  processing_state      text not null default 'pending',
  processing_result     text,
  processing_attempts   integer not null default 0,
  processing_claimed_at timestamptz,
  processed_at          timestamptz,
  -- The ledger row this receipt was applied to. Set only for `applied` and
  -- `stale`; every other state leaves it NULL, so an unmatched or quarantined
  -- receipt is attributable to no studio.
  email_message_id      uuid references public.email_outbound_messages(id) on delete cascade,

  constraint email_provider_events_provider_ck check (provider = 'resend'),

  constraint email_provider_events_event_id_shape_ck check (
    provider_event_id ~ '^[A-Za-z0-9_.:-]{1,128}$'
  ),

  -- The type is kept as the provider sent it (bounded and shape-checked, not
  -- a closed list): a type Resend adds later must still be RECORDED, and then
  -- quarantined, rather than refused into a retry loop.
  constraint email_provider_events_type_shape_ck check (
    event_type ~ '^[a-z][a-z0-9_.]{1,63}$'
  ),

  constraint email_provider_events_email_id_shape_ck check (
    provider_email_id is null
    or provider_email_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),

  constraint email_provider_events_reason_slugs_ck check (
    (bounce_type is null or bounce_type ~ '^[a-z][a-z0-9_]{1,63}$')
    and (bounce_subtype is null or bounce_subtype ~ '^[a-z][a-z0-9_]{1,63}$')
    and (failure_reason is null or failure_reason ~ '^[a-z][a-z0-9_]{1,63}$')
    and (suppression_type is null or suppression_type ~ '^[a-z][a-z0-9_]{1,63}$')
  ),

  constraint email_provider_events_state_ck check (processing_state in (
    'pending', 'applied', 'stale', 'unmatched', 'ignored', 'quarantined'
  )),

  -- A pending receipt has no outcome yet; a processed one always has one.
  constraint email_provider_events_outcome_ck check (
    (processing_state = 'pending') = (processed_at is null)
    and (processing_state = 'pending') = (processing_result is null)
    and (processing_result is null or processing_result ~ '^[a-z][a-z0-9_]{1,63}$')
  ),

  constraint email_provider_events_attribution_ck check (
    (processing_state in ('applied', 'stale')) = (email_message_id is not null)
  ),

  constraint email_provider_events_attempts_ck check (
    processing_attempts between 0 and 1000
  )
);

create unique index if not exists email_provider_events_delivery_unique
  on public.email_provider_events (provider, provider_event_id);

create index if not exists email_provider_events_pending_idx
  on public.email_provider_events (received_at)
  where processing_state = 'pending';

create index if not exists email_provider_events_message_idx
  on public.email_provider_events (email_message_id)
  where email_message_id is not null;

create index if not exists email_provider_events_email_id_idx
  on public.email_provider_events (provider_email_id)
  where provider_email_id is not null;

create or replace function public.email_provider_events_server_defaults()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- A receipt always starts unprocessed, with the server's clock, whatever
  -- the inserting statement supplied.
  new.received_at           := now();
  new.processing_state      := 'pending';
  new.processing_result     := null;
  new.processing_attempts   := 0;
  new.processing_claimed_at := null;
  new.processed_at          := null;
  new.email_message_id      := null;
  return new;
end;
$$;

drop trigger if exists email_provider_events_server_defaults
  on public.email_provider_events;
create trigger email_provider_events_server_defaults
  before insert on public.email_provider_events
  for each row execute function public.email_provider_events_server_defaults();

create or replace function public.email_provider_events_identity_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- What the provider reported is write-once, and so is the outcome: a
  -- processed receipt is never reprocessed into a different answer.
  if new.provider is distinct from old.provider
     or new.provider_event_id is distinct from old.provider_event_id
     or new.event_type is distinct from old.event_type
     or new.provider_email_id is distinct from old.provider_email_id
     or new.hone_message_id is distinct from old.hone_message_id
     or new.provider_created_at is distinct from old.provider_created_at
     or new.bounce_type is distinct from old.bounce_type
     or new.bounce_subtype is distinct from old.bounce_subtype
     or new.failure_reason is distinct from old.failure_reason
     or new.suppression_type is distinct from old.suppression_type
     or new.received_at is distinct from old.received_at
     or (old.processing_state <> 'pending'
         and (new.processing_state is distinct from old.processing_state
              or new.processing_result is distinct from old.processing_result
              or new.processed_at is distinct from old.processed_at
              or new.email_message_id is distinct from old.email_message_id))
     or new.processing_attempts < old.processing_attempts
  then
    raise exception 'email_provider_events identity and outcome are write-once'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists email_provider_events_identity_guard
  on public.email_provider_events;
create trigger email_provider_events_identity_guard
  before update on public.email_provider_events
  for each row execute function public.email_provider_events_identity_guard();

alter table public.email_provider_events enable row level security;

-- No policies: receipts are platform intake. A studio sees delivery truth
-- through the ledger row a receipt was applied to, in a later projection.

-- ---------------------------------------------------------------------------
-- 3. begin_appointment_email_message -- one row per appointment email attempt
-- ---------------------------------------------------------------------------
--
-- NOT a send decision. Whatever already decides whether an appointment email
-- may go out (the 0080 claim, the postcare claim, a user request) still
-- decides it; this row is created after that, so delivery events have an
-- attempt to land on. One appointment can therefore own several rows, one per
-- real attempt. Returns the row id, or null when the input is invalid or the
-- appointment is not the studio's.

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
                          'appointment_reminder_2h') then
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
-- 4. settle_email_message -- what the provider answered
-- ---------------------------------------------------------------------------
--
-- Outcomes: accepted (Resend returned an email id) | refused (it definitely
-- did not take the request) | unknown (an attempt was made and the answer was
-- lost) | skipped (no provider call was made; the reason says why).
--
-- A claimed row settles once. An `unknown` row may later settle `accepted`:
-- that is a retry under the SAME idempotency key getting the provider's real
-- answer, and it resolves the ambiguity rather than overwriting a fact. A
-- delivery event can beat the settle to the row; when it has already recorded
-- THIS email id, the settle answers `already_settled` and changes nothing.
--
-- Results: settled | already_settled | id_conflict | not_found | not_claimed |
-- invalid_input.

create or replace function public.settle_email_message(
  p_message_id        uuid,
  p_outcome           text,
  p_provider_email_id text,
  p_provider_error    text,
  p_skip_reason       text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row record;
begin
  if p_message_id is null
     or p_outcome is null
     or p_outcome not in ('accepted', 'refused', 'unknown', 'skipped')
     or (p_outcome = 'accepted'
         and (p_provider_email_id is null
              or p_provider_email_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
     or (p_outcome <> 'accepted' and p_provider_email_id is not null)
     or (p_outcome = 'skipped'
         and (p_skip_reason is null or p_skip_reason !~ '^[a-z][a-z0-9_]{2,63}$'))
     or (p_outcome <> 'skipped' and p_skip_reason is not null)
     or (p_provider_error is not null
         and (p_outcome not in ('refused', 'unknown')
              or p_provider_error !~ '^[a-z][a-z0-9_]{1,63}$')) then
    return 'invalid_input';
  end if;

  select m.id, m.status, m.provider_email_id
    into v_row
    from public.email_outbound_messages m
   where m.id = p_message_id
     for update;

  if not found then
    return 'not_found';
  end if;

  if v_row.status <> 'claimed'
     and not (v_row.status = 'unknown' and p_outcome = 'accepted') then
    if p_outcome = 'accepted'
       and v_row.provider_email_id = p_provider_email_id then
      return 'already_settled';
    end if;
    -- An `unknown` settle that loses the race to an event carrying the
    -- truth: the event already said the provider has the message, and an
    -- ambiguity must never overwrite a fact.
    if p_outcome = 'unknown' and v_row.provider_email_id is not null then
      return 'already_settled';
    end if;
    return 'not_claimed';
  end if;

  -- One provider message is one attempt. An id already held by another row
  -- is answered, not raised, so a caller's send is never broken by
  -- bookkeeping.
  if p_outcome = 'accepted' and exists (
    select 1 from public.email_outbound_messages o
     where o.provider_email_id = p_provider_email_id
       and o.id <> p_message_id
  ) then
    return 'id_conflict';
  end if;

  update public.email_outbound_messages m
     set status            = p_outcome,
         provider_email_id = coalesce(p_provider_email_id, m.provider_email_id),
         provider_error    = coalesce(p_provider_error, m.provider_error),
         skip_reason       = p_skip_reason,
         settled_at        = coalesce(m.settled_at, now())
   where m.id = p_message_id;

  return 'settled';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. record_email_provider_event -- the durable receipt
-- ---------------------------------------------------------------------------
--
-- Called by the webhook route AFTER the signature has verified and BEFORE it
-- acknowledges. The route passes only normalised, shape-checked fields; the
-- payload's addresses, subject, headers and free-text messages never reach
-- the database.
--
-- Results: recorded (a new receipt) | duplicate (this delivery id was already
-- received; its id and current state are returned, so a retry that finds it
-- still pending can finish it) | invalid_input.

create or replace function public.record_email_provider_event(
  p_provider_event_id   text,
  p_event_type          text,
  p_provider_email_id   text,
  p_hone_message_id     uuid,
  p_provider_created_at timestamptz,
  p_bounce_type         text,
  p_bounce_subtype      text,
  p_failure_reason      text,
  p_suppression_type    text
) returns table (
  result        text,
  receipt_id    uuid,
  receipt_state text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id    uuid;
  v_state text;
begin
  if p_provider_event_id is null
     or p_provider_event_id !~ '^[A-Za-z0-9_.:-]{1,128}$'
     or p_event_type is null
     or p_event_type !~ '^[a-z][a-z0-9_.]{1,63}$'
     or (p_provider_email_id is not null
         and p_provider_email_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     or (p_bounce_type is not null and p_bounce_type !~ '^[a-z][a-z0-9_]{1,63}$')
     or (p_bounce_subtype is not null and p_bounce_subtype !~ '^[a-z][a-z0-9_]{1,63}$')
     or (p_failure_reason is not null and p_failure_reason !~ '^[a-z][a-z0-9_]{1,63}$')
     or (p_suppression_type is not null and p_suppression_type !~ '^[a-z][a-z0-9_]{1,63}$') then
    return query select 'invalid_input'::text, null::uuid, null::text;
    return;
  end if;

  insert into public.email_provider_events (
    provider, provider_event_id, event_type, provider_email_id, hone_message_id,
    provider_created_at, bounce_type, bounce_subtype, failure_reason, suppression_type
  ) values (
    'resend', p_provider_event_id, p_event_type, p_provider_email_id, p_hone_message_id,
    p_provider_created_at, p_bounce_type, p_bounce_subtype, p_failure_reason, p_suppression_type
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_id;

  if v_id is not null then
    return query select 'recorded'::text, v_id, 'pending'::text;
    return;
  end if;

  select e.id, e.processing_state
    into v_id, v_state
    from public.email_provider_events e
   where e.provider = 'resend'
     and e.provider_event_id = p_provider_event_id;

  return query select 'duplicate'::text, v_id, v_state;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. claim_email_provider_events -- take receipts to process, bounded
-- ---------------------------------------------------------------------------
--
-- Every processing attempt is counted in its OWN committed statement, before
-- the attempt, so a worker that dies mid-attempt still spends one. A claim
-- is held for two minutes; after that the receipt can be claimed again. A
-- receipt that has spent five attempts is quarantined
-- (`processing_exhausted`) instead of being retried forever: one poison
-- receipt must not stall the queue or keep the provider retrying.
--
-- With p_event_id: claim exactly that receipt (the webhook route claiming the
-- one it just recorded). Without: sweep up to p_limit (1-50, default 10)
-- pending receipts at least a minute old, oldest first, skipping any another
-- worker holds. Returns the claimed receipt ids.

create or replace function public.claim_email_provider_events(
  p_event_id uuid,
  p_limit    integer
) returns table (
  receipt_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_max_attempts constant integer  := 5;
  c_claim_ttl    constant interval := interval '2 minutes';
  c_sweep_age    constant interval := interval '1 minute';
  v_limit        integer;
begin
  v_limit := case
    when p_event_id is not null then 1
    else greatest(1, least(coalesce(p_limit, 10), 50))
  end;

  with spent as (
    select e.id
      from public.email_provider_events e
     where e.processing_state = 'pending'
       and e.processing_attempts >= c_max_attempts
       and (e.processing_claimed_at is null
            or e.processing_claimed_at < now() - c_claim_ttl)
       and (p_event_id is null or e.id = p_event_id)
     for update skip locked
  )
  update public.email_provider_events e
     set processing_state      = 'quarantined',
         processing_result     = 'processing_exhausted',
         processed_at          = now(),
         processing_claimed_at = null
    from spent
   where e.id = spent.id;

  return query
  with candidates as (
    select e.id
      from public.email_provider_events e
     where e.processing_state = 'pending'
       and e.processing_attempts < c_max_attempts
       and (e.processing_claimed_at is null
            or e.processing_claimed_at < now() - c_claim_ttl)
       and (case
              when p_event_id is not null then e.id = p_event_id
              else e.received_at < now() - c_sweep_age
            end)
     order by e.received_at
     limit v_limit
     for update skip locked
  )
  update public.email_provider_events e
     set processing_attempts   = e.processing_attempts + 1,
         processing_claimed_at = now()
    from candidates
   where e.id = candidates.id
  returning e.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. process_email_provider_event -- apply one receipt, exactly once
-- ---------------------------------------------------------------------------
--
-- One transaction: the receipt row is locked, the ledger row it names is
-- locked, the status moves (or does not), and the receipt records its
-- outcome. Any error rolls all of it back and leaves the receipt pending for
-- the sweep. A receipt that is no longer pending answers `already_processed`
-- and changes nothing, so concurrent workers and replays cannot apply an
-- event twice.
--
-- Outcomes, written to processing_state / processing_result:
--   applied     status_advanced | complaint_recorded
--   stale       not_forward | duplicate_complaint   (matched; nothing moved)
--   unmatched   unmatched_tag | unmatched_email_id  (platform-only)
--   ignored     engagement_not_delivery             (opens and clicks)
--   quarantined unknown_event_type | missing_email_id | email_id_mismatch |
--               email_id_conflict | not_sent        (platform-only)
--
-- Returns (result, reason, message_id, message_studio_id, message_status).
-- result is one of the five states above, or already_processed | not_found |
-- invalid_input. The studio is returned only for applied and stale.

create or replace function public.process_email_provider_event(
  p_event_id uuid
) returns table (
  result            text,
  reason            text,
  message_id        uuid,
  message_studio_id uuid,
  message_status    text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_evt         record;
  v_msg         record;
  v_matched     boolean := false;
  v_msg_id      uuid;
  v_msg_studio  uuid;
  v_target      text;
  v_old_rank    integer;
  v_new_rank    integer;
  v_state       text;
  v_reason      text;
  v_status      text;
  v_event_at    timestamptz;
begin
  if p_event_id is null then
    return query select 'invalid_input'::text, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  select e.id, e.event_type, e.provider_email_id, e.hone_message_id,
         e.provider_created_at, e.bounce_type, e.bounce_subtype,
         e.failure_reason, e.suppression_type, e.processing_state,
         e.processing_result, e.email_message_id
    into v_evt
    from public.email_provider_events e
   where e.id = p_event_id
     for update;

  if not found then
    return query select 'not_found'::text, null::text, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v_evt.processing_state <> 'pending' then
    return query select 'already_processed'::text, v_evt.processing_result,
      v_evt.email_message_id, null::uuid, null::text;
    return;
  end if;

  v_event_at := coalesce(v_evt.provider_created_at, now());

  v_target := case v_evt.event_type
    when 'email.sent'             then 'sent'
    when 'email.delivery_delayed' then 'delivery_delayed'
    when 'email.delivered'        then 'delivered'
    when 'email.bounced'          then 'bounced'
    when 'email.failed'           then 'failed'
    when 'email.suppressed'       then 'suppressed'
    when 'email.complained'       then 'complained'
    else null
  end;

  if v_target is null then
    if v_evt.event_type in ('email.opened', 'email.clicked') then
      v_state := 'ignored';
      v_reason := 'engagement_not_delivery';
    else
      v_state := 'quarantined';
      v_reason := 'unknown_event_type';
    end if;
  elsif v_evt.provider_email_id is null then
    v_state := 'quarantined';
    v_reason := 'missing_email_id';
  else
    -- The tag names the row Hone created for this attempt. Without one, the
    -- provider email id is the only key.
    if v_evt.hone_message_id is not null then
      select m.id, m.studio_id, m.status, m.provider_email_id, m.complained_at
        into v_msg
        from public.email_outbound_messages m
       where m.id = v_evt.hone_message_id
         for update;
      v_matched := found;
      if not v_matched then
        v_state := 'unmatched';
        v_reason := 'unmatched_tag';
      end if;
    else
      select m.id, m.studio_id, m.status, m.provider_email_id, m.complained_at
        into v_msg
        from public.email_outbound_messages m
       where m.provider_email_id = v_evt.provider_email_id
         for update;
      v_matched := found;
      if not v_matched then
        v_state := 'unmatched';
        v_reason := 'unmatched_email_id';
      end if;
    end if;

    if v_matched then
      v_msg_id := v_msg.id;
      v_msg_studio := v_msg.studio_id;
      if v_msg.provider_email_id is not null
         and v_msg.provider_email_id <> v_evt.provider_email_id then
        -- The tag and the provider disagree about which message this is.
        v_state := 'quarantined';
        v_reason := 'email_id_mismatch';
      elsif v_msg.status in ('skipped', 'refused') then
        -- Hone recorded that this attempt never reached the provider.
        v_state := 'quarantined';
        v_reason := 'not_sent';
      elsif v_msg.provider_email_id is null and exists (
        select 1 from public.email_outbound_messages o
         where o.provider_email_id = v_evt.provider_email_id
           and o.id <> v_msg.id
      ) then
        v_state := 'quarantined';
        v_reason := 'email_id_conflict';
      else
        v_old_rank := case v_msg.status
          when 'claimed'          then 0
          when 'unknown'          then 0
          when 'accepted'         then 1
          when 'sent'             then 2
          when 'delivery_delayed' then 3
          when 'delivered'        then 4
          else 5  -- bounced | failed | suppressed: terminal
        end;

        if v_target = 'complained' then
          -- A complaint is about a delivered message: it records the
          -- complaint once and lifts an earlier status to delivered.
          if v_msg.complained_at is null or v_old_rank < 4 then
            update public.email_outbound_messages m
               set complained_at      = coalesce(m.complained_at, v_event_at),
                   status             = case when v_old_rank < 4 then 'delivered' else m.status end,
                   provider_email_id  = coalesce(m.provider_email_id, v_evt.provider_email_id),
                   provider_status_at = case when v_old_rank < 4 then v_event_at else m.provider_status_at end,
                   settled_at         = coalesce(m.settled_at, now())
             where m.id = v_msg.id
            returning m.status into v_status;
            v_state := 'applied';
            v_reason := 'complaint_recorded';
          else
            v_status := v_msg.status;
            v_state := 'stale';
            v_reason := 'duplicate_complaint';
          end if;
        else
          v_new_rank := case v_target
            when 'sent'             then 2
            when 'delivery_delayed' then 3
            when 'delivered'        then 4
            else 5
          end;

          if v_new_rank <= v_old_rank then
            -- Late, repeated or out of order: the row already says more.
            v_status := v_msg.status;
            v_state := 'stale';
            v_reason := 'not_forward';
          else
            -- A claimed or unknown row also adopts the provider's email id
            -- here: the provider is reporting that it has the message, which
            -- is exactly what an ambiguous answer could not say.
            update public.email_outbound_messages m
               set status             = v_target,
                   provider_email_id  = coalesce(m.provider_email_id, v_evt.provider_email_id),
                   provider_status_at = v_event_at,
                   settled_at         = coalesce(m.settled_at, now()),
                   bounce_type        = case when v_target = 'bounced' then v_evt.bounce_type else null end,
                   provider_reason    = case v_target
                                          when 'bounced'    then v_evt.bounce_subtype
                                          when 'failed'     then v_evt.failure_reason
                                          when 'suppressed' then v_evt.suppression_type
                                          else null
                                        end
             where m.id = v_msg.id
            returning m.status into v_status;
            v_state := 'applied';
            v_reason := 'status_advanced';
          end if;
        end if;
      end if;
    end if;
  end if;

  update public.email_provider_events e
     set processing_state      = v_state,
         processing_result     = v_reason,
         processed_at          = now(),
         processing_claimed_at = null,
         email_message_id      = case when v_state in ('applied', 'stale') then v_msg_id else null end
   where e.id = p_event_id;

  if v_state in ('applied', 'stale') then
    return query select v_state, v_reason, v_msg_id, v_msg_studio, v_status;
  else
    return query select v_state, v_reason, null::uuid, null::uuid, null::text;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants a new table and every new
-- function to anon, authenticated AND service_role at create time. Each is
-- revoked BY NAME before anything is granted -- the 0129 (`anon`) and 0164
-- (`service_role`) failure class.

revoke all on public.email_outbound_messages
  from public, anon, authenticated, service_role;
revoke all on public.email_provider_events
  from public, anon, authenticated, service_role;

revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from public;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from anon;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from authenticated;
revoke execute on function public.begin_appointment_email_message(uuid, uuid, text) from service_role;

revoke execute on function public.settle_email_message(uuid, text, text, text, text) from public;
revoke execute on function public.settle_email_message(uuid, text, text, text, text) from anon;
revoke execute on function public.settle_email_message(uuid, text, text, text, text) from authenticated;
revoke execute on function public.settle_email_message(uuid, text, text, text, text) from service_role;

revoke execute on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) from public;
revoke execute on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) from anon;
revoke execute on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) from authenticated;
revoke execute on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) from service_role;

revoke execute on function public.claim_email_provider_events(uuid, integer) from public;
revoke execute on function public.claim_email_provider_events(uuid, integer) from anon;
revoke execute on function public.claim_email_provider_events(uuid, integer) from authenticated;
revoke execute on function public.claim_email_provider_events(uuid, integer) from service_role;

revoke execute on function public.process_email_provider_event(uuid) from public;
revoke execute on function public.process_email_provider_event(uuid) from anon;
revoke execute on function public.process_email_provider_event(uuid) from authenticated;
revoke execute on function public.process_email_provider_event(uuid) from service_role;

grant execute on function public.begin_appointment_email_message(uuid, uuid, text) to service_role;
grant execute on function public.settle_email_message(uuid, text, text, text, text) to service_role;
grant execute on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) to service_role;
grant execute on function public.claim_email_provider_events(uuid, integer) to service_role;
grant execute on function public.process_email_provider_event(uuid) to service_role;

revoke all privileges on function public.email_outbound_messages_server_timestamps()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.email_outbound_messages_identity_guard()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.email_provider_events_server_defaults()
  from public, anon, authenticated, service_role;
revoke all privileges on function public.email_provider_events_identity_guard()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

comment on table public.email_outbound_messages is
  'DELIVERY-EVENTS-01 email delivery ledger: one row per outbound email attempt, claimed before the provider call, settled with the provider''s answer, advanced by signed Resend delivery events. Holds no recipient address, subject or body. Written only by begin_appointment_email_message, settle_email_message and process_email_provider_event (service_role only); no browser grant and no RLS policy.';
comment on column public.email_outbound_messages.status is
  'claimed -> skipped | refused | unknown | accepted (settle_email_message; unknown may later settle accepted), then forward-only through sent and delivery_delayed to delivered, and to bounced | failed | suppressed (process_email_provider_event). delivered means the recipient''s mail server accepted the message, not that anyone read it.';
comment on column public.email_outbound_messages.provider_email_id is
  'Resend email id, written only from a provider answer or a signed event. Write-once by trigger.';
comment on column public.email_outbound_messages.provider_reason is
  'Normalised slug of the provider''s reason for a terminal status: the bounce subtype, the failure reason or the suppression type. Never the provider''s free-text message.';
comment on table public.email_provider_events is
  'DELIVERY-EVENTS-01 receipts: one row per signature-verified Resend webhook delivery, recorded before the route acknowledges it and deduplicated on the delivery id (svix-id). Holds normalised fields only, never the payload''s addresses, subject or messages. email_message_id links an applied or stale receipt to its ledger row; every other receipt is attributable to no studio. Written only by record_email_provider_event, claim_email_provider_events and process_email_provider_event (service_role only); no browser grant and no RLS policy.';
comment on column public.email_provider_events.processing_state is
  'pending -> applied | stale | unmatched | ignored | quarantined, exactly once. Write-once by trigger after it leaves pending.';
comment on function public.begin_appointment_email_message(uuid, uuid, text) is
  'Create the ledger row for one appointment email attempt. Returns the row id, or null when the input is invalid or the appointment is not the studio''s. Does not decide whether a send may happen. service_role only.';
comment on function public.settle_email_message(uuid, text, text, text, text) is
  'Record what the provider answered for an attempt: accepted (with email id) | refused | unknown | skipped (with reason). A claimed row settles once; an unknown row may settle accepted. Returns settled | already_settled | id_conflict | not_found | not_claimed | invalid_input. service_role only.';
comment on function public.record_email_provider_event(text, text, text, uuid, timestamptz, text, text, text, text) is
  'The durable receipt for one signature-verified Resend webhook delivery, deduplicated on the delivery id. Returns (result, receipt_id, receipt_state) with result recorded | duplicate | invalid_input. service_role only.';
comment on function public.claim_email_provider_events(uuid, integer) is
  'Claim one named receipt, or sweep up to 50 pending receipts at least a minute old, counting each attempt before it is made; a receipt that has spent five attempts is quarantined as processing_exhausted. Returns the claimed receipt ids. service_role only.';
comment on function public.process_email_provider_event(uuid) is
  'Apply one receipt exactly once, in one transaction: forward-only status on the matched ledger row, or an unmatched / ignored / quarantined outcome attributable to no studio. Returns (result, reason, message_id, message_studio_id, message_status). service_role only.';

commit;
