-- ---------------------------------------------------------------------------
-- Google Calendar — Phase B2.3-a: outbound enqueue + claim ACTIVATION BOUNDARY.
--
-- ADDITIVE + DORMANT. Builds on Phase A (0121/0122) + B1 (0124, deployed dormant).
-- This migration wires the DB-side outbound-sync foundation the future drain
-- worker (B2.3-b/B2.4) will consume, and NOTHING runtime-active ships here:
--   * NO production caller (no /api/cron/calendar-sync route in this PR).
--   * NO Google API call, NO event scope requested, NO re-consent.
--   * NO studio outbound flag is enabled; the GLOBAL worker control defaults OFF.
-- Prod migration max was 0124; this is 0125.
--
-- DORMANCY CONTRACT (proven by tests/db + tests/migrations):
--   * The appointment triggers may FIRE on ordinary bookings, but the enqueue
--     path returns immediately (creating NO outbox/link row) while a studio's
--     `google_calendar_outbound_sync_enabled` is OFF — i.e. product intent gates
--     enqueue. Every studio flag is OFF today, so booking behaviour is unchanged
--     and zero outbox/link rows are created.
--   * claim_calendar_sync_op returns ZERO rows and performs ZERO queue mutations
--     (no reap-to-dead, no attempt increment, no lease) while the singleton
--     `calendar_sync_control.worker_enabled` is false/absent. It defaults false.
--
-- INTENT vs HEALTH (the central design invariant):
--   * INTENT gate (enqueue + canonical bookkeeping — link create/rebind — no
--     Google call): studio outbound flag ON + an owner connection row exists +
--     a write_calendar_id is selected. It does NOT require connected status,
--     event scope, or a usable refresh token, so a transient connection outage
--     never erases calendar intent (changes made during an outage accumulate as
--     pending jobs that drain when health returns).
--   * HEALTH gate (claim / external execution): global worker control ON +
--     studio intent ON + connected + owner + write_calendar + granted_scopes
--     SUPERSET-contains the required scope + usable encrypted refresh token. When
--     unhealthy, jobs stay pending, attempts do not decay (Option A).
--
-- SCOPE: the working required event-write scope is calendar.events.owned (narrow,
-- owned-calendar CRUD). Broad calendar.events remains a documented FALLBACK only;
-- switching to it later requires a TRACKED migration (expected 0126) carrying the
-- function body + the app constant + consent disclosure + a fresh re-consent. No
-- untracked production CREATE OR REPLACE of the scope function is ever performed.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) appointments: sync_version (outbound source-of-truth) + reschedule lineage.
--    sync_version is the {source_version} in the deterministic idempotency key.
-- ============================================================
alter table public.appointments
  add column if not exists sync_version integer not null default 1,
  add column if not exists rescheduled_from_appointment_id uuid
      references public.appointments(id) on delete set null,
  add column if not exists rescheduled_to_appointment_id uuid
      references public.appointments(id) on delete set null,
  add column if not exists cancellation_kind text
      check (cancellation_kind is null or cancellation_kind in ('rescheduled','withdrawn'));

-- Bump rule: INSERT -> 1. UPDATE -> increment ONLY when a SERIALIZED field
-- (starts_at/ends_at/status) changes (IS DISTINCT FROM). An explicit caller bump
-- (the repair RPC sets sync_version = sync_version + 1) is RESPECTED, never
-- overwritten. practitioner_id/service_id are intentionally NOT serialized (the
-- allow-listed event serializer does not send them -> bumping would be no-op
-- PATCH churn). The app never writes sync_version directly.
create or replace function public.bump_appointment_sync_version()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.sync_version := 1;
    return new;
  end if;
  if new.sync_version is distinct from old.sync_version then
    return new;                                    -- explicit caller bump (e.g. repair RPC) -> respect it
  end if;
  if new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or new.status  is distinct from old.status then
    new.sync_version := old.sync_version + 1;
  end if;
  return new;
end $$;

-- BEFORE INSERT/UPDATE. Alphabetical same-event order puts this AFTER the
-- existing 'appointments_hash_cancellation_token_trg' and
-- 'appointments_snapshot_buffer_trg' (…hash < …snapshot < …sync_version), so it
-- runs after the buffer snapshot and never disturbs it.
drop trigger if exists appointments_sync_version_bump_trg on public.appointments;
create trigger appointments_sync_version_bump_trg
  before insert or update on public.appointments
  for each row execute function public.bump_appointment_sync_version();

-- ============================================================
-- 2) calendar_connections: resync + reconcile generation fences.
--    Writers are B2.4 (write-calendar change / reconcile campaign). Added dormant
--    here (default 0); B2.3-a implements NO Google-side generation handling.
-- ============================================================
alter table public.calendar_connections
  add column if not exists sync_generation      bigint not null default 0,
  add column if not exists reconcile_generation bigint not null default 0;

-- ============================================================
-- 3) Required event-write scope — SINGLE SQL source, read by BOTH DB-side
--    consumers (the enqueue trigger and the claim RPC). Working scope = .owned.
-- ============================================================
create or replace function public.calendar_required_event_scopes()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp
as $$ select array['https://www.googleapis.com/auth/calendar.events.owned']::text[] $$;
revoke all on function public.calendar_required_event_scopes() from public, anon, authenticated;
grant execute on function public.calendar_required_event_scopes() to service_role;

-- ============================================================
-- 4) Global runtime worker control (singleton). Authoritative at the CLAIM
--    boundary. Conservative default OFF. Missing/unreadable row => fail-safe
--    disabled (the claim RPC returns empty and mutates nothing).
-- ============================================================
create table if not exists public.calendar_sync_control (
  id             boolean primary key default true check (id),
  worker_enabled boolean not null default false,
  updated_at     timestamptz not null default now()
);
insert into public.calendar_sync_control (id, worker_enabled) values (true, false)
  on conflict (id) do nothing;
alter table public.calendar_sync_control enable row level security;
revoke all on public.calendar_sync_control from public, anon, authenticated;
grant select, update on public.calendar_sync_control to service_role;

-- ============================================================
-- 5) Append-only suppression/telemetry events. Deliberately NOT a contended
--    (studio_id, metric, day) counter row: one INSERT per event with a random
--    PK means concurrent suppressed enqueues NEVER serialize on a shared row
--    inside a booking transaction. Aggregation happens in the health view; a
--    bounded retention prune is a B2.3-b responsibility. PHI-free by contract.
-- ============================================================
create table if not exists public.calendar_sync_metric_events (
  id           uuid primary key default gen_random_uuid(),
  studio_id    uuid not null,
  metric       text not null,
  occurred_at  timestamptz not null default now(),
  safe_details jsonb not null default '{}'::jsonb
);
create index if not exists calendar_sync_metric_events_metric_time_idx
  on public.calendar_sync_metric_events (metric, occurred_at);
create index if not exists calendar_sync_metric_events_studio_metric_time_idx
  on public.calendar_sync_metric_events (studio_id, metric, occurred_at);
alter table public.calendar_sync_metric_events enable row level security;
revoke all on public.calendar_sync_metric_events from public, anon, authenticated;
grant select, insert, delete on public.calendar_sync_metric_events to service_role;   -- delete = B2.3-b retention

-- ============================================================
-- 6) Health predicate — the SAME readiness used by claim eligibility AND the
--    health-aware reaper. Does NOT include the global worker control (that is a
--    claim-RPC-level early return). SUPERSET containment (@>) so Google-bundled
--    extra scopes (e.g. userinfo.profile) never make a connection ineligible.
-- ============================================================
create or replace function public.calendar_connection_outbound_ready(
  p_connection_id uuid, p_studio_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  select coalesce((
    select s.google_calendar_outbound_sync_enabled
       and c.connection_status = 'connected'
       and c.is_studio_calendar_owner
       and c.write_calendar_id is not null
       and c.granted_scopes @> public.calendar_required_event_scopes()
       and sec.encrypted_refresh_token is not null
      from public.calendar_connections c
      join public.studios s on s.id = c.studio_id
      left join public.calendar_connection_secrets sec on sec.connection_id = c.id
     where c.id = p_connection_id and c.studio_id = p_studio_id
  ), false);
$$;
revoke all on function public.calendar_connection_outbound_ready(uuid, uuid) from public, anon, authenticated;
grant execute on function public.calendar_connection_outbound_ready(uuid, uuid) to service_role;

-- ============================================================
-- 7) Entity-field CHECK relaxation (narrow, approved): event.delete may be
--    ENTITY-LESS to carry a link tombstone after its appointment row is gone
--    (the orphan-link delete repair). Everything else is UNCHANGED: create/update
--    still REQUIRE an entity; full.resync still carries NONE.
-- ============================================================
alter table public.calendar_sync_outbox drop constraint if exists calendar_sync_outbox_entity_chk;
alter table public.calendar_sync_outbox add constraint calendar_sync_outbox_entity_chk check (
  (op_type in ('event.create','event.update')
     and hone_entity_type is not null and hone_entity_id is not null)
  or (op_type = 'event.delete')                                          -- entity OPTIONAL (tombstone delete)
  or (op_type = 'full.resync'
     and hone_entity_type is null and hone_entity_id is null)
);

-- ============================================================
-- 8) Enqueue trigger fn — INTENT-gated, matrix-derived, GENUINELY never-raise.
--    SECURITY DEFINER because the two raw-PostgREST appointment create paths run
--    as `authenticated`, which has NO outbox/link INSERT grant. No browser grant
--    is added (default-deny preserved). Canonical link bookkeeping runs on INTENT
--    (never gated on connection health). A failure anywhere — link, outbox,
--    telemetry, or even the ops_alerts marker — is swallowed so a booking is
--    NEVER aborted; the reconciliation sweep (B2.3-b) is the recovery net.
-- ============================================================
create or replace function public.enqueue_calendar_outbound()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_conn        public.calendar_connections%rowtype;
  v_op          text;
  v_key         text;
  v_ins         uuid;
  v_need_upsert boolean := false;
  v_has_link    boolean;
begin
  -- INTENT gate ONLY. No connection_status / scope / secret checks here.
  select c.* into v_conn
    from public.calendar_connections c
    join public.studios s on s.id = c.studio_id
   where c.studio_id = new.studio_id
     and c.is_studio_calendar_owner                       -- cleared only on deliberate disconnect
     and s.google_calendar_outbound_sync_enabled          -- durable studio product intent
     and c.write_calendar_id is not null                  -- a chosen target
   limit 1;
  if not found then
    return new;                                           -- no product intent -> no bookkeeping, no enqueue
  end if;

  -- Decide whether this transition needs a create/update sync (A1 matrix).
  if tg_op = 'INSERT' then
    if new.status = 'confirmed' then v_need_upsert := true; end if;
  elsif new.status = 'confirmed'
        and (old.status <> 'confirmed'                    -- into confirmed (defensive un-cancel)
             or new.starts_at is distinct from old.starts_at
             or new.ends_at  is distinct from old.ends_at
             or new.sync_version > old.sync_version) then -- timing change OR repair bump
    v_need_upsert := true;
  end if;

  if v_need_upsert then
    -- Reschedule carry-forward (dormant until B2.4 populates rescheduled_from):
    -- adopt the predecessor's active link and MOVE the version marker forward to
    -- the successor's version, so B2.4's stale guard never discards the successor.
    if tg_op = 'INSERT' and new.rescheduled_from_appointment_id is not null then
      update public.calendar_event_links
         set hone_entity_id = new.id,
             last_hone_version = new.sync_version,        -- successor's version (NOT the predecessor's)
             updated_at = now()
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.rescheduled_from_appointment_id and deleted_at is null;
    end if;

    select exists (
      select 1 from public.calendar_event_links
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.id and deleted_at is null) into v_has_link;
    if v_has_link then
      v_op := 'event.update';
    else
      v_op := 'event.create';
      insert into public.calendar_event_links
        (studio_id, connection_id, hone_entity_type, hone_entity_id,
         google_calendar_id, last_hone_version, sync_status, source_system)
      values (new.studio_id, v_conn.id, 'appointment', new.id,
              v_conn.write_calendar_id, new.sync_version, 'pending', 'hone')
      on conflict (studio_id, hone_entity_type, hone_entity_id) where deleted_at is null do nothing;
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'cancelled'     -- UPDATE-only: OLD is valid here
        and (old.status <> 'cancelled'                    -- transition into cancelled
             or new.sync_version > old.sync_version) then -- OR repair bump on an already-cancelled appt
    if new.cancellation_kind = 'rescheduled' then
      return new;                                         -- successor rebinds the link; suppress delete
    end if;
    select exists (
      select 1 from public.calendar_event_links
       where studio_id = new.studio_id and hone_entity_type = 'appointment'
         and hone_entity_id = new.id and deleted_at is null) into v_has_link;
    if not v_has_link then return new; end if;            -- never synced -> nothing to delete
    v_op := 'event.delete';
  else
    return new;                                           -- completed/no_show/no-serialized-change/etc.
  end if;

  v_key := 'appointment:' || new.id::text || ':' || v_op || ':' || new.sync_version::text;
  insert into public.calendar_sync_outbox
    (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
  values (new.studio_id, v_conn.id, v_op, 'appointment', new.id,
          jsonb_build_object('schema_version', 1, 'sync_version', new.sync_version, 'op', v_op),
          v_key, 100)
  on conflict (idempotency_key) do nothing
  returning id into v_ins;

  if v_ins is null then                                   -- suppressed by a prior (done/dead/live) row
    begin
      insert into public.calendar_sync_metric_events (studio_id, metric, safe_details)
      values (new.studio_id, 'idempotency_suppressed',
              jsonb_build_object('op', v_op, 'hone_entity_type', 'appointment'));   -- PHI-free
    exception when others then null; end;                -- telemetry never aborts a booking
  end if;
  return new;

exception when others then
  begin                                                   -- NESTED guard: a failed marker must not re-raise
    insert into public.ops_alerts (severity, event, message, studio_id, appointment_id, route, safe_details)
    values ('warning', 'calendar_enqueue_skipped',
            'Outbound calendar enqueue failed; a Google event may be missing or stale.',
            new.studio_id, new.id, 'trigger:enqueue_calendar_outbound',
            jsonb_build_object('tg_op', tg_op, 'sqlstate', sqlstate));   -- PHI-free
  exception when others then null; end;
  return new;                                             -- booking/edit is NEVER aborted by a sync problem
end $$;
revoke all on function public.enqueue_calendar_outbound() from public, anon, authenticated;

-- AFTER, fires LAST among appointment AFTER triggers (name order:
-- 'appointments_sync_calendar_reservation_trg' < 'appointments_zzz_outbound_enqueue_trg')
-- so it observes the post-snapshot blocked_ends_at and the bumped sync_version.
drop trigger if exists appointments_zzz_outbound_enqueue_trg on public.appointments;
create trigger appointments_zzz_outbound_enqueue_trg
  after insert or update of starts_at, ends_at, status, sync_version on public.appointments
  for each row execute function public.enqueue_calendar_outbound();

-- ============================================================
-- 9) AFTER DELETE cascade enqueue — hard-delete (client/studio cascade) tombstone
--    delete. Tombstone coordinates come from the LINK (the appointment row is
--    gone). No active link => no-op (teardown hard-purges links first). Genuinely
--    never-raise so a delete/cascade is never aborted.
-- ============================================================
create or replace function public.enqueue_calendar_outbound_on_delete()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_link public.calendar_event_links%rowtype;
begin
  select * into v_link from public.calendar_event_links
   where studio_id = old.studio_id and hone_entity_type = 'appointment'
     and hone_entity_id = old.id and deleted_at is null limit 1;
  if not found then return old; end if;                   -- teardown purged links first -> no-op
  if v_link.google_event_id is not null then
    insert into public.calendar_sync_outbox
      (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
    values (old.studio_id, v_link.connection_id, 'event.delete', 'appointment', old.id,
            jsonb_build_object('schema_version', 1, 'reason', 'entity_deleted',
                               'google_event_id', v_link.google_event_id,
                               'google_calendar_id', v_link.google_calendar_id),
            'appointment:' || old.id::text || ':event.delete:' || v_link.last_hone_version::text, 100)
    on conflict (idempotency_key) do nothing;
  end if;
  return old;
exception when others then
  begin
    insert into public.ops_alerts (severity, event, message, studio_id, route, safe_details)
    values ('warning', 'calendar_enqueue_skipped',
            'Outbound calendar delete enqueue failed; an event may remain in Google.',
            old.studio_id, 'trigger:enqueue_calendar_outbound_on_delete',
            jsonb_build_object('sqlstate', sqlstate));
  exception when others then null; end;
  return old;
end $$;
revoke all on function public.enqueue_calendar_outbound_on_delete() from public, anon, authenticated;

drop trigger if exists appointments_zzz_outbound_enqueue_delete_trg on public.appointments;
create trigger appointments_zzz_outbound_enqueue_delete_trg
  after delete on public.appointments
  for each row execute function public.enqueue_calendar_outbound_on_delete();

-- ============================================================
-- 10) Repair primitives — every repair mints a GENUINELY new idempotency key that
--     the FULL unique index has never seen; a dead/done row is NEVER reopened.
--     (a) appointment exists  -> a genuine sync_version bump -> a strictly-higher
--         organic key. Covers reconcile Classes 1/2/3 and Class 4a (cancelled).
--     (b) appointment row gone -> a reconcile-generation-scoped tombstone delete
--         (namespace `…#reconcile:{reconcile_generation}`) keyed off the link.
-- ============================================================
create or replace function public.repair_bump_appointment_sync_version(p_appointment_id uuid)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_new integer;
begin
  update public.appointments set sync_version = sync_version + 1     -- GENUINE bump (respected by the BEFORE trigger)
   where id = p_appointment_id returning sync_version into v_new;
  return v_new;                                                      -- null if the appointment does not exist
end $$;
revoke all on function public.repair_bump_appointment_sync_version(uuid) from public, anon, authenticated;
grant execute on function public.repair_bump_appointment_sync_version(uuid) to service_role;

create or replace function public.repair_enqueue_orphan_link_delete(p_link_id uuid)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_link public.calendar_event_links%rowtype; v_gen bigint; v_key text; v_ins uuid;
begin
  select * into v_link from public.calendar_event_links where id = p_link_id and deleted_at is null;
  if not found or v_link.google_event_id is null then return 'no_active_link'; end if;
  if exists (select 1 from public.calendar_sync_outbox           -- guard: no live delete for this event
              where op_type = 'event.delete' and status in ('pending','processing')
                and payload->>'google_event_id' = v_link.google_event_id) then
    return 'delete_in_flight';
  end if;
  select reconcile_generation into v_gen from public.calendar_connections where id = v_link.connection_id;
  v_key := 'connection:' || v_link.connection_id::text || ':link:' || v_link.id::text
           || ':event.delete#reconcile:' || coalesce(v_gen, 0)::text;
  insert into public.calendar_sync_outbox
    (studio_id, connection_id, op_type, hone_entity_type, hone_entity_id, payload, idempotency_key, priority)
  values (v_link.studio_id, v_link.connection_id, 'event.delete', null, null,     -- entity-less (relaxed CHECK)
          jsonb_build_object('schema_version', 1, 'reason', 'orphan_link_delete',
                             'google_event_id', v_link.google_event_id,
                             'google_calendar_id', v_link.google_calendar_id),
          v_key, 100)
  on conflict (idempotency_key) do nothing returning id into v_ins;
  return coalesce(v_ins::text, 'suppressed');
end $$;
revoke all on function public.repair_enqueue_orphan_link_delete(uuid) from public, anon, authenticated;
grant execute on function public.repair_enqueue_orphan_link_delete(uuid) to service_role;

-- ============================================================
-- 11) claim_calendar_sync_op — CREATE OR REPLACE. SAME signature + return shape +
--     batch clamp + SKIP LOCKED + 5-min lease as 0124. Adds: (i) the global
--     runtime control early-return; (ii) a HEALTH-AWARE reaper; (iii) the Option A
--     health eligibility filter. While the worker control is OFF/absent it returns
--     ZERO rows and makes ZERO mutations.
-- ============================================================
create or replace function public.claim_calendar_sync_op(p_batch_size integer)
returns table (
  id uuid, studio_id uuid, connection_id uuid, op_type text,
  hone_entity_type text, hone_entity_id uuid, payload jsonb,
  idempotency_key text, attempts integer, max_attempts integer,
  claim_token uuid, lease_expires_at timestamptz, priority integer
)
language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare
  v_now     timestamptz := now();
  v_limit   integer := least(greatest(coalesce(p_batch_size, 1), 1), 25);
  v_lease   interval := interval '5 minutes';
  v_enabled boolean;
begin
  -- (i) GLOBAL runtime control. Missing/unreadable => fail-safe disabled.
  -- Alias the table: a bare `id` would be ambiguous with this function's
  -- RETURNS TABLE (id uuid, …) output column.
  select ctl.worker_enabled into v_enabled
    from public.calendar_sync_control ctl where ctl.id = true;
  if not found or v_enabled is not true then
    return;                                              -- zero rows; NO reap, NO claim, NO mutation
  end if;

  -- (ii) HEALTH-AWARE reaper (runs BEFORE selecting a batch).
  -- (a) UNHEALTHY expired-processing -> release to pending, RESTORE the
  --     lease-consuming attempt (bounded >= 0): an outage never terminally kills
  --     the op nor permanently decays attempts (Option A).
  update public.calendar_sync_outbox o
     set status = 'pending',
         attempts = greatest(o.attempts - 1, 0),
         claimed_at = null, claim_token = null, lease_expires_at = null,
         next_attempt_at = v_now, updated_at = v_now
   where o.status = 'processing' and o.lease_expires_at <= v_now
     and not public.calendar_connection_outbound_ready(o.connection_id, o.studio_id);
  -- (b) HEALTHY expired-processing at the attempt cap -> dead (deployed contract).
  update public.calendar_sync_outbox o
     set status = 'dead', claimed_at = null, claim_token = null, lease_expires_at = null, updated_at = v_now
   where o.status = 'processing' and o.lease_expires_at <= v_now
     and o.attempts >= o.max_attempts
     and public.calendar_connection_outbound_ready(o.connection_id, o.studio_id);
  -- (healthy expired below max: untouched -> reclaimed by the claimable CTE below)

  -- (iii) Claim due, ELIGIBLE work only. Ineligible (unhealthy) jobs are never
  -- handed out, so their attempts/next_attempt_at do not decay.
  return query
  with claimable as (
    select o.id
      from public.calendar_sync_outbox o
     where ((o.status = 'pending'    and o.next_attempt_at  <= v_now and o.attempts < o.max_attempts)
         or (o.status = 'processing' and o.lease_expires_at <= v_now and o.attempts < o.max_attempts))
       and public.calendar_connection_outbound_ready(o.connection_id, o.studio_id)
     order by o.priority asc, o.next_attempt_at asc, o.created_at asc
     for update skip locked
     limit v_limit
  )
  update public.calendar_sync_outbox o
     set status = 'processing', claim_token = gen_random_uuid(), claimed_at = v_now,
         lease_expires_at = v_now + v_lease, attempts = o.attempts + 1, updated_at = v_now
    from claimable ca
   where o.id = ca.id
  returning o.id, o.studio_id, o.connection_id, o.op_type, o.hone_entity_type,
            o.hone_entity_id, o.payload, o.idempotency_key, o.attempts,
            o.max_attempts, o.claim_token, o.lease_expires_at, o.priority;
end $$;
revoke all on function public.claim_calendar_sync_op(integer) from public, anon, authenticated;
grant execute on function public.claim_calendar_sync_op(integer) to service_role;

-- ============================================================
-- 12) Supporting indexes for the eligibility join + the orphan-delete guard.
-- ============================================================
create index if not exists calendar_sync_outbox_conn_pending_idx
  on public.calendar_sync_outbox (connection_id) where status = 'pending';
create index if not exists calendar_sync_outbox_event_delete_idx
  on public.calendar_sync_outbox ((payload->>'google_event_id'))
  where op_type = 'event.delete' and status in ('pending','processing');

-- ============================================================
-- 13) Queue-health view (operator surface). UNION-anchored on studios that appear
--     in the outbox OR the metric events OR an unresolved enqueue-skip alert, so a
--     studio with ZERO outbox rows but an open skip marker is NOT invisible.
--     Aggregate counts only (no per-row content; the outbox holds no PHI).
-- ============================================================
create or replace view public.calendar_sync_queue_health as
with studio_ids as (
  select distinct studio_id from public.calendar_sync_outbox
  union
  select distinct studio_id from public.calendar_sync_metric_events
  union
  select distinct studio_id from public.ops_alerts
   where event = 'calendar_enqueue_skipped' and studio_id is not null
)
select
  si.studio_id,
  coalesce((select count(*) from public.calendar_sync_outbox o
             where o.studio_id = si.studio_id and o.status = 'pending'), 0)    as pending,
  coalesce((select count(*) from public.calendar_sync_outbox o
             where o.studio_id = si.studio_id and o.status = 'processing'), 0) as processing,
  coalesce((select count(*) from public.calendar_sync_outbox o
             where o.studio_id = si.studio_id and o.status = 'processing'
               and o.lease_expires_at <= now()), 0)                            as leases_expired,
  coalesce((select count(*) from public.calendar_sync_outbox o
             where o.studio_id = si.studio_id and o.status = 'dead'), 0)       as dead,
  coalesce((select count(*) from public.calendar_sync_outbox o
             where o.studio_id = si.studio_id and o.status = 'done'), 0)       as done,
  (select min(o.next_attempt_at) from public.calendar_sync_outbox o
     where o.studio_id = si.studio_id and o.status = 'pending')               as oldest_pending_due,
  coalesce((select count(*) from public.ops_alerts a
             where a.studio_id = si.studio_id and a.event = 'calendar_enqueue_skipped'
               and a.resolved_at is null), 0)                                  as skip_markers_open,
  coalesce((select count(*) from public.calendar_sync_metric_events m
             where m.studio_id = si.studio_id and m.metric = 'idempotency_suppressed'
               and m.occurred_at >= now() - interval '24 hours'), 0)           as idempotency_suppressed_24h
from studio_ids si;
revoke all on public.calendar_sync_queue_health from public, anon, authenticated;
grant select on public.calendar_sync_queue_health to service_role;
