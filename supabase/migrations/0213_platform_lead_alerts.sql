-- ===========================================================================
-- 0213 — LEAD-ALERT-01 (#826): THE OPERATOR ALERT FOR A NEW HONE LEAD
-- ===========================================================================
--
-- When a Hone demo request or early-access signup is saved, the platform
-- operator gets ONE email about it. These are prospects for Hone itself:
-- `public.demo_requests` (the /demo form, 0006) and `public.waitlist` (the
-- early-access list, 0004). NOT a studio's new-client waitlist
-- (`new_client_waitlist_entries`), and nothing is ever sent to the prospect.
--
--   DATABASE COMMIT  =  THE LEAD IS SAVED
--   EMAIL            =  NOTIFICATION
--
-- A refused, timed-out or unconfigured email can never retract or hide a
-- saved lead. The lead and its alert INTENT commit in one transaction; the
-- email is sent after the commit, and its fate is recorded on the intent.
--
-- Section by section:
--
--   1. public.platform_lead_alerts -- one row per durable new lead event: the
--      alert's state machine (pending -> sending -> accepted | failed), its
--      attempt count, lease, stable provider idempotency key and last failure.
--      At most one row per lead, as a unique key.
--   2. The guard: the lead an alert is about never changes, and updated_at is
--      the server's.
--   3. record_platform_demo_request(...) -- saves a demo request and its alert
--      intent together.
--   4. record_platform_early_access_signup(email) -- saves an early-access
--      signup and its intent together. An address already on the list saves
--      nothing and creates no alert: a duplicate is not a new lead.
--   5. claim_platform_lead_alert(alert, lease) -- leases ONE due alert to one
--      worker (FOR UPDATE SKIP LOCKED), or re-leases one whose worker's lease
--      expired without settling (crash recovery). Each claim is one counted
--      attempt; there are at most five.
--   5a. freeze_platform_lead_alert_message(alert, claim, message, digest) --
--      the FIRST attempt of a generation stores the exact message it sends
--      (From, subject, HTML, text) and the SHA-256 of its recipient; every
--      later attempt of that generation sends those bytes. See THE PAYLOAD.
--   6. settle_platform_lead_alert(...) -- only the holder of the CURRENT claim
--      token records the outcome: accepted (the provider ACCEPTED the message;
--      this is not a delivery receipt), retry later (with backoff), or failed.
--   7. expire_platform_lead_alerts() -- retires alerts that can no longer be
--      sent automatically: unsent 72 hours after the lead (or after the
--      operator's explicit retry), unsent 20 hours after their FIRST attempt
--      (see THE REPLAY WINDOW), or whose fifth attempt was abandoned.
--   8. record_platform_lead_alerts_unconfigured(code, alert) -- records that no
--      attempt could be made because SERVER configuration is missing (the
--      recipient, its allowlisting, the email transport or the console
--      origin). It consumes no attempt and is never success. An abandoned
--      send (expired lease) returns to pending with its lease cleared.
--   9. requeue_platform_lead_alert(alert) -- the operator's explicit retry of
--      a FAILED alert, under a fresh idempotency generation.
--  10. Privileges: the table and every command are service_role only.
--
-- REPEATED DEMO SUBMISSION VERSUS RETRY.
--   * A RETRY is another attempt to deliver the SAME alert. It reuses the
--     alert row and its idempotency key, and never inserts a lead.
--   * A REPEATED DEMO SUBMISSION is another request the form accepted. Lead
--     capture is unchanged: every accepted demo request is saved as its own
--     row, as it is today, so a repeated submission is a new lead with its own
--     single alert. The form's rate limit (5/hour per IP, 2/day per address)
--     bounds repeats, and a refused submission saves nothing and alerts nobody.
--   * An early-access address is unique (0004), so a repeated signup is a
--     duplicate: nothing saved, nothing alerted.
--
-- THE REPLAY WINDOW. Every retry of one alert reuses one provider idempotency
-- key, so a retry after an attempt whose answer was lost asks the provider to
-- REPLAY the first answer rather than send again. The provider keeps a key for
-- about 24 hours. An automatic retry later than that could therefore send a
-- second email under the "same" key. So automatic attempts end 20 hours after
-- the first one (the backoff schedule spends about 7 hours of that), whatever
-- the sweep's cadence; after that the alert is a visible failure, and only the
-- operator's explicit retry, under a NEW key generation, can send it again.
--
-- THE PAYLOAD IS FROZEN PER GENERATION (Codex P2 4244387544). One key must
-- always carry one request: the provider answers a different body under a
-- used key with invalid_idempotent_request, a terminal refusal. So the first
-- attempt of a generation freezes the message it sends, and every automatic
-- retry of that generation re-sends it byte for byte, whatever has changed
-- since in the renderer, the app origin or the sender address. Only the
-- operator's explicit retry, under a NEW generation and key, renders afresh.
-- The frozen message is cleared when its generation ends (accepted, failed or
-- expired): it duplicates lead details and is needed only while a retry is
-- possible.
--
-- NO CATCH-UP. Nothing here reads or alerts on an existing lead. Only a lead
-- saved through one of the two commands has an alert, so the leads already in
-- the tables, and any written another way, never generate email.
--
-- THE RECIPIENT IS NOT HERE. No column holds an address and no command takes
-- one: the application resolves the single operator recipient from server
-- configuration, allowlisted against the admin allowlist, at send time. A
-- submitted address is lead DATA, never a destination. The frozen message
-- keeps only the SHA-256 DIGEST of the recipient it was first sent to: a
-- retry whose configured recipient no longer has that digest cannot be the
-- same request, so it is not sent, and the alert fails as recipient_changed
-- for the operator to retry under a new key.
--
-- DEPLOYMENT ORDER: migration first. The application that calls these
-- commands is deployed after this migration; until then the deployed forms
-- keep inserting directly through 0004's and 0006's anonymous insert
-- policies, which still works and still creates no alert. Those policies are
-- therefore LEFT IN PLACE, unchanged. Retiring the direct write (revoke and
-- drop the policies) once no deployed application uses it is a later,
-- separate change.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. The alert intent
-- ---------------------------------------------------------------------------
create table public.platform_lead_alerts (
  id                   uuid        primary key default gen_random_uuid(),
  lead_kind            text        not null,
  demo_request_id      uuid        unique references public.demo_requests (id) on delete cascade,
  waitlist_id          uuid        unique references public.waitlist (id) on delete cascade,
  -- The lead's own created_at: the event the alert reports.
  event_at             timestamptz not null,
  status               text        not null default 'pending',
  attempt_count        integer     not null default 0,
  next_attempt_at      timestamptz not null default now(),
  claim_token          uuid,
  claimed_at           timestamptz,
  lease_expires_at     timestamptz,
  -- Bumped only by the operator's explicit retry of a failed alert.
  send_generation      integer     not null default 1,
  -- Derived, never written: stable across every retry of one generation.
  idempotency_key      text        generated always as
                         ('lead-alert/' || id::text || '/' || send_generation::text) stored,
  retry_requested_at   timestamptz,
  -- The first attempt of the current generation: the replay window's start.
  first_attempted_at   timestamptz,
  provider_message_id  text,
  accepted_at          timestamptz,
  failed_at            timestamptz,
  last_error_code      text,
  last_error_at        timestamptz,
  last_provider_error  text,
  -- THE PAYLOAD: what the current generation's first attempt sent, and the
  -- digest of its recipient (never the address). Set once per generation by
  -- freeze_platform_lead_alert_message; cleared when the generation ends.
  frozen_message       jsonb,
  frozen_recipient_sha256 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint platform_lead_alerts_kind_ck
    check (lead_kind in ('demo_request', 'early_access')),
  -- Exactly one lead, of the alert's own kind.
  constraint platform_lead_alerts_subject_ck
    check (case lead_kind
             when 'demo_request' then demo_request_id is not null and waitlist_id is null
             when 'early_access' then waitlist_id is not null and demo_request_id is null
           end),
  constraint platform_lead_alerts_status_ck
    check (status in ('pending', 'sending', 'accepted', 'failed')),
  constraint platform_lead_alerts_attempts_ck
    check (attempt_count between 0 and 5),
  constraint platform_lead_alerts_generation_ck
    check (send_generation >= 1),
  constraint platform_lead_alerts_first_attempt_ck
    check ((attempt_count = 0) = (first_attempted_at is null)),
  -- A lease exists exactly while an attempt is in flight.
  constraint platform_lead_alerts_lease_ck
    check ((status = 'sending'
            and claim_token is not null and claimed_at is not null and lease_expires_at is not null)
        or (status <> 'sending'
            and claim_token is null and claimed_at is null and lease_expires_at is null)),
  constraint platform_lead_alerts_accepted_ck
    check ((status = 'accepted') = (accepted_at is not null)),
  constraint platform_lead_alerts_failed_ck
    check ((status = 'failed') = (failed_at is not null)
           and (status <> 'failed' or last_error_code is not null)),
  constraint platform_lead_alerts_error_code_ck
    check (last_error_code is null or last_error_code in (
      'recipient_not_configured', 'recipient_not_allowlisted',
      'transport_not_configured', 'app_origin_not_configured',
      'provider_rejected', 'provider_unavailable', 'provider_timeout',
      'provider_exception', 'render_failed', 'recipient_changed',
      'lease_expired', 'expired')),
  constraint platform_lead_alerts_error_at_ck
    check ((last_error_code is null) = (last_error_at is null)),
  constraint platform_lead_alerts_provider_error_ck
    check (last_provider_error is null or last_provider_error ~ '^[a-z_]{1,64}$'),
  constraint platform_lead_alerts_message_id_ck
    check (provider_message_id is null or length(provider_message_id) between 1 and 200),
  -- Frozen together, only by an attempt, and only while a retry is possible.
  constraint platform_lead_alerts_frozen_ck
    check ((frozen_message is null) = (frozen_recipient_sha256 is null)
           and (frozen_message is null
                or (status in ('pending', 'sending') and attempt_count >= 1))),
  constraint platform_lead_alerts_frozen_shape_ck
    check (frozen_message is null
           or (jsonb_typeof(frozen_message) = 'object'
               and frozen_message - array['from', 'subject', 'html', 'text'] = '{}'::jsonb
               and jsonb_typeof(frozen_message->'from') = 'string'
               and jsonb_typeof(frozen_message->'subject') = 'string'
               and jsonb_typeof(frozen_message->'html') = 'string'
               and jsonb_typeof(frozen_message->'text') = 'string')),
  constraint platform_lead_alerts_frozen_digest_ck
    check (frozen_recipient_sha256 is null or frozen_recipient_sha256 ~ '^[0-9a-f]{64}$')
);

alter table public.platform_lead_alerts enable row level security;

-- The claim's candidates: only alerts that are still open.
create index platform_lead_alerts_open_idx
  on public.platform_lead_alerts (next_attempt_at, created_at)
  where status in ('pending', 'sending');

-- ---------------------------------------------------------------------------
-- 2. The guard
-- ---------------------------------------------------------------------------
create or replace function public.platform_lead_alerts_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.id is distinct from old.id
     or new.lead_kind is distinct from old.lead_kind
     or new.demo_request_id is distinct from old.demo_request_id
     or new.waitlist_id is distinct from old.waitlist_id
     or new.event_at is distinct from old.event_at
     or new.created_at is distinct from old.created_at then
    raise exception 'platform_lead_alerts: the lead an alert is about never changes';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger platform_lead_alerts_guard
  before update on public.platform_lead_alerts
  for each row execute function public.platform_lead_alerts_guard();

-- ---------------------------------------------------------------------------
-- 3. A demo request and its alert, together
-- ---------------------------------------------------------------------------
-- The /demo action validates and rate-limits first; this refuses only what
-- could never be a lead, and otherwise writes exactly the columns the form
-- wrote before. The table's own checks still apply: a refused lead write
-- raises, and the transaction leaves neither a lead nor an alert behind.
create or replace function public.record_platform_demo_request(
  p_name               text,
  p_email              text,
  p_practice_name      text,
  p_location           text,
  p_practice_type      text,
  p_practitioner_count text,
  p_current_tool       text,
  p_notes              text
) returns table (result text, lead_id uuid, alert_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_lead_id    uuid;
  v_created_at timestamptz;
  v_alert_id   uuid;
begin
  if nullif(btrim(p_name), '') is null or nullif(btrim(p_email), '') is null then
    return query select 'invalid_input'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.demo_requests
    (name, email, practice_name, location, practice_type,
     practitioner_count, current_tool, notes)
  values
    (p_name, p_email, p_practice_name, p_location, p_practice_type,
     p_practitioner_count, p_current_tool, p_notes)
  returning id, created_at into v_lead_id, v_created_at;

  insert into public.platform_lead_alerts
    (lead_kind, demo_request_id, event_at, next_attempt_at)
  values
    ('demo_request', v_lead_id, v_created_at, v_created_at)
  returning id into v_alert_id;

  return query select 'recorded'::text, v_lead_id, v_alert_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. An early-access signup and its alert, together
-- ---------------------------------------------------------------------------
-- The address is the list's unique key (0004). A second signup for the same
-- address is the database's answer, not a read-then-write: two simultaneous
-- signups resolve inside the one insert, and only the first creates a lead
-- and an alert. The early-access action normalizes the address first, as it
-- always has.
create or replace function public.record_platform_early_access_signup(
  p_email text
) returns table (result text, lead_id uuid, alert_id uuid)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_lead_id    uuid;
  v_created_at timestamptz;
  v_alert_id   uuid;
begin
  if nullif(btrim(p_email), '') is null then
    return query select 'invalid_input'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.waitlist (email)
  values (p_email)
  on conflict (email) do nothing
  returning id, created_at into v_lead_id, v_created_at;

  if v_lead_id is null then
    return query select 'duplicate'::text, null::uuid, null::uuid;
    return;
  end if;

  insert into public.platform_lead_alerts
    (lead_kind, waitlist_id, event_at, next_attempt_at)
  values
    ('early_access', v_lead_id, v_created_at, v_created_at)
  returning id into v_alert_id;

  return query select 'recorded'::text, v_lead_id, v_alert_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The claim
-- ---------------------------------------------------------------------------
-- p_alert_id names one alert (the send right after its lead is saved) or is
-- NULL (the sweep: the oldest claimable alert). Claimable means fewer than
-- five attempts, inside the 72-hour window, and either due (pending) or
-- abandoned (sending, lease expired). SKIP LOCKED: a row another worker is
-- claiming is passed over, never waited for, so two workers never hold one
-- alert. The lead's fields come back with the claim so the email is built
-- from the committed row; notes are reported only as present or absent.
create or replace function public.claim_platform_lead_alert(
  p_alert_id      uuid,
  p_lease_seconds integer
) returns table (
  result             text,
  alert_id           uuid,
  claim_token        uuid,
  attempt            integer,
  idempotency_key    text,
  lead_kind          text,
  lead_id            uuid,
  event_at           timestamptz,
  lead_name          text,
  lead_email         text,
  practice_name      text,
  location           text,
  practice_type      text,
  practitioner_count text,
  current_tool       text,
  has_notes          boolean,
  frozen_message     jsonb,
  frozen_recipient_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_id    uuid;
  v_prior text;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'claim_platform_lead_alert: the lease must be 30 to 900 seconds'
      using errcode = '22023';
  end if;

  select a.id, a.status
    into v_id, v_prior
    from public.platform_lead_alerts a
   where (p_alert_id is null or a.id = p_alert_id)
     and a.status in ('pending', 'sending')
     and a.attempt_count < 5
     and coalesce(a.retry_requested_at, a.event_at) > v_now - interval '72 hours'
     -- THE REPLAY WINDOW: never an automatic attempt the provider could not
     -- recognise as a replay of the first.
     and (a.first_attempted_at is null or a.first_attempted_at > v_now - interval '20 hours')
     and ((a.status = 'pending' and a.next_attempt_at <= v_now)
       or (a.status = 'sending' and a.lease_expires_at <= v_now))
   -- FAIR: earliest-DUE first (Codex P2 4253669922). Ordering by creation
   -- let the oldest alerts take every slot while later ones aged towards the
   -- replay cutoff; due-time order serves each alert in the order its next
   -- attempt fell due.
   order by a.next_attempt_at, a.created_at
   limit 1
   for update of a skip locked;

  if v_id is null then
    return query select 'none'::text, null::uuid, null::uuid, null::integer,
      null::text, null::text, null::uuid, null::timestamptz, null::text,
      null::text, null::text, null::text, null::text, null::text, null::text,
      null::boolean, null::jsonb, null::text;
    return;
  end if;

  update public.platform_lead_alerts a
     set status           = 'sending',
         claim_token      = v_token,
         claimed_at       = v_now,
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         attempt_count    = a.attempt_count + 1,
         first_attempted_at = coalesce(a.first_attempted_at, v_now),
         -- A re-lease means the previous worker never settled: say so.
         last_error_code  = case when v_prior = 'sending' then 'lease_expired'
                                 else a.last_error_code end,
         last_error_at    = case when v_prior = 'sending' then v_now
                                 else a.last_error_at end
   where a.id = v_id;

  return query
    select 'claimed'::text, a.id, a.claim_token, a.attempt_count,
           a.idempotency_key, a.lead_kind,
           coalesce(a.demo_request_id, a.waitlist_id), a.event_at,
           d.name, coalesce(d.email, w.email),
           coalesce(d.practice_name, w.practice_name), d.location,
           d.practice_type, d.practitioner_count, d.current_tool,
           nullif(btrim(d.notes), '') is not null,
           a.frozen_message, a.frozen_recipient_sha256
      from public.platform_lead_alerts a
      left join public.demo_requests d on d.id = a.demo_request_id
      left join public.waitlist w on w.id = a.waitlist_id
     where a.id = v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5a. The frozen message
-- ---------------------------------------------------------------------------
-- FIRST WRITER WINS, under the CURRENT claim only. The first attempt of a
-- generation stores the message it is about to send; if one is already
-- stored (an earlier attempt of this generation froze it), that one is
-- returned and the caller's is discarded, so a retry can never send other
-- bytes under the key. A stale claim freezes nothing.
create or replace function public.freeze_platform_lead_alert_message(
  p_alert_id         uuid,
  p_claim_token      uuid,
  p_message          jsonb,
  p_recipient_sha256 text
) returns table (result text, message jsonb, recipient_sha256 text)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_alert record;
begin
  if p_alert_id is null or p_claim_token is null or p_message is null
     or jsonb_typeof(p_message) <> 'object'
     or p_message - array['from', 'subject', 'html', 'text'] <> '{}'::jsonb
     or jsonb_typeof(p_message->'from') is distinct from 'string'
     or jsonb_typeof(p_message->'subject') is distinct from 'string'
     or jsonb_typeof(p_message->'html') is distinct from 'string'
     or jsonb_typeof(p_message->'text') is distinct from 'string'
     or p_recipient_sha256 is null or p_recipient_sha256 !~ '^[0-9a-f]{64}$' then
    return query select 'invalid_input'::text, null::jsonb, null::text;
    return;
  end if;

  select a.status, a.claim_token, a.frozen_message, a.frozen_recipient_sha256
    into v_alert
    from public.platform_lead_alerts a
   where a.id = p_alert_id
     for update;
  if not found then
    return query select 'not_found'::text, null::jsonb, null::text;
    return;
  end if;
  if v_alert.status <> 'sending' or v_alert.claim_token is distinct from p_claim_token then
    return query select 'stale_claim'::text, null::jsonb, null::text;
    return;
  end if;
  if v_alert.frozen_message is not null then
    return query select 'existing'::text, v_alert.frozen_message, v_alert.frozen_recipient_sha256;
    return;
  end if;

  update public.platform_lead_alerts a
     set frozen_message          = p_message,
         frozen_recipient_sha256 = p_recipient_sha256
   where a.id = p_alert_id;
  return query select 'frozen'::text, p_message, p_recipient_sha256;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The settle
-- ---------------------------------------------------------------------------
-- FENCING: the outcome is recorded only for the claim that is current. A
-- worker whose lease expired and whose alert was re-claimed gets
-- 'stale_claim' and changes nothing. A retryable failure schedules the next
-- attempt (2 min, 10 min, 1 h, then 6 h); the fifth failure, a terminal
-- failure, or a failure past the 72-hour window is final.
create or replace function public.settle_platform_lead_alert(
  p_alert_id            uuid,
  p_claim_token         uuid,
  p_outcome             text,
  p_provider_message_id text,
  p_error_code          text,
  p_provider_error      text
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_alert   record;
  v_error   text;
  v_backoff interval;
begin
  if p_alert_id is null or p_claim_token is null
     or p_outcome is null or p_outcome not in ('accepted', 'retry', 'fail') then
    return 'invalid_input';
  end if;
  -- 'lease_expired' and 'expired' are the claim's and the expiry's to record.
  if p_outcome <> 'accepted' and (p_error_code is null or p_error_code not in (
       'recipient_not_configured', 'recipient_not_allowlisted',
       'transport_not_configured', 'app_origin_not_configured',
       'provider_rejected', 'provider_unavailable', 'provider_timeout',
       'provider_exception', 'render_failed', 'recipient_changed')) then
    return 'invalid_input';
  end if;

  select a.status, a.claim_token, a.attempt_count, a.event_at, a.retry_requested_at,
         a.first_attempted_at
    into v_alert
    from public.platform_lead_alerts a
   where a.id = p_alert_id
     for update;
  if not found then
    return 'not_found';
  end if;
  if v_alert.status <> 'sending' or v_alert.claim_token is distinct from p_claim_token then
    return 'stale_claim';
  end if;

  if p_outcome = 'accepted' then
    update public.platform_lead_alerts a
       set status               = 'accepted',
           accepted_at          = v_now,
           provider_message_id  = nullif(left(p_provider_message_id, 200), ''),
           claim_token          = null,
           claimed_at           = null,
           lease_expires_at     = null,
           last_error_code      = null,
           last_error_at        = null,
           last_provider_error  = null,
           frozen_message       = null,
           frozen_recipient_sha256 = null
     where a.id = p_alert_id;
    return 'accepted';
  end if;

  -- The provider's error name is kept only in its known shape.
  v_error := case when p_provider_error ~ '^[a-z_]{1,64}$' then p_provider_error end;

  if p_outcome = 'fail'
     or v_alert.attempt_count >= 5
     or coalesce(v_alert.retry_requested_at, v_alert.event_at) <= v_now - interval '72 hours'
     or v_alert.first_attempted_at <= v_now - interval '20 hours' then
    update public.platform_lead_alerts a
       set status               = 'failed',
           failed_at            = v_now,
           claim_token          = null,
           claimed_at           = null,
           lease_expires_at     = null,
           last_error_code      = p_error_code,
           last_error_at        = v_now,
           last_provider_error  = v_error,
           frozen_message       = null,
           frozen_recipient_sha256 = null
     where a.id = p_alert_id;
    return 'failed';
  end if;

  v_backoff := case v_alert.attempt_count
                 when 1 then interval '2 minutes'
                 when 2 then interval '10 minutes'
                 when 3 then interval '1 hour'
                 else interval '6 hours'
               end;
  update public.platform_lead_alerts a
     set status               = 'pending',
         next_attempt_at      = v_now + v_backoff,
         claim_token          = null,
         claimed_at           = null,
         lease_expires_at     = null,
         last_error_code      = p_error_code,
         last_error_at        = v_now,
         last_provider_error  = v_error
   where a.id = p_alert_id;
  return 'retry_scheduled';
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. The expiry
-- ---------------------------------------------------------------------------
-- An alert that can no longer be sent automatically becomes a visible
-- failure instead of waiting forever: unsent 72 hours after its lead (or
-- after the operator's retry), or abandoned on its fifth attempt. The lead
-- itself is untouched. Returns how many alerts it retired.
create or replace function public.expire_platform_lead_alerts()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_count integer;
begin
  update public.platform_lead_alerts a
     set status           = 'failed',
         failed_at        = v_now,
         claim_token      = null,
         claimed_at       = null,
         lease_expires_at = null,
         last_error_code  = case when a.status = 'sending' then 'lease_expired'
                                 else 'expired' end,
         last_error_at    = v_now,
         frozen_message   = null,
         frozen_recipient_sha256 = null
   where (a.status = 'pending'
          and (coalesce(a.retry_requested_at, a.event_at) <= v_now - interval '72 hours'
               or a.first_attempted_at <= v_now - interval '20 hours'))
      or (a.status = 'sending'
          and a.lease_expires_at <= v_now
          and (a.attempt_count >= 5
               or coalesce(a.retry_requested_at, a.event_at) <= v_now - interval '72 hours'
               or a.first_attempted_at <= v_now - interval '20 hours'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Blocked by configuration
-- ---------------------------------------------------------------------------
-- No attempt was possible, so none is counted and nothing is claimed: the
-- open alert (one, or every pending one when p_alert_id is NULL) records why
-- it is still waiting. Returns how many alerts it annotated.
--
-- AN ABANDONED SEND IS NOT AN ACTIVE ONE (Codex P2 4261478391). A `sending`
-- row whose lease has EXPIRED belongs to a worker that died or lost its
-- settle. With configuration blocked nothing reclaims it, so it would read as
-- an active send in /admin until the expiry. Such a row returns to `pending`
-- with its lease cleared and the blocker recorded, in the SAME statement that
-- annotates the pending rows:
--   * FENCED: the lease test is re-evaluated on the locked row, so a lease a
--     claim renewed meanwhile is not touched, and a LIVE lease never is. The
--     old worker's token is cleared, so its freeze or settle answers
--     stale_claim.
--   * NOTHING ELSE CHANGES: the attempt count, first attempt, next due time,
--     generation (so the idempotency key) and frozen message are kept, so the
--     next claim is the same replay-safe retry it would have been, under the
--     same five attempts and replay windows.
--   * Only rows the claim could still take move: one past its attempts or
--     windows is left for expire_platform_lead_alerts() to fail.
create or replace function public.record_platform_lead_alerts_unconfigured(
  p_error_code text,
  p_alert_id   uuid
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_error_code is null or p_error_code not in (
       'recipient_not_configured', 'recipient_not_allowlisted',
       'transport_not_configured', 'app_origin_not_configured') then
    raise exception 'record_platform_lead_alerts_unconfigured: not a configuration code'
      using errcode = '22023';
  end if;

  update public.platform_lead_alerts a
     set status           = 'pending',
         claim_token      = null,
         claimed_at       = null,
         lease_expires_at = null,
         last_error_code  = p_error_code,
         last_error_at    = v_now
   where (p_alert_id is null or a.id = p_alert_id)
     and (a.status = 'pending'
       or (a.status = 'sending'
           and a.lease_expires_at <= v_now
           and a.attempt_count < 5
           and coalesce(a.retry_requested_at, a.event_at) > v_now - interval '72 hours'
           and (a.first_attempted_at is null or a.first_attempted_at > v_now - interval '20 hours')));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The operator's retry
-- ---------------------------------------------------------------------------
-- Only a FAILED alert, only by explicit request. It gets a fresh attempt
-- budget, a fresh 72-hour window and a new idempotency generation (the
-- provider may have stored the previous key's refusal). The lead is not
-- touched.
create or replace function public.requeue_platform_lead_alert(
  p_alert_id uuid
) returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_now    timestamptz := clock_timestamp();
  v_status text;
begin
  if p_alert_id is null then
    return 'invalid_input';
  end if;

  select a.status
    into v_status
    from public.platform_lead_alerts a
   where a.id = p_alert_id
     for update;
  if not found then
    return 'not_found';
  end if;
  if v_status <> 'failed' then
    return 'not_failed';
  end if;

  update public.platform_lead_alerts a
     set status             = 'pending',
         failed_at          = null,
         attempt_count      = 0,
         first_attempted_at = null,
         next_attempt_at    = v_now,
         retry_requested_at = v_now,
         send_generation    = a.send_generation + 1
   where a.id = p_alert_id;
  return 'requeued';
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges: service_role only
-- ---------------------------------------------------------------------------
-- The table is read by the operator console through service_role and written
-- ONLY by the commands above: no role, service_role included, may write it
-- directly.
revoke all on table public.platform_lead_alerts from public;
revoke all on table public.platform_lead_alerts from anon;
revoke all on table public.platform_lead_alerts from authenticated;
revoke all on table public.platform_lead_alerts from service_role;
grant select on table public.platform_lead_alerts to service_role;

revoke execute on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) from public;
revoke execute on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) from anon;
revoke execute on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) from authenticated;
revoke execute on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) from service_role;
grant execute on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) to service_role;

revoke execute on function public.record_platform_early_access_signup(text) from public;
revoke execute on function public.record_platform_early_access_signup(text) from anon;
revoke execute on function public.record_platform_early_access_signup(text) from authenticated;
revoke execute on function public.record_platform_early_access_signup(text) from service_role;
grant execute on function public.record_platform_early_access_signup(text) to service_role;

revoke execute on function public.claim_platform_lead_alert(uuid, integer) from public;
revoke execute on function public.claim_platform_lead_alert(uuid, integer) from anon;
revoke execute on function public.claim_platform_lead_alert(uuid, integer) from authenticated;
revoke execute on function public.claim_platform_lead_alert(uuid, integer) from service_role;
grant execute on function public.claim_platform_lead_alert(uuid, integer) to service_role;

revoke execute on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) from public;
revoke execute on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) from anon;
revoke execute on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) from authenticated;
revoke execute on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) from service_role;
grant execute on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) to service_role;

revoke execute on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) from public;
revoke execute on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) from anon;
revoke execute on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) from authenticated;
revoke execute on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) from service_role;
grant execute on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) to service_role;

revoke execute on function public.expire_platform_lead_alerts() from public;
revoke execute on function public.expire_platform_lead_alerts() from anon;
revoke execute on function public.expire_platform_lead_alerts() from authenticated;
revoke execute on function public.expire_platform_lead_alerts() from service_role;
grant execute on function public.expire_platform_lead_alerts() to service_role;

revoke execute on function public.record_platform_lead_alerts_unconfigured(text, uuid) from public;
revoke execute on function public.record_platform_lead_alerts_unconfigured(text, uuid) from anon;
revoke execute on function public.record_platform_lead_alerts_unconfigured(text, uuid) from authenticated;
revoke execute on function public.record_platform_lead_alerts_unconfigured(text, uuid) from service_role;
grant execute on function public.record_platform_lead_alerts_unconfigured(text, uuid) to service_role;

revoke execute on function public.requeue_platform_lead_alert(uuid) from public;
revoke execute on function public.requeue_platform_lead_alert(uuid) from anon;
revoke execute on function public.requeue_platform_lead_alert(uuid) from authenticated;
revoke execute on function public.requeue_platform_lead_alert(uuid) from service_role;
grant execute on function public.requeue_platform_lead_alert(uuid) to service_role;

revoke all privileges on function public.platform_lead_alerts_guard() from public;
revoke all privileges on function public.platform_lead_alerts_guard() from anon;
revoke all privileges on function public.platform_lead_alerts_guard() from authenticated;
revoke all privileges on function public.platform_lead_alerts_guard() from service_role;

comment on table public.platform_lead_alerts is
  'LEAD-ALERT-01 (0213): one operator alert per Hone demo request or early-access signup saved through record_platform_demo_request / record_platform_early_access_signup. accepted = the email provider accepted the message (not a delivery receipt). No recipient is stored. service_role reads; only the 0213 commands write.';
comment on column public.platform_lead_alerts.idempotency_key is
  'The provider Idempotency-Key: derived from the alert id and its send generation, identical on every retry of one generation.';
comment on function public.record_platform_demo_request(text, text, text, text, text, text, text, text) is
  'LEAD-ALERT-01 (0213): saves a demo request and its operator alert intent in one transaction. Every saved request is a new lead with one alert; nothing is ever sent to the prospect. service_role only.';
comment on function public.record_platform_early_access_signup(text) is
  'LEAD-ALERT-01 (0213): saves an early-access signup and its operator alert intent in one transaction; an address already on the list returns duplicate and creates no alert. service_role only.';
comment on function public.claim_platform_lead_alert(uuid, integer) is
  'LEAD-ALERT-01 (0213): leases one due or abandoned operator alert (SKIP LOCKED), counting one attempt (at most five, within 72 hours of the lead and 20 hours of the first attempt), and returns the lead fields the alert email needs (notes only as present/absent). service_role only.';
comment on function public.freeze_platform_lead_alert_message(uuid, uuid, jsonb, text) is
  'LEAD-ALERT-01 (0213): under the current claim, stores the message the first attempt of a generation sends (From, subject, HTML, text) and its recipient''s SHA-256 digest, or returns the one already stored, so every retry under one idempotency key is byte-identical. service_role only.';
comment on function public.settle_platform_lead_alert(uuid, uuid, text, text, text, text) is
  'LEAD-ALERT-01 (0213): records an attempt''s outcome for the CURRENT claim token only (stale_claim otherwise): accepted, retry with backoff, or failed. service_role only.';
comment on function public.expire_platform_lead_alerts() is
  'LEAD-ALERT-01 (0213): fails alerts unsent 72 hours after their lead (or the operator''s retry) or 20 hours after their first attempt, or abandoned on their fifth attempt. service_role only.';
comment on function public.record_platform_lead_alerts_unconfigured(text, uuid) is
  'LEAD-ALERT-01 (0213): records a configuration blocker on pending alerts, and returns abandoned sends (expired lease, still claimable) to pending with their lease cleared, without counting an attempt or changing the idempotency generation; a live lease is never touched; never success. service_role only.';
comment on function public.requeue_platform_lead_alert(uuid) is
  'LEAD-ALERT-01 (0213): the operator''s explicit retry of a FAILED alert, with a fresh attempt budget, window and idempotency generation. service_role only.';

commit;
