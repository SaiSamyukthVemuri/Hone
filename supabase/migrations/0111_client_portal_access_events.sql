-- Migration 0111: client_portal_access_events — practitioner-visible portal
-- send/access event log (Portal Access PR 3).
--
-- Purpose: give practitioners a simple, studio-scoped view of portal activity
-- for a client (link sent, sign-in). Modeled on 0086 record_keeping_audit_events:
--   * RLS enabled with a SINGLE studio-scoped SELECT policy;
--   * NO insert / update / delete / for-all policy for authenticated users, so
--     the trail is append-only and un-forgeable for every normal app user;
--   * rows are inserted ONLY by the app's service-role paths (the practitioner
--     "Send portal link" action and the portal magic-link verify), each of which
--     already establishes the studio + client scope. There are no DB triggers.
--
-- PRIVACY / SECURITY rules (enforced by column shape + the app insert helper):
--   * NEVER stores a raw portal token, a raw magic-link URL, an IP address, a
--     user-agent, an email address, or any clinical / intake / payment detail.
--     There is simply no column for any of those — only ids, an event_type, an
--     optional channel, and an allowlisted metadata jsonb (numbers/short codes).
--   * Token generation / hashing / TTL / verify behavior are untouched; this
--     table records only that an event happened, never any secret.
--
-- Tenant isolation: a COMPOSITE same-studio foreign key (studio_id, client_id)
-- -> clients (studio_id, id) (the 0094 pattern) makes a cross-tenant event row
-- impossible at the database layer, even if app code passed a mismatched pair.
--
-- Additive only; no backfill; no payment/auth tables; re-runnable throughout.

create table if not exists public.client_portal_access_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  client_id uuid not null,
  practitioner_id uuid
    references public.practitioners(id) on delete set null,
  event_type text not null
    check (event_type in (
      'portal_link_sent',
      'portal_link_rate_limited',
      'portal_login_requested',
      'portal_magic_link_consumed',
      'portal_session_seen'
    )),
  channel text
    check (channel is null or channel in (
      'email',
      'copy_url',
      'portal_message',
      'appointment_email'
    )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Same-studio composite FK: the event's client must belong to the event's
  -- studio. Deleting the client cascades its events away.
  constraint client_portal_access_events_client_same_studio_fk
    foreign key (studio_id, client_id)
    references public.clients (studio_id, id) on delete cascade
);

create index if not exists client_portal_access_events_client_idx
  on public.client_portal_access_events (studio_id, client_id, created_at desc);
create index if not exists client_portal_access_events_studio_idx
  on public.client_portal_access_events (studio_id, created_at desc);

alter table public.client_portal_access_events enable row level security;

-- SELECT only. Deliberately NO insert/update/delete/for-all policy: normal
-- authenticated users can read their own studio's portal events and can never
-- write to them. Inserts happen only through the app's service-role paths.
drop policy if exists "client_portal_access_events: members select"
  on public.client_portal_access_events;
create policy "client_portal_access_events: members select"
  on public.client_portal_access_events for select to authenticated
  using (public.is_studio_member(studio_id));

-- Defense in depth: strip write grants from normal roles (RLS already blocks
-- them; this makes the append-only intent explicit and belt-and-suspenders).
revoke insert, update, delete, truncate
  on public.client_portal_access_events from authenticated, anon;
