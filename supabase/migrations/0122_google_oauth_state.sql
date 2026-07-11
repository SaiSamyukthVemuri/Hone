-- ---------------------------------------------------------------------------
-- Google Calendar Two-Way Sync — Phase A. Migration 2 of 2: OAuth state + PKCE.
--
-- public.google_oauth_states holds the single-use, short-lived server-minted
-- binding for one in-flight OAuth authorization-code flow. It exists so the
-- callback can prove the returning request belongs to the exact authenticated
-- practitioner + studio + browser session that started it, and cannot be
-- replayed or stitched across users/studios.
--
-- Security posture (same default-deny as calendar_connection_secrets):
--   * state stored HASH-ONLY (sha256 hex) — a leaked DB row can't be replayed
--     as a valid `state` value (the 0116 hash-only spirit).
--   * the session nonce is stored HASH-ONLY too; the raw nonce lives only in an
--     httpOnly cookie set at start and is hash-compared at callback (double
--     submit / CSRF binding).
--   * the PKCE code_verifier IS encrypted (not hashed): it must be REPLAYED to
--     Google at token exchange, so it is stored as AES-256-GCM ciphertext under
--     the same dedicated key + version as the refresh token.
--   * single-use: consumed_at is set with a compare-and-swap; a second callback
--     with the same state finds consumed_at already set and is rejected.
--   * 10-minute TTL (expires_at); expired/consumed rows are rejected and swept.
--   * RLS on + NO browser-role policy + explicit REVOKE — no anon/authenticated
--     role can read the verifier ciphertext or any binding column.
--
-- Additive + dormant: no deployed code reads this table until the Phase A OAuth
-- code ships and a studio turns google_calendar_connection_enabled on.
-- Prod migration max after 0121 is 0121; this is 0122.
-- ---------------------------------------------------------------------------

create table if not exists public.google_oauth_states (
  id                     uuid primary key default gen_random_uuid(),

  -- sha256 hex of the CSPRNG `state` value sent to Google (hash-only at rest).
  state_hash             text not null
                           check (state_hash ~ '^[a-f0-9]{64}$'),
  -- sha256 hex of the per-flow nonce; raw nonce is an httpOnly cookie only.
  session_nonce_hash     text not null
                           check (session_nonce_hash ~ '^[a-f0-9]{64}$'),

  -- Binding: the exact authenticated identity that STARTED the flow.
  studio_id              uuid not null references public.studios (id) on delete cascade,
  practitioner_id        uuid not null,
  user_id                uuid not null references auth.users (id) on delete cascade,

  -- PKCE verifier, encrypted (replayed to Google; cannot be hashed).
  encrypted_pkce_verifier text not null,
  encryption_key_version  integer not null,

  -- Allow-listed post-callback return path (validated at start + consume; never
  -- an arbitrary/external URL). Nullable → defaults to /settings/profile.
  redirect_path          text,

  expires_at             timestamptz not null default (now() + interval '10 minutes'),
  consumed_at            timestamptz,
  created_at             timestamptz not null default now(),

  -- Same-studio integrity for the practitioner binding (0094 pattern).
  constraint google_oauth_states_practitioner_same_studio
    foreign key (practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete cascade
);

-- One row per state value; the callback looks up by state_hash.
create unique index if not exists google_oauth_states_state_hash_uniq
  on public.google_oauth_states (state_hash);

-- Expiry sweep support.
create index if not exists google_oauth_states_expiry_idx
  on public.google_oauth_states (expires_at);

alter table public.google_oauth_states enable row level security;
-- Default-deny for browser roles (RLS on + zero policy + explicit revoke).
-- Only the service-role OAuth start/callback paths read or write it.
revoke all on public.google_oauth_states from anon;
revoke all on public.google_oauth_states from authenticated;
revoke all on public.google_oauth_states from public;
grant select, insert, update, delete on public.google_oauth_states to service_role;
