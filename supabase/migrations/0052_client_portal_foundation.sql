-- Migration 0052: secure client portal foundation.
--
-- Adds two tables that back the email-magic-link sign-in flow for the
-- new /portal surface. Strictly additive: no existing column, table,
-- or index is touched. Idempotent: re-running this migration is a
-- no-op (every CREATE uses IF NOT EXISTS; constraints are dropped-if-
-- exists before being added).
--
-- Why two tables (not one):
--   client_portal_magic_links is the short-lived single-use entry
--   credential the client receives by email; rows are created during
--   the login request, consumed on the /portal/verify/[token] hit,
--   and never re-used.
--   client_portal_sessions is the longer-lived authenticated session
--   that a successful magic-link verification creates; the session
--   cookie carries an opaque random token whose SHA-256 hash is the
--   only thing this table stores. Server-side revocation
--   (revoked_at) is the reason to keep these in the DB rather than
--   in a signed cookie payload.
--
-- Security posture:
--   * Raw tokens are NEVER written to either table. Both columns are
--     token_hash text NOT NULL UNIQUE, populated with the lowercase
--     hex of SHA-256(raw_token). The raw token only ever exists in
--     transit (magic link URL parameter; session cookie value) and
--     in the email message body.
--   * RLS is enabled on both tables with NO policies. The only
--     callers are server actions running through the service-role
--     admin client; RLS-on + no-policies is a defense-in-depth
--     ceiling so any future user-scoped Supabase client that
--     accidentally targets these tables gets zero rows rather than
--     leaking session metadata.
--   * Both tables are referenced by studio_id + client_id so the
--     same email matching multiple active clients across studios can
--     produce one magic link per studio without collisions.
--   * created_ip_hash / user_agent_hash columns are nullable text;
--     callers populate them with hashed fingerprints (never raw IP /
--     UA) for audit and abuse triage.
--
-- What this migration does NOT do:
--   * No practitioner auth changes. The existing Supabase auth user
--     model is unchanged; portal sessions live alongside it as a
--     separate, parallel concept.
--   * No SMS schema changes.
--   * No public booking, intake, treatment plan, or calendar table
--     changes.

-- --------------------------------------------------------------------
-- 1) client_portal_magic_links
-- --------------------------------------------------------------------

create table if not exists public.client_portal_magic_links (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- SHA-256 hex of the raw magic-link token. Never store the raw
  -- token here; the email body and the URL path parameter are the
  -- only two places the raw token ever exists.
  token_hash text not null,
  -- The normalized email at request time (the same lower(trim(email))
  -- shape clients.normalized_email uses). Stored so an operator can
  -- correlate a verify hit back to the request without re-hashing.
  email_normalized text not null,
  -- 30-minute TTL is enforced at the application layer via
  -- created_at + interval; expires_at is also stored so the lookup
  -- and the cleanup index can both rely on a single column.
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  created_ip_hash text,
  user_agent_hash text
);

-- Unique on hash so a token can only ever exist once across all
-- magic-link rows. A collision is cryptographically impossible at
-- 32-byte entropy, but the unique constraint is the belt-and-braces
-- guarantee.
alter table public.client_portal_magic_links
  drop constraint if exists client_portal_magic_links_token_hash_uniq;
alter table public.client_portal_magic_links
  add constraint client_portal_magic_links_token_hash_uniq
  unique (token_hash);

create index if not exists client_portal_magic_links_client_idx
  on public.client_portal_magic_links (client_id, created_at desc);

create index if not exists client_portal_magic_links_studio_email_idx
  on public.client_portal_magic_links (studio_id, email_normalized, created_at desc);

create index if not exists client_portal_magic_links_expires_idx
  on public.client_portal_magic_links (expires_at);

alter table public.client_portal_magic_links enable row level security;

comment on table public.client_portal_magic_links is
  'Short-lived single-use email magic links for the client portal. Raw tokens are never stored; only token_hash (SHA-256 hex). RLS is enabled with no policies so user-scoped clients see zero rows; only the service-role admin client should write or read these.';

-- --------------------------------------------------------------------
-- 2) client_portal_sessions
-- --------------------------------------------------------------------

create table if not exists public.client_portal_sessions (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  -- SHA-256 hex of the raw session token. The session cookie value
  -- is the raw token; the DB stores only the hash. Server-side
  -- lookups re-hash the incoming cookie value before SELECT.
  session_token_hash text not null,
  -- 7-day TTL by application convention; the DB column lets a future
  -- caller shorten that without a schema change.
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

alter table public.client_portal_sessions
  drop constraint if exists client_portal_sessions_token_hash_uniq;
alter table public.client_portal_sessions
  add constraint client_portal_sessions_token_hash_uniq
  unique (session_token_hash);

create index if not exists client_portal_sessions_client_idx
  on public.client_portal_sessions (client_id, created_at desc);

create index if not exists client_portal_sessions_expires_idx
  on public.client_portal_sessions (expires_at);

alter table public.client_portal_sessions enable row level security;

comment on table public.client_portal_sessions is
  'Server-side client portal sessions backing the httpOnly hone_portal_session cookie. Raw cookie tokens are never stored; only session_token_hash (SHA-256 hex). Revocation is supported via revoked_at. RLS is enabled with no policies so user-scoped clients see zero rows; only the service-role admin client should write or read these.';
