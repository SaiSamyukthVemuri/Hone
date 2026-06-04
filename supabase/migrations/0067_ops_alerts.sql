-- ===========================================================================
-- Migration 0067: ops_alerts table for observability and silent-failure alerting.
-- ===========================================================================
--
-- What this migration does
-- ------------------------
-- Adds an append-only ops_alerts table that the application uses to
-- record durable alert rows for operator-facing failures: manual fee
-- pending/manual-review, Stripe webhook processing failures, card-
-- on-file setup failures, email/SMS give-up, cron route failure. The
-- application's recordOpsAlert helper (PR #153) inserts via the
-- service-role admin client; studio members (owners) read alerts
-- scoped to their studio via RLS.
--
-- What this migration does NOT do
-- -------------------------------
-- * No new RPC. The insert is a plain INSERT from server actions /
--   webhook / cron with the admin client.
-- * No alert UI. SQL/runbook only for this PR; a future PR may add
--   /admin/ops-alerts.
-- * No payment / Stripe / live-mode / SMS / email send-behavior
--   change. This is observability only.
--
-- Strictly additive + idempotent. Applied to prod via
-- `supabase db push --linked` BEFORE merging code that writes to
-- the new table.
-- ===========================================================================

-- --------------------------------------------------------------------
-- 1) Table
-- --------------------------------------------------------------------

create table if not exists public.ops_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  severity text not null,
  event text not null,
  message text not null,
  -- Studio scoping. NULL when the failure is studio-agnostic
  -- (e.g. a webhook event that arrived before lineage was
  -- resolved). The default RLS read policy uses
  -- is_studio_member(studio_id), so NULL-studio rows are not
  -- readable by any practitioner; they remain visible only to
  -- service-role queries (the operator dashboard).
  studio_id uuid references public.studios(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  -- Free-text Stripe identifiers. Not FKed because stripe_events
  -- and stripe_charge_attempts are 0032's dormant chain and we
  -- want ops_alerts to record references even when the matching
  -- 0032 row does not exist (the manual-fee path uses
  -- manual_fee_charge_attempts, not stripe_charge_attempts).
  stripe_event_id text,
  stripe_payment_intent_id text,
  manual_fee_attempt_id uuid
    references public.manual_fee_charge_attempts(id) on delete set null,
  route text,
  safe_details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  resolution_note text
);

-- --------------------------------------------------------------------
-- 2) CHECKs
-- --------------------------------------------------------------------

alter table public.ops_alerts
  drop constraint if exists ops_alerts_severity_check;
alter table public.ops_alerts
  add constraint ops_alerts_severity_check
  check (severity in ('info', 'warning', 'critical'));

alter table public.ops_alerts
  drop constraint if exists ops_alerts_event_length_check;
alter table public.ops_alerts
  add constraint ops_alerts_event_length_check
  check (char_length(event) between 1 and 100);

alter table public.ops_alerts
  drop constraint if exists ops_alerts_message_length_check;
alter table public.ops_alerts
  add constraint ops_alerts_message_length_check
  check (char_length(message) between 1 and 2000);

alter table public.ops_alerts
  drop constraint if exists ops_alerts_resolution_note_length_check;
alter table public.ops_alerts
  add constraint ops_alerts_resolution_note_length_check
  check (resolution_note is null or char_length(resolution_note) <= 2000);

alter table public.ops_alerts
  drop constraint if exists ops_alerts_resolved_consistency_check;
alter table public.ops_alerts
  add constraint ops_alerts_resolved_consistency_check
  check (
    (resolved_at is null and resolved_by_practitioner_id is null
     and resolution_note is null)
    or
    (resolved_at is not null)
  );

-- --------------------------------------------------------------------
-- 3) Indexes
-- --------------------------------------------------------------------

create index if not exists ops_alerts_studio_created_idx
  on public.ops_alerts (studio_id, created_at desc);

create index if not exists ops_alerts_event_created_idx
  on public.ops_alerts (event, created_at desc);

create index if not exists ops_alerts_severity_created_idx
  on public.ops_alerts (severity, created_at desc);

-- "Open alerts only" partial index for the operator dashboard query.
-- Matches `WHERE resolved_at IS NULL` so the unresolved-only fetch
-- can stay fast as the table grows.
create index if not exists ops_alerts_open_idx
  on public.ops_alerts (created_at desc)
  where resolved_at is null;

-- --------------------------------------------------------------------
-- 4) RLS
-- --------------------------------------------------------------------
-- Posture (PR #153):
--   * Studio members SELECT alerts scoped to their studio. NULL-
--     studio rows are not visible to any practitioner; only the
--     operator (Sam) queries those via service-role SQL.
--   * Service-role writes only. The recordOpsAlert helper uses
--     createAdminClient() exclusively; the helper file is server-
--     only.
--   * No DELETE policy. Soft-resolve via resolved_at + resolution_note
--     is the only retirement path.

alter table public.ops_alerts enable row level security;

drop policy if exists "ops_alerts_member_read" on public.ops_alerts;
create policy "ops_alerts_member_read"
  on public.ops_alerts
  for select
  using (
    studio_id is not null
    and public.is_studio_member(studio_id)
  );

-- Inserts and resolves happen via service-role; no authenticated
-- INSERT/UPDATE policy is granted.
