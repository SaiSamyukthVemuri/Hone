-- Migration 0113: admin_action_events — append-only operator/admin action audit log.
--
-- Production infrastructure (NOT a client feature). Records sensitive
-- admin/operator actions — especially the service-role, cross-studio writes
-- reachable from /admin — so we can answer who did what, to which studio /
-- resource, when, and with what outcome.
--
-- Access model (deliberately different from the studio-scoped audit tables):
--   * The /admin surface is authorized at the APP layer by the ADMIN_EMAILS
--     allowlist (lib/admin.ts isAdmin); there is NO is_admin() SQL function, and
--     an operator is NOT a studio_member of the studios they act on. So RLS
--     cannot express "admins may read." Instead:
--       - RLS is ENABLED with **NO policies at all** — every normal
--         authenticated user (and anon) is denied SELECT/INSERT/UPDATE/DELETE.
--       - Writes AND reads happen ONLY through the service-role client, and only
--         from server code that has already passed the isAdmin gate
--         (lib/audit/admin-actions.ts). This mirrors how /admin already reads
--         ops_alerts and the payment manual-review queue.
--   * Append-only: no UPDATE/DELETE path for anyone but the service role; write
--     grants are revoked from authenticated + anon (belt-and-suspenders).
--
-- Durability over referential integrity (audit posture): studio_id and
-- actor_user_id are plain uuids with **no foreign key** — an audit event must
-- survive deletion of the studio/user it references (and must never block such
-- a delete), and it keeps the raw id for forensics. target_id is free text
-- (polymorphic: a studio id, an ops_alert id, a demo_request id, ...).
--
-- Privacy: the table has NO column for any token, secret, card, password, URL,
-- cookie, authorization header, or clinical/intake/payment detail. actor_email
-- holds only the OPERATOR's own email (an internal ADMIN_EMAILS address, already
-- known to admins). metadata is an allowlisted + redacted jsonb bag (numbers /
-- booleans / short safe strings only), sanitized by the app helper before insert.
--
-- Additive only; no backfill; re-runnable.

create table if not exists public.admin_action_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,              -- auth.users id of the operator (no FK: durable)
  actor_email text,               -- operator email (internal ADMIN_EMAILS address)
  actor_role text,                -- e.g. 'admin' / 'operator'
  studio_id uuid,                 -- affected studio, if any (no FK: durable, cross-studio)
  target_type text not null,      -- 'studio' | 'ops_alert' | 'demo_request' | ...
  target_id text,                 -- polymorphic id of the affected resource
  action text not null,           -- 'studio_created' | 'ops_alert_resolved' | ...
  outcome text not null
    check (outcome in ('started', 'succeeded', 'failed', 'blocked')),
  source text not null default 'admin',
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_action_events_created_idx
  on public.admin_action_events (created_at desc);
create index if not exists admin_action_events_studio_idx
  on public.admin_action_events (studio_id, created_at desc);
create index if not exists admin_action_events_action_idx
  on public.admin_action_events (action, created_at desc);
create index if not exists admin_action_events_actor_idx
  on public.admin_action_events (actor_user_id, created_at desc);

alter table public.admin_action_events enable row level security;

-- Deliberately NO policies: normal authenticated users and anon can do nothing
-- with this table. All access is via the service-role client from the isAdmin-
-- gated /admin server code. Append-only + operator-only by construction.

-- Belt-and-suspenders: strip write grants from normal roles (RLS already denies
-- them; this makes the append-only, service-role-only intent explicit).
revoke insert, update, delete, truncate
  on public.admin_action_events from authenticated, anon;
