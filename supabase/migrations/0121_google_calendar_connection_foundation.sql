-- ---------------------------------------------------------------------------
-- Google Calendar Two-Way Sync — Phase A (Connection & OAuth foundation).
-- Migration 1 of 2: the DORMANT connection schema. Additive only; nothing here
-- reads or writes on the current deploy until the studio flag is turned on.
--
-- What this adds (all dormant, default OFF / empty):
--   1. Four studio-scoped feature flags, ALL default false. Only
--      google_calendar_connection_enabled is used in Phase A (gates the Connect
--      UI + OAuth start server-side). The other three name the future phases
--      (outbound push / inbound busy / two-way edits) and stay OFF + unused.
--   2. public.calendar_connections — per-practitioner Google OAuth connection +
--      NON-SECRET metadata + sync/health state. Member-readable (no secret here).
--   3. public.calendar_connection_secrets — the ONLY place the encrypted refresh
--      token lives. RLS on + ZERO browser-role policy + explicit REVOKE, so a
--      same-studio peer can never read another practitioner's credential (this
--      is the explicit close of the 0116 raw-feed-token peer-read lesson: the
--      raw calendar-feed credential was dropped precisely because members could
--      read it; the OAuth token is a REPLAYABLE secret and must be strictly
--      service-role-only, encrypted, never a raw column).
--
-- What this deliberately does NOT add (later phases, per the approved plan):
--   * calendar_event_links / external_calendar_busy_events / calendar outbox
--   * webhook / watch-channel tables
--   * any event-sync, availability, or booking behavior
--
-- Design decisions grounded in the current codebase:
--   * PRACTITIONER-scoped credential (OAuth is a per-user grant; the existing
--     external-calendar credential practitioners.calendar_feed_token_hash,
--     0046/0079/0116, is already per-practitioner), STUDIO-scoped on/off flag
--     (matches the 0110/0119/0120 flag convention + getCurrentPractitionerWith
--     Studio load path). Hone's scheduling is studio-wide today, so exactly ONE
--     designated calendar owner per studio is modeled (is_studio_calendar_owner)
--     — this single practitioner's calendar is BOTH the future write target and,
--     once inbound busy ships, the whole-studio busy source. Calendar-owner and
--     write-target may split later when Hone becomes practitioner-resource-aware;
--     that distinction is intentionally NOT modeled now (one boolean, not two).
--   * Same-studio composite FKs (the 0094 pattern; practitioners already has
--     the companion unique (id, studio_id) from 0032) make cross-studio
--     attachment structurally impossible.
--   * Token encryption reuses the AES-256-GCM primitive of
--     lib/conversion/token-crypto.ts under a DEDICATED key
--     (GOOGLE_TOKEN_ENCRYPTION_KEY) with an explicit key version stored per row.
--
-- Migration-first + safe ordering: additive tables + defaulted columns on a
-- table with no dependent deployed code. Applying this before the Phase A code
-- ships is safe (all flags OFF, nothing reads the tables). Prod migration max
-- was 0120; this is 0121.
-- ---------------------------------------------------------------------------

-- ============================================================
-- 1) Studio feature flags — ALL default OFF. Only the connection flag is used
--    in Phase A; the rest name the future phases and stay OFF + unused.
-- ============================================================
alter table public.studios
  add column if not exists google_calendar_connection_enabled    boolean not null default false,
  add column if not exists google_calendar_outbound_sync_enabled  boolean not null default false,
  add column if not exists google_calendar_inbound_busy_enabled   boolean not null default false,
  add column if not exists google_calendar_two_way_updates_enabled boolean not null default false;

-- ============================================================
-- 2) calendar_connections — per-practitioner connection + NON-SECRET metadata.
--    No credential material on this table (the ciphertext lives in the secrets
--    side table below), so this table is safe to expose to same-studio members
--    for the settings/health card.
-- ============================================================
create table if not exists public.calendar_connections (
  id                        uuid primary key default gen_random_uuid(),
  studio_id                 uuid not null references public.studios (id) on delete cascade,
  practitioner_id           uuid not null,

  provider                  text not null default 'google'
                              check (provider in ('google')),
  -- Google identity (server-verified at callback; never client-supplied).
  google_account_id         text,   -- stable Google 'sub'/userinfo id (survives email change)
  google_account_email      text,   -- display / recognition only
  -- Selected write target (a Google calendarId, e.g. 'primary'), validated at
  -- selection time against this connection's own calendar list.
  write_calendar_id         text,

  connection_status         text not null default 'disconnected'
                              check (connection_status in
                                ('disconnected','connected','reconnect_required','revoked','error')),
  granted_scopes            text[] not null default '{}',
  -- Operational metadata ONLY (not credential material): expiry of the last
  -- access token minted. The access token itself is never persisted in Phase A.
  token_expires_at          timestamptz,
  last_successful_auth_at    timestamptz,
  last_error_code           text,    -- short code only, NEVER a token / PII
  last_error_at             timestamptz,
  disconnected_at           timestamptz,

  -- The studio's designated calendar owner (future write target + whole-studio
  -- busy source under studio-wide scheduling). At most one active per studio.
  is_studio_calendar_owner  boolean not null default false,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Same-studio integrity: this practitioner must belong to this studio.
  -- Uses the companion unique practitioners_id_studio_id_unique (id, studio_id)
  -- from migration 0032. ON DELETE CASCADE is the deliberate, SAFE cascade:
  -- removing a practitioner removes their credential (a lingering credential for
  -- a departed practitioner is the unsafe state). Phase A has no separate
  -- immutable "connection history" table; durable event/audit history in later
  -- phases will use RESTRICT/tombstones instead.
  constraint calendar_connections_practitioner_same_studio
    foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete cascade,

  -- One Google connection row per practitioner (reconnect = in-place UPDATE,
  -- never a duplicate row).
  constraint calendar_connections_practitioner_uniq unique (practitioner_id),

  -- Companion unique so the secrets side table can carry a same-studio composite
  -- FK back to (id, studio_id) — the 0094 tenant-isolation trick.
  constraint calendar_connections_id_studio_uniq unique (id, studio_id)
);

-- At most ONE active studio calendar owner per studio (partial unique).
create unique index if not exists calendar_connections_one_owner_per_studio
  on public.calendar_connections (studio_id)
  where is_studio_calendar_owner;

create index if not exists calendar_connections_studio_idx
  on public.calendar_connections (studio_id);

alter table public.calendar_connections enable row level security;

-- Members may READ their studio's connection metadata (status/email/write
-- calendar/owner designation/health) — NO secret is on this table. Writes are
-- service-role only (the OAuth callback + settings actions use the admin
-- client); there is intentionally NO authenticated INSERT/UPDATE/DELETE policy
-- (default-deny), mirroring studio_calendar_reservations (0030).
drop policy if exists calendar_connections_member_select on public.calendar_connections;
create policy calendar_connections_member_select
  on public.calendar_connections
  for select to authenticated
  using (public.is_studio_member(studio_id));

-- ============================================================
-- 3) calendar_connection_secrets — the ONLY place ciphertext lives.
--    RLS on + NO policy for any browser role + explicit REVOKE = default-deny.
--    A same-studio peer (or any authenticated/anon role) can never SELECT the
--    ciphertext. Only the service-role sync/OAuth paths read it. Token expiry is
--    NOT duplicated here (it is operational metadata on calendar_connections);
--    the access token is not persisted at all in Phase A.
-- ============================================================
create table if not exists public.calendar_connection_secrets (
  connection_id             uuid primary key
                              references public.calendar_connections (id) on delete cascade,
  studio_id                 uuid not null,   -- carried for the same-studio composite FK

  -- AES-256-GCM ciphertext (versioned format, see lib/google-calendar/token-crypto.ts).
  encrypted_refresh_token   text,
  refresh_token_last4       text,            -- non-sensitive tail for owner UI recognition
  -- Which key encrypted this row's ciphertext (supports future key rotation).
  encryption_key_version    integer not null,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  -- Cross-studio attachment is structurally impossible: the (connection_id,
  -- studio_id) pair must resolve to a real (id, studio_id) on the parent.
  constraint calendar_connection_secrets_same_studio
    foreign key (connection_id, studio_id)
    references public.calendar_connections (id, studio_id) on delete cascade
);

alter table public.calendar_connection_secrets enable row level security;
-- Default-deny for browser roles: RLS enabled with ZERO policy. Belt-and-
-- suspenders explicit revoke so the ciphertext is unreachable via PostgREST.
revoke all on public.calendar_connection_secrets from anon;
revoke all on public.calendar_connection_secrets from authenticated;
revoke all on public.calendar_connection_secrets from public;
grant select, insert, update, delete on public.calendar_connection_secrets to service_role;
