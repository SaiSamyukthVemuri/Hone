-- ---------------------------------------------------------------------------
-- Google Calendar — Phase B, PR B1: outbound-sync SCHEMA + QUEUE foundation.
--
-- ADDITIVE + DORMANT. This migration adds two tables + two trusted RPCs and
-- NOTHING ELSE. There is NO runtime behavior: no enqueue path, no Google API
-- call, no trigger on appointments/blocks, no appointment RPC change, no
-- availability change, no feature enablement. Deployed Phase A code ignores
-- these tables entirely. Prod migration max was 0123; this is 0124.
--
-- What later phases add (NOT here):
--   B2 = typed server-side enqueue (idempotency key generation, sync_generation
--        source for full.resync, entity-version capture into last_hone_version,
--        same-studio entity validation, disconnect/teardown reconciliation).
--   B3 = the drain worker that actually calls the Google Calendar API.
--
-- CONNECTION TEARDOWN / RESTRICT reconciliation (inspected against deployed
-- Phase A disconnectConnection): disconnect DELETEs the secrets row and UPDATEs
-- the calendar_connections row to status='disconnected' — it does NOT hard-
-- delete the connection row. So ON DELETE RESTRICT below never blocks a
-- disconnect. The only hard-delete path is a studio/practitioner CASCADE, which
-- RESTRICT WILL block once B2 writes event-link/outbox rows; the binding B2/B3
-- reconciliation is: soft-delete event links + resolve (cancel) outbox rows
-- BEFORE a connection can be removed. B1 does not change disconnect behavior.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) calendar_event_links — durable idempotent mapping of ONE Hone entity
--    (appointment | timed_block) to its Google Calendar event.
-- ============================================================
create table if not exists public.calendar_event_links (
  id                    uuid primary key default gen_random_uuid(),
  studio_id             uuid not null,
  connection_id         uuid not null,

  -- Polymorphic Hone entity. Deliberately NO direct FK to appointments/
  -- studio_timed_blocks (the relationship is polymorphic); the type is
  -- constrained here, and same-studio target ownership is validated by the
  -- trusted B2 enqueue/worker logic (with behavioral tests), not by a runtime
  -- mapping in B1.
  hone_entity_type      text not null
                          check (hone_entity_type in ('appointment','timed_block')),
  hone_entity_id        uuid not null,

  google_calendar_id    text not null,
  google_event_id       text,            -- null until first successful push (B3)
  google_ical_uid       text,            -- survives reschedule cancel+recreate
  source_system         text not null default 'hone'
                          check (source_system in ('hone','google')),

  -- Metadata only in B1 (supports B2 stale-operation rejection); no runtime
  -- version-comparison behavior is introduced here.
  last_hone_version     bigint not null default 0,

  google_etag           text,
  sync_status           text not null default 'pending'
                          check (sync_status in ('pending','synced','conflict','error','deleted')),
  last_sync_direction   text
                          check (last_sync_direction is null
                                 or last_sync_direction in ('hone_to_google','google_to_hone')),
  last_synced_at        timestamptz,
  last_error_code       text,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Same-studio integrity via the 0121 companion unique (id, studio_id).
  -- ON DELETE RESTRICT so removing a connection cannot silently erase historical
  -- event-link state (teardown must soft-delete links first — see header).
  constraint calendar_event_links_connection_same_studio
    foreign key (connection_id, studio_id)
    references public.calendar_connections (id, studio_id) on delete restrict
);

-- ONE active link per Hone entity.
create unique index if not exists calendar_event_links_active_entity_uniq
  on public.calendar_event_links (studio_id, hone_entity_type, hone_entity_id)
  where deleted_at is null;

-- ONE active mapping per Google event (per connection + calendar).
create unique index if not exists calendar_event_links_active_google_event_uniq
  on public.calendar_event_links (connection_id, google_calendar_id, google_event_id)
  where google_event_id is not null and deleted_at is null;

create index if not exists calendar_event_links_studio_idx
  on public.calendar_event_links (studio_id, hone_entity_type);

alter table public.calendar_event_links enable row level security;

-- Members may SELECT their studio's link metadata (for a future per-appointment
-- sync/conflict badge). Columns are safe operational metadata (no secrets, no
-- Google event descriptions, no PHI). NO write policy → writes are service-role
-- only. Adding the SELECT policy now avoids a policy-only migration later.
drop policy if exists calendar_event_links_member_select on public.calendar_event_links;
create policy calendar_event_links_member_select
  on public.calendar_event_links
  for select to authenticated
  using (public.is_studio_member(studio_id));

revoke insert, update, delete on public.calendar_event_links from anon;
revoke insert, update, delete on public.calendar_event_links from authenticated;
revoke all on public.calendar_event_links from public;
grant select on public.calendar_event_links to authenticated;
grant select, insert, update, delete on public.calendar_event_links to service_role;

-- ============================================================
-- 2) calendar_sync_outbox — durable, at-least-once queue for FUTURE Google
--    synchronization. No code enqueues these in B1.
--
--    Four-state model ONLY: pending / processing / done / dead. (No separate
--    failed state — a retryable failure returns to pending; exhaustion is dead.)
--      pending    = due now or scheduled for a future retry (next_attempt_at).
--      processing = actively leased by exactly one worker (5-min lease).
--      done       = terminal success.
--      dead       = terminal exhaustion / permanent failure.
--    Retryable failure returns pending (future next_attempt_at); exhaustion -> dead.
--
--    Priority: LOWER value = HIGHER priority; range 0..1000; default 100.
--    Claim ordering: priority ASC, next_attempt_at ASC, created_at ASC.
--
--    idempotency_key: the DETERMINISTIC identity of the logical operation, NOT a
--    random UUID. Canonical derivation (contract; enforced by B2, pinned by
--    tests):  {hone_entity_type}:{hone_entity_id}:{op_type}:{source_version}
--      e.g.  appointment:<id>:event.create:1 ; timed_block:<id>:event.update:4
--    For full.resync (non-entity):
--            connection:<connection_id>:full.resync:<sync_generation>
--    NOTE: sync_generation does NOT exist yet; its source (likely a counter on
--    calendar_connections) is a B2 decision — DEFERRED to B2. Do not add it here.
--    The unique index on idempotency_key is FULL (all statuses): a 'done' or even
--    a terminal 'dead' row permanently blocks re-enqueueing the exact same
--    logical operation. Recovery from 'dead' is a source-version bump (new key)
--    or a full.resync — B3 must NOT resurrect dead rows under the same key.
--
--    PAYLOAD PRIVACY: operational metadata ONLY (entity id/type, source version,
--    desired op, timing, connection id, correlation/idempotency metadata). NEVER
--    client name/email/phone, service/modality, notes, block reason, intake/
--    consent/clinical data, photos, payments/price, raw Google event content, or
--    OAuth tokens/codes/credentials. B1 cannot fully prove semantic privacy for
--    arbitrary JSONB; the binding B2 enforcement is: payloads are built server-
--    side by a FIXED allow-listed serializer from TYPED params (never raw client
--    JSONB), and no browser role has INSERT/UPDATE rights (below).
-- ============================================================
create table if not exists public.calendar_sync_outbox (
  id                    uuid primary key default gen_random_uuid(),
  studio_id             uuid not null,
  connection_id         uuid not null,

  op_type               text not null
                          check (op_type in ('event.create','event.update','event.delete','full.resync')),
  hone_entity_type      text
                          check (hone_entity_type is null
                                 or hone_entity_type in ('appointment','timed_block')),
  hone_entity_id        uuid,
  payload               jsonb not null default '{}'::jsonb,
  idempotency_key       text not null,

  status                text not null default 'pending'
                          check (status in ('pending','processing','done','dead')),
  priority              integer not null default 100
                          check (priority between 0 and 1000),
  attempts              integer not null default 0
                          check (attempts >= 0),
  max_attempts          integer not null default 8
                          check (max_attempts > 0),
  next_attempt_at       timestamptz not null default now(),
  claimed_at            timestamptz,
  claim_token           uuid,
  lease_expires_at      timestamptz,
  last_error_code       text,
  last_error_message    text,
  processed_at          timestamptz,   -- set ONLY on 'done'; dead keeps it NULL
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint calendar_sync_outbox_attempts_le_max check (attempts <= max_attempts),

  -- Bidirectional claim-metadata consistency: a 'processing' row has ALL claim
  -- metadata; every non-'processing' row has NONE.
  constraint calendar_sync_outbox_claim_meta_chk check (
    (status = 'processing'
       and claimed_at is not null and claim_token is not null and lease_expires_at is not null)
    or
    (status <> 'processing'
       and claimed_at is null and claim_token is null and lease_expires_at is null)
  ),

  -- Entity-field consistency: entity ops carry an entity; full.resync carries none.
  constraint calendar_sync_outbox_entity_chk check (
    (op_type in ('event.create','event.update','event.delete')
       and hone_entity_type is not null and hone_entity_id is not null)
    or
    (op_type = 'full.resync'
       and hone_entity_type is null and hone_entity_id is null)
  ),

  constraint calendar_sync_outbox_connection_same_studio
    foreign key (connection_id, studio_id)
    references public.calendar_connections (id, studio_id) on delete restrict
);

-- FULL (all-status) unique on the deterministic idempotency key.
create unique index if not exists calendar_sync_outbox_idempotency_uniq
  on public.calendar_sync_outbox (idempotency_key);

-- Claim/drain index — column order supports: due jobs, priority ASC, oldest first.
create index if not exists calendar_sync_outbox_claim_idx
  on public.calendar_sync_outbox (status, priority, next_attempt_at, created_at);

-- Retryable-pending fast path.
create index if not exists calendar_sync_outbox_retryable_idx
  on public.calendar_sync_outbox (next_attempt_at)
  where status = 'pending' and attempts < max_attempts;

-- Stale processing-lease reaper.
create index if not exists calendar_sync_outbox_lease_idx
  on public.calendar_sync_outbox (lease_expires_at)
  where status = 'processing';

create index if not exists calendar_sync_outbox_connection_status_idx
  on public.calendar_sync_outbox (connection_id, status);
create index if not exists calendar_sync_outbox_studio_status_idx
  on public.calendar_sync_outbox (studio_id, status);

alter table public.calendar_sync_outbox enable row level security;
-- Default-deny for browser roles: RLS on + NO policy + explicit REVOKE. A future
-- safe status UI (if needed) will use a separate redacted view, NOT this table.
revoke all on public.calendar_sync_outbox from anon;
revoke all on public.calendar_sync_outbox from authenticated;
revoke all on public.calendar_sync_outbox from public;
grant select, insert, update, delete on public.calendar_sync_outbox to service_role;

-- ============================================================
-- 3) claim_calendar_sync_op(p_batch_size) — trusted bounded-batch claim.
--    SECURITY DEFINER, service-role only. FOR UPDATE SKIP LOCKED. Fixed 5-min
--    lease. Reaps stale-at-max processing rows to 'dead' FIRST (closes the
--    orphan state where a job on its final attempt is claimed, the worker dies,
--    and the row would otherwise sit in 'processing' forever). No version logic.
-- ============================================================
create or replace function public.claim_calendar_sync_op(p_batch_size integer)
returns table (
  id uuid, studio_id uuid, connection_id uuid, op_type text,
  hone_entity_type text, hone_entity_id uuid, payload jsonb,
  idempotency_key text, attempts integer, max_attempts integer,
  claim_token uuid, lease_expires_at timestamptz, priority integer
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now   timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_batch_size, 1), 1), 25);
  v_lease interval := interval '5 minutes';
begin
  -- Reap orphans: stale-lease processing rows that already hit the attempt cap
  -- become terminal 'dead' (unreachable by claim or result otherwise).
  update public.calendar_sync_outbox o
     set status = 'dead',
         claimed_at = null, claim_token = null, lease_expires_at = null,
         updated_at = v_now
   where o.status = 'processing'
     and o.lease_expires_at <= v_now
     and o.attempts >= o.max_attempts;

  return query
  with claimable as (
    select o.id
      from public.calendar_sync_outbox o
     where (
             (o.status = 'pending'    and o.next_attempt_at  <= v_now and o.attempts < o.max_attempts)
             or
             (o.status = 'processing' and o.lease_expires_at <= v_now and o.attempts < o.max_attempts)
           )
     order by o.priority asc, o.next_attempt_at asc, o.created_at asc
     for update skip locked
     limit v_limit
  )
  update public.calendar_sync_outbox o
     set status = 'processing',
         claim_token = gen_random_uuid(),
         claimed_at = v_now,
         lease_expires_at = v_now + v_lease,
         attempts = o.attempts + 1,
         updated_at = v_now
    from claimable c
   where o.id = c.id
  returning o.id, o.studio_id, o.connection_id, o.op_type,
            o.hone_entity_type, o.hone_entity_id, o.payload,
            o.idempotency_key, o.attempts, o.max_attempts,
            o.claim_token, o.lease_expires_at, o.priority;
end;
$$;

revoke all on function public.claim_calendar_sync_op(integer) from public;
revoke all on function public.claim_calendar_sync_op(integer) from anon;
revoke all on function public.claim_calendar_sync_op(integer) from authenticated;
grant execute on function public.claim_calendar_sync_op(integer) to service_role;

-- ============================================================
-- 4) record_calendar_sync_result(...) — trusted result/retry.
--    SECURITY DEFINER, service-role only. Validates the claim token + processing
--    state; success -> done (processed_at set, prior diagnostics RETAINED);
--    retryable failure -> pending + bounded backoff (5s..6h); exhaustion -> dead
--    (processed_at stays NULL). Idempotent: a repeat against a done/dead row is a
--    deterministic no-op, and a stale/wrong token is rejected.
-- ============================================================
create or replace function public.record_calendar_sync_result(
  p_id                  uuid,
  p_claim_token         uuid,
  p_ok                  boolean,
  p_error_code          text default null,
  p_error_message       text default null,
  p_retry_after_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_row public.calendar_sync_outbox%rowtype;
  v_now timestamptz := now();
begin
  select * into v_row from public.calendar_sync_outbox where id = p_id for update;
  if not found then
    return 'not_found';
  end if;

  -- Terminal rows are never reopened. A late result from a dead-via-claim row
  -- (its token lost with the dead worker) lands here and is a no-op.
  if v_row.status = 'done' then return 'already_done'; end if;
  if v_row.status = 'dead' then return 'already_dead'; end if;

  -- Must be currently processing with the matching claim token.
  if v_row.status <> 'processing' then return 'not_claimed'; end if;
  if v_row.claim_token is null or v_row.claim_token <> p_claim_token then
    return 'stale_token';
  end if;

  if p_ok then
    update public.calendar_sync_outbox
       set status = 'done',
           processed_at = v_now,
           claimed_at = null, claim_token = null, lease_expires_at = null,
           updated_at = v_now
       -- last_error_code / last_error_message deliberately RETAINED as history.
     where id = p_id;
    return 'done';
  end if;

  -- Retryable failure: bounded backoff (strictly > 0; 5s min; 6h max).
  if p_retry_after_seconds is null or p_retry_after_seconds < 5 or p_retry_after_seconds > 21600 then
    raise exception 'retry_after_seconds must be between 5 and 21600 seconds'
      using errcode = 'check_violation';
  end if;

  if v_row.attempts >= v_row.max_attempts then
    update public.calendar_sync_outbox
       set status = 'dead',
           claimed_at = null, claim_token = null, lease_expires_at = null,
           last_error_code = left(coalesce(p_error_code, v_row.last_error_code), 500),
           last_error_message = left(coalesce(p_error_message, v_row.last_error_message), 500),
           updated_at = v_now
     where id = p_id;
    return 'dead';
  end if;

  update public.calendar_sync_outbox
     set status = 'pending',
         next_attempt_at = v_now + make_interval(secs => p_retry_after_seconds),
         claimed_at = null, claim_token = null, lease_expires_at = null,
         last_error_code = left(coalesce(p_error_code, ''), 500),
         last_error_message = left(coalesce(p_error_message, ''), 500),
         updated_at = v_now
   where id = p_id;
  return 'pending';
end;
$$;

revoke all on function public.record_calendar_sync_result(uuid, uuid, boolean, text, text, integer) from public;
revoke all on function public.record_calendar_sync_result(uuid, uuid, boolean, text, text, integer) from anon;
revoke all on function public.record_calendar_sync_result(uuid, uuid, boolean, text, text, integer) from authenticated;
grant execute on function public.record_calendar_sync_result(uuid, uuid, boolean, text, text, integer) to service_role;
