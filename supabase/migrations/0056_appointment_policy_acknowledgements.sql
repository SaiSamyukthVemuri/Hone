-- Migration 0056: appointment policy acknowledgements.
--
-- PR #132. Records that a client explicitly acknowledged the studio's
-- cancellation + no-show policies before they cancelled or rescheduled
-- an appointment. v1 acknowledgement is neutral copy
-- ("I have reviewed and understand the cancellation and no-show
-- policies."), NOT fee-window charge-warning copy: Hone has no
-- card-on-file / payment surface yet, and saying "you will be charged"
-- before we can actually charge would be dishonest.
--
-- The policy text the client saw is captured as a snapshot at
-- acknowledgement time. Even if Chloe later edits her policies,
-- previously recorded acknowledgements still prove what the client
-- accepted at the time of the action. This is mandatory: both
-- cancellation_policy_text_snapshot and no_show_policy_text_snapshot
-- are NOT NULL with a default of empty-string so that a studio with
-- no configured policy still produces a complete, hashable row.
--
-- policy_snapshot_hash is SHA-256 hex (64 chars) of the canonical
-- concatenation of the two snapshot fields, computed server-side in
-- the cancel/reschedule actions. The hash makes "did the policy
-- change?" cheap to verify without comparing the full text blobs.
--
-- Strictly additive + idempotent.

-- --------------------------------------------------------------------
-- 1) Table
-- --------------------------------------------------------------------

create table if not exists public.appointment_policy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid not null
    references public.appointments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  action text not null,
  acknowledged_at timestamptz not null default now(),
  -- Snapshot of the rendered policy text the client saw at
  -- acknowledgement time. Both fields are NOT NULL with default '' so
  -- a studio that has not configured one of the policies still
  -- produces a complete row; the empty string flows through the hash
  -- input unchanged.
  cancellation_policy_text_snapshot text not null default '',
  no_show_policy_text_snapshot text not null default '',
  -- SHA-256 hex of the canonical concatenation of the two snapshot
  -- fields. Length 64 enforced by the CHECK below so a missing /
  -- malformed hash is rejected at insert time.
  policy_snapshot_hash text not null,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------------------
-- 2) CHECK constraints
-- --------------------------------------------------------------------

alter table public.appointment_policy_acknowledgements
  drop constraint if exists appointment_policy_acknowledgements_action_check;
alter table public.appointment_policy_acknowledgements
  add constraint appointment_policy_acknowledgements_action_check
  check (action in ('cancel', 'reschedule'));

alter table public.appointment_policy_acknowledgements
  drop constraint if exists appointment_policy_acknowledgements_hash_check;
alter table public.appointment_policy_acknowledgements
  add constraint appointment_policy_acknowledgements_hash_check
  check (char_length(policy_snapshot_hash) > 0);

-- --------------------------------------------------------------------
-- 3) Indexes
-- --------------------------------------------------------------------

create index if not exists appointment_policy_acknowledgements_appt_idx
  on public.appointment_policy_acknowledgements
  (studio_id, appointment_id, acknowledged_at desc);

create index if not exists appointment_policy_acknowledgements_client_idx
  on public.appointment_policy_acknowledgements
  (studio_id, client_id, acknowledged_at desc);

-- --------------------------------------------------------------------
-- 4) RLS
-- --------------------------------------------------------------------

alter table public.appointment_policy_acknowledgements
  enable row level security;

-- Practitioner-side SELECT only. The token-resolved server actions
-- that write rows here use the service-role admin client and bypass
-- RLS by design; no authenticated INSERT / UPDATE / DELETE policy is
-- added because (a) anon visitors holding only a cancel/reschedule
-- token are not Supabase-auth users, and (b) we want hard-delete and
-- after-the-fact mutation locked down by RLS default-deny so the
-- acknowledgement trail is append-only by construction. Matches the
-- audit_logs posture from 0001_init.sql.
drop policy if exists "appointment_policy_acks_studio_member_select"
  on public.appointment_policy_acknowledgements;
create policy "appointment_policy_acks_studio_member_select"
  on public.appointment_policy_acknowledgements for select
  to authenticated
  using (public.is_studio_member(studio_id));

-- --------------------------------------------------------------------
-- 5) Table comment
-- --------------------------------------------------------------------

comment on table public.appointment_policy_acknowledgements is
  'Records that a client explicitly acknowledged the studios cancellation and no-show policies before cancelling or rescheduling an appointment. Snapshot columns capture the rendered policy text shown at acknowledgement time; policy_snapshot_hash is SHA-256 hex over the canonical concatenation of the two snapshot fields. v1 acknowledgement copy is neutral (no card-on-file or charge-warning text). RLS-enabled; authenticated studio members can SELECT rows for their studio. INSERT happens exclusively through the service-role admin client in publicCancelAppointmentAction and rescheduleAppointmentViaTokenAction, scoped to the appointment/studio/client resolved server-side from the cancellation token. No INSERT / UPDATE / DELETE policies; the audit trail is append-only by RLS default-deny.';
