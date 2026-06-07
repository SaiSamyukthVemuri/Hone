-- PR #164. Practitioner notification center foundation.
--
-- Chloe asked for an in-app notification surface so she can see
-- when new bookings, cancellations, and reschedules come in,
-- without depending on email/SMS delivery. This migration creates
-- the durable storage that the v1 notification helper writes to
-- and the practitioner /notifications page reads from.
--
-- This is INTENTIONALLY separate from public.ops_alerts:
--   * ops_alerts (migration 0067) = system/operator failures for
--     Sam (silent SMS give-ups, Stripe webhook signature mismatches,
--     manual fee retries, etc.). Owner-only severity model.
--   * practitioner_notifications (this table) = business events
--     for the practitioner workflow (new booking, cancel, reschedule).
--     Studio-member visibility.
--
-- v1 visibility decision is studio-wide. All authenticated studio
-- members can read every row for their studio. practitioner_id is
-- nullable + stored so a future PR can tighten to per-practitioner
-- filtering when a multi-practitioner studio (Laura) onboards,
-- without another migration.
--
-- The insert path is server-only via createAdminClient (see
-- lib/notifications/practitioner-notifications.ts). The select +
-- update path uses the authenticated RLS client (RLS policies
-- below). There is NO insert policy for studio members because
-- public booking / cancel / reschedule flows are anonymous visitor
-- or token-bearing routes and cannot satisfy an
-- is_studio_member(studio_id) check. The server-only helper bypasses
-- RLS via service_role; that is the deliberate trust boundary.

create table if not exists public.practitioner_notifications (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  -- Nullable: a notification may not have a single assigned
  -- practitioner (e.g. when the appointment's practitioner_id was
  -- null at insert time). Future per-practitioner filtering will
  -- read this column without a schema change.
  practitioner_id uuid references public.practitioners(id) on delete set null,
  -- Event type enum lives in the helper's allowlist
  -- (lib/notifications/practitioner-notifications.ts) rather than a
  -- DB CHECK. Pinning the list at the DB layer would force a
  -- migration every time the event set grows; the action-layer
  -- allowlist is sufficient because the only writer is the
  -- server-only helper with a fixed event_type union.
  event_type text not null,
  title text not null,
  body text,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  -- In-app deep-link (e.g. /calendar/<appointment_id>). The
  -- notification page renders each row as a link to this href; the
  -- helper composes it server-side so the public visitor cannot
  -- choose it.
  href text,
  -- read_at is set by the practitioner via the mark-all-read action
  -- (or a per-row mark-read in a future PR). Null = unread.
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Newest-first list of notifications per studio. Drives the
-- /notifications page query (order by created_at desc limit 100).
create index if not exists practitioner_notifications_studio_created_idx
  on public.practitioner_notifications (studio_id, created_at desc);

-- Per-practitioner index for the future filter ("show me only the
-- ones assigned to me"). Partial on practitioner_id is not null
-- keeps the index small while most rows are studio-wide today.
create index if not exists practitioner_notifications_practitioner_created_idx
  on public.practitioner_notifications (practitioner_id, created_at desc)
  where practitioner_id is not null;

-- Hot path: unread count + unread list. Partial on read_at is null
-- keeps the index narrow; the unread count + the badge query both
-- benefit.
create index if not exists practitioner_notifications_unread_idx
  on public.practitioner_notifications (studio_id, created_at desc)
  where read_at is null;

-- RLS.
alter table public.practitioner_notifications enable row level security;

-- Studio members can READ every notification for their studio.
drop policy if exists practitioner_notifications_member_read
  on public.practitioner_notifications;
create policy practitioner_notifications_member_read
  on public.practitioner_notifications
  for select
  to authenticated
  using (public.is_studio_member(studio_id));

-- Studio members can UPDATE the read_at field for notifications in
-- their studio. The policy gates BOTH the row being updated (USING)
-- and the row after the update (WITH CHECK) on the same studio
-- membership so a member cannot move a row across studios.
drop policy if exists practitioner_notifications_member_update
  on public.practitioner_notifications;
create policy practitioner_notifications_member_update
  on public.practitioner_notifications
  for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- DELIBERATELY NO insert policy for authenticated members. The
-- server-only helper writes via service_role (which bypasses RLS).
-- A future per-practitioner toggle could add a member-INSERT policy
-- for "create a manual reminder for myself"; not in v1.

-- Verification SQL (operator runs after deploy):
--
--   select table_name
--   from information_schema.tables
--   where table_schema = 'public'
--     and table_name = 'practitioner_notifications';
--   -- expect: one row.
--
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'practitioner_notifications'
--   order by ordinal_position;
--   -- expect: 11 columns in the order declared above.
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename = 'practitioner_notifications'
--   order by indexname;
--   -- expect: 3 secondary indexes + the implicit pkey index.
--
--   select relname, relrowsecurity
--   from pg_class
--   where relname = 'practitioner_notifications';
--   -- expect: relrowsecurity = true.
--
--   select policyname, cmd, roles, qual, with_check
--   from pg_policies
--   where schemaname = 'public'
--     and tablename = 'practitioner_notifications'
--   order by policyname;
--   -- expect: practitioner_notifications_member_read (SELECT) +
--   --         practitioner_notifications_member_update (UPDATE).
--   -- NO INSERT policy by design.
--
--   select
--     count(*)                                       as total,
--     count(*) filter (where read_at is null)        as unread
--   from public.practitioner_notifications;
--   -- expect immediately after deploy: total = 0, unread = 0.
