-- ---------------------------------------------------------------------------
-- Google Calendar — Phase B2.4: DUAL DESTINATION scope contract + metadata.
--
-- ADDITIVE + DORMANT. Builds on Phase A (0121/0122), B1 (0124), B2.3-a (0125).
-- This migration reconciles the outbound event-write SCOPE contract so it is
-- destination-aware, and adds the destination metadata a connection needs to
-- record WHERE Hone will (later) place appointment events. Nothing runtime-active
-- ships here:
--   * NO Google API call, NO event scope granted, NO re-consent.
--   * NO studio outbound/inbound/two-way flag enabled; the GLOBAL worker control
--     stays OFF. NO enqueue, NO outbox row, NO calendar_event_link, NO appointment
--     mutation, NO backfill.
-- Prod migration max was 0130; this is 0131. Sequenced BEFORE B2.3-b/-c because
-- those phases (reconciliation/heartbeat; cron registration) consume the
-- readiness + scope contract this migration changes.
--
-- THE PROBLEM THIS FIXES. Before B2.4:
--   * DB required a single universal event scope: calendar_required_event_scopes()
--     returned {calendar.events.owned}.
--   * The app requested/checked the BROADER calendar.events (EVENT_WRITE_SCOPE).
--   So app and DB did not share one coherent contract. B2.4 makes the required
--   event scope DERIVE from the connection's chosen destination:
--     dedicated_app_created -> calendar.app.created  (Hone-created secondary cal)
--     existing_owned        -> calendar.events.owned (a calendar the user owns)
--   Broad calendar.events is REMOVED from the contract: it now satisfies NOTHING.
--
-- PRECONDITION (verified read-only before authoring): ZERO existing connections
-- hold calendar.events / calendar.events.owned / calendar.app.created (exact set
-- membership), so replacing the scope contract breaks no live connection.
--
-- EMPTY-ARRAY FAIL-OPEN TRAP (the central safety rule). In PostgreSQL
-- `any_array @> '{}'` is TRUE, so an empty required-scope array is FAIL-OPEN.
-- The destination-aware function therefore returns NULL (never '{}') for any
-- unset/unknown/malformed destination, and the readiness predicate EXPLICITLY
-- requires: destination set + required IS NOT NULL + cardinality(required) >= 1 +
-- granted @> required. Missing any of these => NOT ready (fail-closed).
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) calendar_connections: destination metadata. All nullable + additive; NO
--    backfill. Existing discovery-only rows keep destination_mode = NULL, which
--    derives as NOT event-ready (fail-closed) — a connection is never assumed to
--    have chosen a destination.
-- ============================================================
alter table public.calendar_connections
  -- The owner's chosen destination. NULL = not yet selected. Constrained below.
  add column if not exists destination_mode text,
  -- Safe, human-readable calendar name for the UI (never event data / PHI).
  add column if not exists selected_calendar_display_name text,
  -- When the destination became fully configured (calendar chosen/created). A
  -- derived-readiness INPUT, never a stored readiness flag.
  add column if not exists destination_configured_at timestamptz,
  -- existing_owned only: when server-side owner-access was validated for the
  -- selected calendar.
  add column if not exists destination_ownership_validated_at timestamptz,
  -- dedicated_app_created only: the id of the secondary calendar Hone CREATED.
  -- Provenance + idempotency anchor (a retry finds it set and never re-creates).
  add column if not exists app_created_calendar_id text;

-- ============================================================
-- 2) Constraints. Reject unknown modes; keep provenance fields mutually exclusive
--    and mode-consistent; ensure a "configured" destination has a write target.
--    Deliberately DO NOT constrain intermediate states (mode chosen + permission
--    granted, but not yet provisioned/selected) so the flow can progress safely.
-- ============================================================
alter table public.calendar_connections
  drop constraint if exists calendar_connections_destination_mode_chk;
alter table public.calendar_connections
  add constraint calendar_connections_destination_mode_chk
  check (destination_mode is null
         or destination_mode in ('dedicated_app_created', 'existing_owned'));

-- app-created provenance implies the dedicated mode.
alter table public.calendar_connections
  drop constraint if exists calendar_connections_app_created_provenance_chk;
alter table public.calendar_connections
  add constraint calendar_connections_app_created_provenance_chk
  check (app_created_calendar_id is null
         or destination_mode = 'dedicated_app_created');

-- ownership validation implies the existing-owned mode.
alter table public.calendar_connections
  drop constraint if exists calendar_connections_owned_validation_chk;
alter table public.calendar_connections
  add constraint calendar_connections_owned_validation_chk
  check (destination_ownership_validated_at is null
         or destination_mode = 'existing_owned');

-- The two provenance facts can never coexist (a destination is one mode or none).
alter table public.calendar_connections
  drop constraint if exists calendar_connections_provenance_exclusive_chk;
alter table public.calendar_connections
  add constraint calendar_connections_provenance_exclusive_chk
  check (not (app_created_calendar_id is not null
              and destination_ownership_validated_at is not null));

-- A "configured" destination must have a write target selected/created.
alter table public.calendar_connections
  drop constraint if exists calendar_connections_configured_requires_target_chk;
alter table public.calendar_connections
  add constraint calendar_connections_configured_requires_target_chk
  check (destination_configured_at is null or write_calendar_id is not null);

-- ============================================================
-- 3) Destination-aware required-scope contract. The SINGLE SQL source of the
--    required event scope, now parameterized by destination mode.
--
--    1-arg (canonical): maps each valid mode to its EXACT single scope; returns
--    NULL (NEVER '{}') for null/empty/unknown/malformed — so the empty-array
--    fail-open trap cannot arise.
--
--    0-arg (legacy compat): retained only so a stale caller cannot error; it now
--    returns NULL (never the old universal scope, never '{}'). No active caller
--    uses it after this migration (the readiness predicate below uses the 1-arg).
--    Intended removal: a later migration once no reference remains.
-- ============================================================
create or replace function public.calendar_required_event_scopes(p_destination_mode text)
returns text[] language sql immutable set search_path = pg_catalog, pg_temp
as $$
  select case p_destination_mode
    when 'dedicated_app_created' then
      array['https://www.googleapis.com/auth/calendar.app.created']::text[]
    when 'existing_owned' then
      array['https://www.googleapis.com/auth/calendar.events.owned']::text[]
    else null::text[]   -- null / empty / unknown / malformed => NULL, never '{}'
  end
$$;
revoke all on function public.calendar_required_event_scopes(text) from public, anon, authenticated;
grant execute on function public.calendar_required_event_scopes(text) to service_role;

-- Legacy 0-arg -> NULL (fail-closed). Never ARRAY[]::text[].
create or replace function public.calendar_required_event_scopes()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp
as $$ select null::text[] $$;
revoke all on function public.calendar_required_event_scopes() from public, anon, authenticated;
grant execute on function public.calendar_required_event_scopes() to service_role;

-- ============================================================
-- 4) Readiness predicate — the SINGLE health/eligibility gate (used by the claim
--    RPC's reaper + eligibility filter and the queue-health view; the enqueue
--    trigger is intent-gated and does not call this). Rewritten destination-aware
--    and FAIL-CLOSED against the empty-array trap. Signature unchanged, so the
--    claim RPC / view / reaper pick up the new logic without modification.
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
       -- Destination-aware, fail-closed: a valid destination whose EXACT required
       -- scope is present. The NULL + cardinality guards defeat `@> '{}'`.
       and c.destination_mode is not null
       and public.calendar_required_event_scopes(c.destination_mode) is not null
       and cardinality(public.calendar_required_event_scopes(c.destination_mode)) >= 1
       and c.granted_scopes @> public.calendar_required_event_scopes(c.destination_mode)
       and sec.encrypted_refresh_token is not null
      from public.calendar_connections c
      join public.studios s on s.id = c.studio_id
      left join public.calendar_connection_secrets sec on sec.connection_id = c.id
     where c.id = p_connection_id and c.studio_id = p_studio_id
  ), false);
$$;
revoke all on function public.calendar_connection_outbound_ready(uuid, uuid) from public, anon, authenticated;
grant execute on function public.calendar_connection_outbound_ready(uuid, uuid) to service_role;
