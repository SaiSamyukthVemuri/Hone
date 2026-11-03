-- 0287 — ROLES R1 (HELD): the permission engine.
--
-- One database resolver decides what a person may do. `has_studio_permission` (enforcement), `effective_access` (the owner's
-- "View access" panel) and every preview call the SAME function, so the page cannot drift from enforcement. The catalog values are
-- seeded from lib/permissions/catalog.ts; tests/db/permission-engine.db.test.ts and tests/migrations/0287-*.test.ts compare the two.
--
-- Decided by Sam (3 Nov 2026, ROLES-DECISIONS-LOG groups 1-7, batches 1-4 and the batch 4 clarification):
--   * an existing studio keeps today's access until its owner explicitly adopts the new defaults; a missing row resolves to the
--     studio's own basis, never to a new default;
--   * a reason is REQUIRED to adopt defaults, reset a role, or expand SENSITIVE access (including widening its scope); the database
--     rejects blank and placeholder-only text and offers no length constant as proof; otherwise a reason is optional; the before and
--     after are always recorded;
--   * an `own` client scope reads the CURRENT appointment assignment on every request;
--   * a permission switch only records a choice: it never charges, sends, deletes or activates anything.
--
-- Receptionists are `studio_receptionists` rows (0216), never `practitioners`. Nothing here activates the desk, invites anyone or
-- changes an existing policy. Additive: new tables and functions, one AFTER INSERT trigger on studios that records a NEW studio's basis.
-- HELD: not applied anywhere. Hosted state is untouched.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1) Tables. RLS is on with NO policies and every table privilege is revoked by name: the commands below are the only path.
-- ---------------------------------------------------------------------------
create table public.permission_catalog (
  key                   text primary key,
  scopes                text[] not null,
  own_kind              text check (own_kind in ('appointment', 'client', 'practitioner')),
  offered_practitioner  boolean not null,
  offered_receptionist  boolean not null,
  owner_configurable    boolean not null,
  requires              text[] not null default '{}',
  new_practitioner      text not null check (new_practitioner in ('off', 'own', 'studio')),
  new_receptionist      text not null check (new_receptionist in ('off', 'own', 'studio')),
  snapshot_practitioner text not null check (snapshot_practitioner in ('off', 'own', 'studio')),
  snapshot_receptionist text not null check (snapshot_receptionist in ('off', 'own', 'studio')),
  gate_practitioner     text,
  gate_receptionist     text,
  sensitive             boolean not null default false,
  -- Informational, for the Roles page: what kind of consequence the key carries. The reason RULE keys off `sensitive` only.
  consequence           text check (consequence in ('financial', 'sensitive', 'destructive'))
);

create table public.permission_narrowings (
  id               text primary key,
  decision         text not null,
  label            text not null,
  stage            text not null,
  narrows_existing boolean not null,
  notice           text not null
);

create table public.studio_permission_policy (
  studio_id  uuid primary key references public.studios(id) on delete cascade,
  basis      text not null check (basis in ('existing_snapshot', 'new_studio')),
  version    bigint not null default 0 check (version >= 0),
  adopted_at timestamptz
);

create table public.studio_role_permissions (
  studio_id uuid not null references public.studios(id) on delete cascade,
  role      text not null check (role in ('practitioner', 'receptionist')),
  key       text not null references public.permission_catalog(key),
  scope     text not null check (scope in ('off', 'own', 'studio')),
  primary key (studio_id, role, key)
);

-- Operator-only. No function below writes it; an owner cannot read or change it. An absent row is NOT satisfied (fail closed).
create table public.permission_ship_gates (
  studio_id uuid not null references public.studios(id) on delete cascade,
  gate      text not null,
  met       boolean not null default false,
  primary key (studio_id, gate)
);

-- Append-only history. IDs only: no emails, no secrets. Names are resolved at read time from current rows. There is deliberately no
-- foreign key to studios, so a studio's history is never cascaded away.
create table public.permission_audit (
  id                    bigint generated always as identity primary key,
  studio_id             uuid not null,
  at                    timestamptz not null default now(),
  actor_user_id         uuid,
  actor_membership_id   uuid,
  kind                  text not null check (kind in ('role_permissions_saved', 'defaults_adopted', 'role_reset', 'staff_role_changed')),
  role                  text,
  membership_id         uuid,
  membership_kind       text check (membership_kind in ('practitioner', 'receptionist')),
  before                jsonb not null,
  after                 jsonb not null,
  reason                text,
  policy_version_before bigint,
  policy_version_after  bigint
);
create index permission_audit_studio_idx on public.permission_audit (studio_id, id desc);

create or replace function public.permission_audit_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'permission_audit_is_append_only' using errcode = '55000';
end;
$$;

create trigger permission_audit_no_update_delete
  before update or delete on public.permission_audit
  for each row execute function public.permission_audit_append_only();
create trigger permission_audit_no_truncate
  before truncate on public.permission_audit
  for each statement execute function public.permission_audit_append_only();

alter table public.permission_catalog enable row level security;
alter table public.permission_narrowings enable row level security;
alter table public.studio_permission_policy enable row level security;
alter table public.studio_role_permissions enable row level security;
alter table public.permission_ship_gates enable row level security;
alter table public.permission_audit enable row level security;

revoke all on public.permission_catalog from public, anon, authenticated, service_role;
revoke all on public.permission_narrowings from public, anon, authenticated, service_role;
revoke all on public.studio_permission_policy from public, anon, authenticated, service_role;
revoke all on public.studio_role_permissions from public, anon, authenticated, service_role;
revoke all on public.permission_ship_gates from public, anon, authenticated, service_role;
revoke all on public.permission_audit from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Catalog seed (generated from lib/permissions/catalog.ts; a test compares the two).
-- ---------------------------------------------------------------------------
insert into public.permission_catalog
  (key, scopes, own_kind, offered_practitioner, offered_receptionist, owner_configurable, requires, new_practitioner, new_receptionist, snapshot_practitioner, snapshot_receptionist, gate_practitioner, gate_receptionist, sensitive, consequence)
values
  ('appt.view_calendar', array['off', 'studio']::text[], null, true, true, false, '{}'::text[], 'studio', 'studio', 'studio', 'studio', null, null, false, null),
  ('client.view_directory', array['off', 'studio']::text[], null, true, true, false, array['appt.view_calendar']::text[], 'studio', 'studio', 'studio', 'off', null, null, false, null),
  ('appt.book', array['off', 'own', 'studio']::text[], 'practitioner', true, true, true, array['appt.view_calendar']::text[], 'own', 'studio', 'own', 'off', null, null, false, null),
  ('appt.move', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'own', 'studio', 'own', 'off', null, null, false, null),
  ('appt.reassign', array['off', 'studio']::text[], null, true, true, true, array['appt.move']::text[], 'off', 'studio', 'off', 'off', null, null, false, null),
  ('appt.handoff_own', array['off', 'studio']::text[], null, true, false, true, array['appt.view_calendar']::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('appt.cancel', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'studio', 'studio', 'studio', 'off', null, null, false, null),
  ('appt.mark_no_show', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'studio', 'studio', 'studio', 'off', null, null, false, null),
  ('appt.edit_notes', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'studio', 'studio', 'studio', 'off', null, 'receptionist_scheduling_notes', false, null),
  ('appt.complete', array['off', 'own', 'studio']::text[], 'appointment', true, false, true, array['appt.view_calendar', 'clin.view_records']::text[], 'own', 'off', 'own', 'off', 'practitioner_completion', null, false, null),
  ('appt.aftercare_send', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('avail.manage_own', array['off', 'studio']::text[], null, true, false, true, '{}'::text[], 'studio', 'off', 'off', 'off', null, null, false, null),
  ('avail.manage_others', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('avail.manage_studio_hours', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('client.create', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'studio', 'studio', 'studio', 'off', null, null, false, null),
  ('client.edit_contact', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'studio', 'studio', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_legal_name', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'studio', 'off', 'studio', 'off', null, 'receptionist_legal_name', true, 'sensitive'),
  ('client.edit_legal_name', array['off', 'studio']::text[], null, true, true, true, array['client.view_legal_name']::text[], 'studio', 'off', 'studio', 'off', 'practitioner_legal_name_edit', 'receptionist_legal_name', true, 'sensitive'),
  ('client.merge', array['off', 'studio']::text[], null, true, true, true, array['client.edit_contact', 'client.view_legal_name']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('client.import', array['off', 'studio']::text[], null, true, true, true, array['client.create']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('clin.view_records', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.edit_records', array['off', 'studio']::text[], null, true, false, true, array['clin.view_records']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.view_photos', array['off', 'studio']::text[], null, true, true, true, array['client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.upload_photos', array['off', 'studio']::text[], null, true, false, true, array['clin.view_photos']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.view_intake', array['off', 'studio']::text[], null, true, true, true, array['client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.view_aftercare', array['off', 'studio']::text[], null, true, true, true, array['client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.view_intake_status', array['off', 'studio']::text[], null, true, true, true, array['client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('clin.edit_intake', array['off', 'studio']::text[], null, true, false, true, array['clin.view_intake']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.review_intake', array['off', 'studio']::text[], null, true, false, true, array['clin.view_intake']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.print_record', array['off', 'studio']::text[], null, true, false, true, array['clin.view_records']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('clin.edit_consent_templates', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('comm.send_routine', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'studio', 'studio', 'studio', 'off', null, null, false, null),
  ('comm.send_intake_link', array['off', 'studio']::text[], null, true, true, true, array['comm.send_routine', 'clin.view_intake_status']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('comm.send_portal_link', array['off', 'studio']::text[], null, true, true, true, array['comm.send_routine']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('comm.send_portal_reply', array['off', 'own', 'studio']::text[], 'client', true, true, true, array['comm.send_routine', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('comm.bulk_message', array['off', 'studio']::text[], null, true, true, true, array['comm.send_routine', 'client.view_directory']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('pay.view_appointment', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['appt.view_calendar']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('pay.record_external', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('pay.charge_saved_card', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('pay.refund', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('pay.void', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('pay.correct_or_waive', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('price.appointment', array['off', 'own', 'studio']::text[], 'appointment', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('price.view_client_prices', array['off', 'own', 'studio']::text[], 'client', true, true, true, array['pay.view_appointment']::text[], 'own', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('price.service_list', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'studio', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('price.fee_amounts', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'studio', 'studio', 'off', 'off', null, 'receptionist_finance', true, 'financial'),
  ('rep.studio_totals', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('rep.financial_reports', array['off', 'studio']::text[], null, true, true, true, array['pay.view_appointment']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('rep.lifetime_spend', array['off', 'studio']::text[], null, true, true, true, array['pay.view_appointment']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('rep.bulk_export', array['off', 'studio']::text[], null, true, true, true, array['client.view_directory']::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('rep.audit_log_view', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, true, 'sensitive'),
  ('wl.view_queue', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.add_entry', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.import_entry', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.withdraw_entry', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.manage_queue', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.expire_close', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.offer_booking', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.set_availability', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wl.record_sms_consent', array['off', 'studio']::text[], null, true, true, true, array['wl.view_queue']::text[], 'off', 'studio', 'off', 'off', null, 'receptionist_waitlist', true, 'sensitive'),
  ('wlrules.invitation_rounds', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('wlrules.policy_and_text', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('admit.change_policy', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('admit.booking_rules', array['off', 'studio']::text[], null, true, true, true, '{}'::text[], 'off', 'off', 'off', 'off', null, null, false, null),
  ('price.edit_client_prices', array['off', 'studio']::text[], null, true, true, true, array['price.view_client_prices']::text[], 'off', 'off', 'off', 'off', null, null, true, 'financial'),
  ('client.view_dob_address', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_dob_address', array['off', 'studio']::text[], null, true, false, true, array['client.view_dob_address']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_allergies_cautions', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_allergies_cautions', array['off', 'studio']::text[], null, true, false, true, array['client.view_allergies_cautions']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_budget', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_budget', array['off', 'studio']::text[], null, true, false, true, array['client.view_budget']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_personal_notes', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_personal_notes', array['off', 'studio']::text[], null, true, false, true, array['client.view_personal_notes']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_tags', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_tags', array['off', 'studio']::text[], null, true, false, true, array['client.view_tags']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.view_health_fields', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar', 'client.view_directory']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('client.edit_health_fields', array['off', 'studio']::text[], null, true, false, true, array['client.view_health_fields']::text[], 'studio', 'off', 'studio', 'off', null, null, true, 'sensitive'),
  ('records.view_sterilisation_disinfection', array['off', 'studio']::text[], null, true, true, true, array['appt.view_calendar']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null),
  ('records.log_sterilisation_disinfection', array['off', 'studio']::text[], null, true, true, true, array['records.view_sterilisation_disinfection']::text[], 'studio', 'off', 'studio', 'off', null, null, false, null);

insert into public.permission_narrowings (id, decision, label, stage, narrows_existing, notice)
values
  ('performer_change', 'DN-8', 'Changing a session''s performer: owner or the currently recorded performer only', 'R4', true, 'Any member can name any peer as a session''s performer today. From adoption only the owner or the recorded performer can, with a reason.'),
  ('exposure_incident_history', 'DN-3', 'Exposure-incident history: owner and the reporter only; a removed reporter loses access through that studio', 'R4', true, 'Other practitioners can read and update exposure incidents today. From adoption only the owner and the person who reported can.'),
  ('colleague_private_fields', 'DN-21', 'Colleague email, Google account email and calendar-feed hash: owner and that person only', 'R1', true, 'Practitioners can read colleagues'' emails and feed-token hashes through the API today. From adoption they see names and colours only.'),
  ('studio_columns_read', 'DN-27', 'Staff read studio name, timezone, booking preferences and the fee amounts clients see at booking; other fee fields need a pay or price key', 'R1', true, 'Members can read every studio column through the API today, including fee amounts.'),
  ('getting_started_filter', 'DN-28', 'Getting Started shows only the tasks the viewer may perform', 'R5', false, 'Tasks the viewer cannot perform are no longer listed.'),
  ('notification_read_state', 'DN-22', 'Notification read state is per person; users read only notifications they may see and change only their own state', 'R5', true, 'Any member can edit any notification row and mark everyone''s as read today. From adoption each person has their own read state.'),
  ('google_flags_operator_only', 'DN-16', 'Google Calendar studio feature flags are operator-only, enforced in the database; owners keep their normal connect and disconnect', 'R5', true, 'A studio owner could turn the Google studio flags on in the app. From adoption only the operator can; connecting and disconnecting a calendar is unchanged.'),
  ('deactivated_calendar_owner', 'G7:calendar-owner', 'No active owner left: studio calendar sync pauses and the operator is alerted (no client data); it resumes only when an active owner explicitly reconnects', 'R4', false, 'Other studios'' connections are untouched. Events already copied into an external calendar may remain there. Sync does not resume by itself.'),
  ('rate_limit_outage', 'DN-29', 'When the rate limiter is down, token and link operations refuse with a retry message and public booking uses a bounded fallback', 'R5', false, 'Sensitive token and link operations ask the person to retry later during an outage. Public booking stays available with bounded protection, never unlimited submissions. The operator is alerted without client data or secret links.'),
  ('anonymous_public_writes_closed', 'G7:anon-writes', 'Anonymous waitlist and demo submissions go through validated server endpoints with rate and quantity limits; direct database writes are closed', 'R5', true, 'Public sign-up must keep working through the server endpoint, and no privileged key may reach the browser.'),
  ('portal_reply_immutable', 'DN-14', 'Staff can never rewrite a client''s original portal reply', 'R5', true, 'Staff can edit message rows through the API today. From adoption a client''s original reply is immutable and the sender of every staff message is recorded.');

-- A NEW studio starts on the new-studio basis; an existing studio has no row and resolves to its existing snapshot until its owner adopts.
create or replace function public.studios_permission_policy_seed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.studio_permission_policy (studio_id, basis, version) values (new.id, 'new_studio', 0) on conflict do nothing;
  return new;
end;
$$;

create trigger studios_permission_policy_seed_trg
  after insert on public.studios
  for each row execute function public.studios_permission_policy_seed();

-- ---------------------------------------------------------------------------
-- 3) Internal helpers (no grants to any API role).
-- ---------------------------------------------------------------------------
create or replace function public.perm_rank(p_scope text)
returns integer
language sql
immutable
set search_path = ''
as $$ select case p_scope when 'off' then 0 when 'own' then 1 when 'studio' then 2 else -1 end $$;

-- A reason must be meaningful. NO length constant is treated as proof: blank, punctuation-only, a single repeated character and
-- text made only of placeholder words are rejected.
create or replace function public.perm_reason_ok(p_reason text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_norm text;
begin
  if p_reason is null then return false; end if;
  v_norm := lower(regexp_replace(p_reason, '[^[:alnum:]]', '', 'g'));
  if v_norm = '' then return false; end if;
  if (select count(distinct ch) from regexp_split_to_table(v_norm, '') as ch) < 2 then return false; end if;
  if regexp_replace(lower(p_reason), '(\m(na|nil|null|none|test|testing|tbd|todo|asdf|qwerty|foo|bar|xxx|ok|okay|reason|why|because|misc|other|nothing|unknown|placeholder|tmp|temp|abc|abcd)\M|n/a)', '', 'g') ~ '^[^[:alnum:]]*$' then
    return false;
  end if;
  return true;
end;
$$;

-- The caller's active membership in the studio: (membership_id, role). Owner and practitioner come from practitioners; a receptionist
-- from studio_receptionists. No row = no access.
create or replace function public.perm_actor(p_studio uuid)
returns table (membership_id uuid, role text)
language sql
stable
security definer
set search_path = ''
as $$
  select * from (
    select pr.id, pr.role from public.practitioners pr
     where pr.studio_id = p_studio and pr.user_id = auth.uid() and pr.active
    union all
    select r.id, 'receptionist'::text from public.studio_receptionists r
     where r.studio_id = p_studio and r.user_id = auth.uid() and r.active
  ) x
  where auth.uid() is not null
  limit 1
$$;

-- The value a role holds for a key BEFORE prerequisites and gates: the stored owner choice, else the studio's own basis.
create or replace function public.perm_base_scope(p_studio uuid, p_role text, p_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.permission_catalog%rowtype;
  v_basis text;
  v_stored text;
begin
  select * into c from public.permission_catalog where key = p_key;
  if not found then return 'off'; end if;
  select spp.basis into v_basis from public.studio_permission_policy spp where spp.studio_id = p_studio;
  v_basis := coalesce(v_basis, 'existing_snapshot');
  if c.owner_configurable then
    select s.scope into v_stored from public.studio_role_permissions s where s.studio_id = p_studio and s.role = p_role and s.key = p_key;
  end if;
  return coalesce(
    v_stored,
    case when v_basis = 'new_studio' then (case p_role when 'practitioner' then c.new_practitioner else c.new_receptionist end)
         else (case p_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end) end
  );
end;
$$;

-- The single resolver. Mirrors effectiveScope in lib/permissions/catalog.ts.
create or replace function public.perm_effective_scope(p_studio uuid, p_role text, p_key text, p_seen text[] default '{}')
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.permission_catalog%rowtype;
  v_scope text;
  v_allowed text[];
  v_gate text;
  v_snap text;
  v_req text;
  v_cap text;
begin
  select * into c from public.permission_catalog where key = p_key;
  if not found or p_key = any (p_seen) or p_role not in ('practitioner', 'receptionist') then return 'off'; end if;
  if not (case p_role when 'practitioner' then c.offered_practitioner else c.offered_receptionist end) then return 'off'; end if;
  v_allowed := case when p_role = 'receptionist' then array_remove(c.scopes, 'own') else c.scopes end;
  v_scope := public.perm_base_scope(p_studio, p_role, p_key);
  if not (v_scope = any (v_allowed)) then return 'off'; end if;
  v_snap := case p_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
  v_gate := case p_role when 'practitioner' then c.gate_practitioner else c.gate_receptionist end;
  if v_gate is not null
     and not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = v_gate), false)
     and public.perm_rank(v_scope) > public.perm_rank(v_snap) then
    v_scope := v_snap;
  end if;
  foreach v_req in array c.requires loop
    v_cap := public.perm_effective_scope(p_studio, p_role, v_req, p_seen || p_key);
    if public.perm_rank(v_cap) < public.perm_rank(v_scope) then v_scope := v_cap; end if;
  end loop;
  return case when v_scope = any (v_allowed) then v_scope else 'off' end;
end;
$$;

create or replace function public.perm_effective_map(p_studio uuid, p_role text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(c.key, public.perm_effective_scope(p_studio, p_role, c.key)), '{}'::jsonb)
    from public.permission_catalog c
$$;

-- Keys whose effective scope differs between two maps: [{key, before, after}].
create or replace function public.perm_diff(p_before jsonb, p_after jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', a.key, 'before', p_before ->> a.key, 'after', a.value #>> '{}',
                                               'sensitive', coalesce(c.sensitive, false), 'consequence', c.consequence) order by a.key), '[]'::jsonb)
    from jsonb_each(p_after) a
    left join public.permission_catalog c on c.key = a.key
   where (p_before ->> a.key) is distinct from (a.value #>> '{}')
$$;

-- People a role change affects, computed on the server (membership id, display name, state; never an email).
create or replace function public.perm_affected_people(p_studio uuid, p_role text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'count', count(*),
    'people', coalesce(jsonb_agg(jsonb_build_object('membership_id', x.id, 'display_name', x.display_name, 'state', x.state) order by x.display_name, x.id), '[]'::jsonb)
  )
  from (
    select pr.id, pr.display_name, case when pr.active then 'active' else 'deactivated' end as state
      from public.practitioners pr where pr.studio_id = p_studio and pr.role = 'practitioner' and p_role = 'practitioner'
    union all
    select r.id, r.display_name, case when r.active then 'active' else 'deactivated' end
      from public.studio_receptionists r where r.studio_id = p_studio and p_role = 'receptionist'
  ) x
$$;

-- Enforcement. The owner holds every catalogued key (fail closed for an unknown key). Otherwise the caller's effective scope decides:
-- `studio` allows; `own` is decided against the CURRENT appointment rows on every call, never cached.
create or replace function public.has_studio_permission(
  p_studio uuid,
  p_key text,
  p_client uuid default null,
  p_appointment uuid default null,
  p_practitioner uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  c public.permission_catalog%rowtype;
  v_scope text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found then return false; end if;
  select * into c from public.permission_catalog where key = p_key;
  if not found then return false; end if;
  if a.role = 'owner' then return true; end if;
  v_scope := public.perm_effective_scope(p_studio, a.role, p_key);
  if v_scope = 'studio' then return true; end if;
  if v_scope <> 'own' then return false; end if;
  if c.own_kind = 'appointment' then
    return p_appointment is not null and exists (
      select 1 from public.appointments ap
       where ap.id = p_appointment and ap.studio_id = p_studio and ap.practitioner_id = a.membership_id);
  elsif c.own_kind = 'client' then
    -- Sam, batch 4 + clarification: a non-cancelled appointment in THIS studio, past or upcoming, CURRENTLY assigned to the actor.
    return p_client is not null and exists (
      select 1 from public.appointments ap
       where ap.studio_id = p_studio and ap.client_id = p_client and ap.practitioner_id = a.membership_id and ap.status <> 'cancelled');
  elsif c.own_kind = 'practitioner' then
    return p_practitioner is not null and p_practitioner = a.membership_id;
  end if;
  return false;
end;
$$;

create or replace function public.perm_fail(
  p_code text, p_key text default null, p_role text default null, p_version bigint default null, p_extra jsonb default '{}'::jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object('ok', false, 'code', p_code, 'key', p_key, 'role', p_role, 'current_version', p_version)) || p_extra
$$;

-- ---------------------------------------------------------------------------
-- 4) Owner commands. Every refusal is a CODE in `{ok:false, code, key?, role?, current_version?}`, never prose and never data.
--    Preview and save share ONE body; a preview applies the change, reads the result and rolls it back inside a subtransaction.
-- ---------------------------------------------------------------------------
create or replace function public.perm_run_changes(
  p_studio uuid, p_changes jsonb, p_reason text, p_confirmed boolean,
  p_expected_version bigint, p_require_version boolean, p_commit boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  c public.permission_catalog%rowtype;
  v_version bigint;
  v_new_version bigint;
  v_role text;
  v_key text;
  v_scope text;
  v_allowed text[];
  v_snap text;
  v_gate text;
  v_base text;
  v_reason text;
  v_msg text;
  v_req text;
  v_cap text;
  v_roles text[] := '{}';
  v_before_eff jsonb := '{}'::jsonb;
  v_after_eff jsonb := '{}'::jsonb;
  v_apply jsonb := '[]'::jsonb;
  v_item jsonb;
  v_audit_before jsonb := '{}'::jsonb;
  v_audit_after jsonb := '{}'::jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_affected jsonb := '{}'::jsonb;
  v_sens jsonb := '[]'::jsonb;
  v_changed boolean := false;
  v_widen boolean := false;
  v_result jsonb;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return public.perm_fail('invalid_changes'); end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  begin
    insert into public.studio_permission_policy (studio_id, basis, version) values (p_studio, 'existing_snapshot', 0) on conflict do nothing;
    select spp.version into v_version from public.studio_permission_policy spp where spp.studio_id = p_studio for update;
    if p_expected_version is null and p_require_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('version_required', null, null, v_version)::text;
    end if;
    if p_expected_version is not null and p_expected_version <> v_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('stale_version', null, null, v_version)::text;
    end if;

    for v_role in select jsonb_object_keys(p_changes) loop
      if v_role not in ('practitioner', 'receptionist') or jsonb_typeof(p_changes -> v_role) <> 'object' then
        raise exception using errcode = 'PM001', message = public.perm_fail('unknown_role', null, v_role)::text;
      end if;
      v_roles := v_roles || v_role;
      v_before_eff := v_before_eff || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
    end loop;
    if cardinality(v_roles) = 0 then
      raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed')::text;
    end if;

    foreach v_role in array v_roles loop
      for v_key in select jsonb_object_keys(p_changes -> v_role) loop
        select * into c from public.permission_catalog where key = v_key;
        if not found then
          raise exception using errcode = 'PM001', message = public.perm_fail('unknown_key', v_key, v_role)::text;
        end if;
        if jsonb_typeof(p_changes -> v_role -> v_key) <> 'string' then
          raise exception using errcode = 'PM001', message = public.perm_fail('scope_not_allowed', v_key, v_role)::text;
        end if;
        v_scope := p_changes -> v_role ->> v_key;
        if not c.owner_configurable then
          raise exception using errcode = 'PM001', message = public.perm_fail('fixed_key', v_key, v_role)::text;
        end if;
        if v_scope <> 'off' and not (case v_role when 'practitioner' then c.offered_practitioner else c.offered_receptionist end) then
          raise exception using errcode = 'PM001', message = public.perm_fail('not_offered', v_key, v_role)::text;
        end if;
        v_allowed := case when v_role = 'receptionist' then array_remove(c.scopes, 'own') else c.scopes end;
        if not (v_scope = any (v_allowed)) then
          raise exception using errcode = 'PM001', message = public.perm_fail('scope_not_allowed', v_key, v_role)::text;
        end if;
        v_snap := case v_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
        v_gate := case v_role when 'practitioner' then c.gate_practitioner else c.gate_receptionist end;
        if v_gate is not null
           and not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = v_gate), false)
           and public.perm_rank(v_scope) > public.perm_rank(v_snap) then
          raise exception using errcode = 'PM001', message = public.perm_fail('gate_unmet', v_key, v_role, null, jsonb_build_object('gate', v_gate))::text;
        end if;
        v_base := public.perm_base_scope(p_studio, v_role, v_key);
        if v_scope <> v_base then
          v_changed := true;
          v_apply := v_apply || jsonb_build_array(jsonb_build_object('role', v_role, 'key', v_key, 'scope', v_scope, 'base', v_base));
          if c.sensitive and public.perm_rank(v_scope) > public.perm_rank(v_before_eff -> v_role ->> v_key) then
            v_widen := true;
            v_sens := v_sens || to_jsonb(v_key);
          end if;
        end if;
      end loop;
    end loop;
    if not v_changed then
      raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed')::text;
    end if;

    if v_widen and p_commit then
      if not coalesce(p_confirmed, false) then
        raise exception using errcode = 'PM001', message = public.perm_fail('sensitive_unconfirmed')::text;
      end if;
      if not public.perm_reason_ok(v_reason) then
        raise exception using errcode = 'PM001', message = public.perm_fail('reason_required')::text;
      end if;
    elsif v_reason is not null and not public.perm_reason_ok(v_reason) then
      raise exception using errcode = 'PM001', message = public.perm_fail('reason_invalid')::text;
    end if;

    for v_item in select * from jsonb_array_elements(v_apply) loop
      insert into public.studio_role_permissions (studio_id, role, key, scope)
      values (p_studio, v_item ->> 'role', v_item ->> 'key', v_item ->> 'scope')
      on conflict (studio_id, role, key) do update set scope = excluded.scope;
    end loop;

    -- Prerequisites must hold on the RESULTING set.
    for v_item in select * from jsonb_array_elements(v_apply) loop
      select * into c from public.permission_catalog where key = v_item ->> 'key';
      foreach v_req in array c.requires loop
        v_cap := public.perm_effective_scope(p_studio, v_item ->> 'role', v_req, array[v_item ->> 'key']);
        if public.perm_rank(v_cap) < public.perm_rank(v_item ->> 'scope') then
          raise exception using errcode = 'PM001',
            message = public.perm_fail('prerequisite_unmet', v_item ->> 'key', v_item ->> 'role', null, jsonb_build_object('blocked_by', v_req))::text;
        end if;
      end loop;
    end loop;

    foreach v_role in array v_roles loop
      v_after_eff := v_after_eff || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
      v_changes := v_changes || jsonb_build_object(v_role, public.perm_diff(v_before_eff -> v_role, v_after_eff -> v_role));
      v_affected := v_affected || jsonb_build_object(v_role, public.perm_affected_people(p_studio, v_role));
    end loop;

    v_result := jsonb_build_object(
      'ok', true, 'version', v_version, 'changes', v_changes, 'affected', v_affected,
      'reason_required', v_widen, 'sensitive_keys', v_sens
    );

    if not p_commit then
      raise exception using errcode = 'PM002', message = 'preview';
    end if;

    update public.studio_permission_policy set version = version + 1 where studio_id = p_studio returning version into v_new_version;
    foreach v_role in array v_roles loop
      v_audit_before := '{}'::jsonb;
      v_audit_after := '{}'::jsonb;
      for v_item in select value from jsonb_array_elements(v_apply) where value ->> 'role' = v_role loop
        v_audit_before := v_audit_before || jsonb_build_object(v_item ->> 'key',
          jsonb_build_object('stored', v_item ->> 'base', 'effective', v_before_eff -> v_role ->> (v_item ->> 'key')));
        v_audit_after := v_audit_after || jsonb_build_object(v_item ->> 'key',
          jsonb_build_object('stored', v_item ->> 'scope', 'effective', v_after_eff -> v_role ->> (v_item ->> 'key')));
      end loop;
      if v_audit_after <> '{}'::jsonb then
        insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, before, after, reason, policy_version_before, policy_version_after)
        values (p_studio, auth.uid(), a.membership_id, 'role_permissions_saved', v_role, v_audit_before, v_audit_after, v_reason, v_version, v_new_version);
      end if;
    end loop;
    return v_result || jsonb_build_object('new_version', v_new_version);
  exception
    when sqlstate 'PM001' then
      get stacked diagnostics v_msg = message_text;
      return v_msg::jsonb;
    when sqlstate 'PM002' then
      return v_result;
  end;
end;
$$;

create or replace function public.preview_role_changes(p_studio uuid, p_changes jsonb)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select public.perm_run_changes(p_studio, p_changes, null, false, null, false, false) $$;

create or replace function public.save_role_permissions(
  p_studio uuid, p_expected_version bigint, p_changes jsonb, p_reason text default null, p_sensitive_confirmed boolean default false
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$ select public.perm_run_changes(p_studio, p_changes, p_reason, p_sensitive_confirmed, p_expected_version, true, true) $$;

-- Reset a role to the studio's OWN basis (an existing studio returns to its snapshot, never to the new defaults) / adopt new defaults.
create or replace function public.perm_run_basis(
  p_studio uuid, p_mode text, p_role text, p_reason text, p_expected_version bigint, p_require_version boolean, p_commit boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  v_version bigint;
  v_new_version bigint;
  v_basis text;
  v_reason text;
  v_msg text;
  v_role text;
  v_roles text[];
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_affected jsonb := '{}'::jsonb;
  v_result jsonb;
  v_any boolean := false;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_mode = 'reset' and p_role not in ('practitioner', 'receptionist') then return public.perm_fail('unknown_role', null, p_role); end if;
  v_roles := case when p_mode = 'reset' then array[p_role] else array['practitioner', 'receptionist'] end;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  begin
    insert into public.studio_permission_policy (studio_id, basis, version) values (p_studio, 'existing_snapshot', 0) on conflict do nothing;
    select spp.version, spp.basis into v_version, v_basis from public.studio_permission_policy spp where spp.studio_id = p_studio for update;
    if p_expected_version is null and p_require_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('version_required', null, null, v_version)::text;
    end if;
    if p_expected_version is not null and p_expected_version <> v_version then
      raise exception using errcode = 'PM001', message = public.perm_fail('stale_version', null, null, v_version)::text;
    end if;
    if p_commit and not public.perm_reason_ok(v_reason) then
      raise exception using errcode = 'PM001', message = public.perm_fail('reason_required')::text;
    end if;

    foreach v_role in array v_roles loop
      v_before := v_before || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
    end loop;

    if p_mode = 'adopt' then
      if v_basis = 'new_studio' then
        raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed', null, null, v_version)::text;
      end if;
      update public.studio_permission_policy set basis = 'new_studio', adopted_at = now() where studio_id = p_studio;
    else
      select exists (select 1 from public.studio_role_permissions s where s.studio_id = p_studio and s.role = p_role) into v_any;
      if not v_any then
        raise exception using errcode = 'PM001', message = public.perm_fail('nothing_changed', null, p_role, v_version)::text;
      end if;
      delete from public.studio_role_permissions where studio_id = p_studio and role = p_role;
    end if;

    foreach v_role in array v_roles loop
      v_after := v_after || jsonb_build_object(v_role, public.perm_effective_map(p_studio, v_role));
      v_changes := v_changes || jsonb_build_object(v_role, public.perm_diff(v_before -> v_role, v_after -> v_role));
      v_affected := v_affected || jsonb_build_object(v_role, public.perm_affected_people(p_studio, v_role));
    end loop;

    v_result := jsonb_build_object('ok', true, 'version', v_version, 'changes', v_changes, 'affected', v_affected, 'reason_required', true);
    if p_mode = 'adopt' then
      v_result := v_result || jsonb_build_object(
        'fixed_narrowings',
        (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'decision', n.decision, 'label', n.label, 'stage', n.stage, 'notice', n.notice) order by n.id), '[]'::jsonb)
           from public.permission_narrowings n where n.narrows_existing));
    end if;

    if not p_commit then
      raise exception using errcode = 'PM002', message = 'preview';
    end if;

    update public.studio_permission_policy set version = version + 1 where studio_id = p_studio returning version into v_new_version;
    foreach v_role in array v_roles loop
      insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, before, after, reason, policy_version_before, policy_version_after)
      values (p_studio, auth.uid(), a.membership_id,
              case when p_mode = 'adopt' then 'defaults_adopted' else 'role_reset' end,
              v_role, v_before -> v_role, v_after -> v_role, v_reason, v_version, v_new_version);
    end loop;
    return v_result || jsonb_build_object('new_version', v_new_version);
  exception
    when sqlstate 'PM001' then
      get stacked diagnostics v_msg = message_text;
      return v_msg::jsonb;
    when sqlstate 'PM002' then
      return v_result;
  end;
end;
$$;

create or replace function public.preview_reset(p_studio uuid, p_role text)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select public.perm_run_basis(p_studio, 'reset', p_role, null, null, false, false) $$;

create or replace function public.reset_role_to_defaults(p_studio uuid, p_role text, p_expected_version bigint, p_reason text)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select public.perm_run_basis(p_studio, 'reset', p_role, p_reason, p_expected_version, true, true) $$;

create or replace function public.preview_adopt_new_defaults(p_studio uuid)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select public.perm_run_basis(p_studio, 'adopt', null, null, null, false, false) $$;

create or replace function public.adopt_new_defaults(p_studio uuid, p_expected_version bigint, p_reason text)
returns jsonb language sql volatile security definer set search_path = ''
as $$ select public.perm_run_basis(p_studio, 'adopt', null, p_reason, p_expected_version, true, true) $$;

-- ---------------------------------------------------------------------------
-- 5) Reads (owner only). Names are resolved at read time; no email is ever returned.
-- ---------------------------------------------------------------------------
create or replace function public.get_role_permissions(p_studio uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_version bigint;
  v_basis text;
  v_roles jsonb := '{}'::jsonb;
  v_role text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  select spp.version, spp.basis into v_version, v_basis from public.studio_permission_policy spp where spp.studio_id = p_studio;
  v_version := coalesce(v_version, 0);
  v_basis := coalesce(v_basis, 'existing_snapshot');
  foreach v_role in array array['practitioner', 'receptionist'] loop
    v_roles := v_roles || jsonb_build_object(v_role, (
      select coalesce(jsonb_object_agg(c.key, jsonb_build_object(
        'stored', (select s.scope from public.studio_role_permissions s where s.studio_id = p_studio and s.role = v_role and s.key = c.key),
        'effective', public.perm_effective_scope(p_studio, v_role, c.key)
      )), '{}'::jsonb) from public.permission_catalog c));
  end loop;
  return jsonb_build_object(
    'ok', true, 'version', v_version, 'basis', v_basis, 'roles', v_roles,
    'keys', (select coalesce(jsonb_object_agg(c.key, jsonb_build_object('sensitive', c.sensitive, 'consequence', c.consequence)), '{}'::jsonb) from public.permission_catalog c),
    'gates', (select coalesce(jsonb_object_agg(g.gate, g.met), '{}'::jsonb) from public.permission_ship_gates g where g.studio_id = p_studio)
  );
end;
$$;

create or replace function public.effective_access(p_studio uuid, p_membership uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  c public.permission_catalog%rowtype;
  v_role text;
  v_active boolean;
  v_basis text;
  v_state text;
  v_rows jsonb := '[]'::jsonb;
  v_eff text;
  v_base text;
  v_capped text;
  v_gate text;
  v_snap text;
  v_req text;
  v_stored text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  select pr.role, pr.active into v_role, v_active from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio;
  if not found then
    select 'receptionist', r.active into v_role, v_active from public.studio_receptionists r where r.id = p_membership and r.studio_id = p_studio;
    if not found then return public.perm_fail('not_found'); end if;
  end if;
  v_state := case when v_active then 'active' else 'deactivated' end;
  select spp.basis into v_basis from public.studio_permission_policy spp where spp.studio_id = p_studio;
  v_basis := coalesce(v_basis, 'existing_snapshot');
  for c in select * from public.permission_catalog order by key loop
    v_capped := null;
    v_stored := null;
    if v_role = 'owner' then
      v_eff := 'studio';
      v_stored := null;
    elsif not v_active then
      v_eff := 'off';
      v_capped := 'deactivated';
    else
      v_eff := public.perm_effective_scope(p_studio, v_role, c.key);
      v_base := public.perm_base_scope(p_studio, v_role, c.key);
      if public.perm_rank(v_eff) < public.perm_rank(v_base) then
        v_gate := case v_role when 'practitioner' then c.gate_practitioner else c.gate_receptionist end;
        v_snap := case v_role when 'practitioner' then c.snapshot_practitioner else c.snapshot_receptionist end;
        if not (case v_role when 'practitioner' then c.offered_practitioner else c.offered_receptionist end) then
          v_capped := 'not_offered';
        elsif v_gate is not null
              and not coalesce((select g.met from public.permission_ship_gates g where g.studio_id = p_studio and g.gate = v_gate), false)
              and public.perm_rank(v_base) > public.perm_rank(v_snap) then
          v_capped := 'gate:' || v_gate;
        else
          foreach v_req in array c.requires loop
            if public.perm_rank(public.perm_effective_scope(p_studio, v_role, v_req, array[c.key])) < public.perm_rank(v_base) then
              v_capped := 'requires:' || v_req;
              exit;
            end if;
          end loop;
        end if;
      end if;
      select s.scope into v_stored from public.studio_role_permissions s where s.studio_id = p_studio and s.role = v_role and s.key = c.key;
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'key', c.key, 'scope', v_eff,
      'source', case when v_role = 'owner' then 'owner' when v_stored is not null then 'stored' when v_basis = 'new_studio' then 'default' else 'snapshot' end,
      'capped_by', v_capped)));
  end loop;
  return jsonb_build_object('ok', true, 'membership_id', p_membership, 'role', v_role, 'state', v_state, 'rows', v_rows);
end;
$$;

create or replace function public.list_permission_audit(p_studio uuid, p_limit integer default 50, p_before bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  return jsonb_build_object('ok', true, 'rows', (
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.id desc), '[]'::jsonb)
    from (
      select pa.id, pa.at, pa.kind, pa.role, pa.before, pa.after, pa.reason, pa.policy_version_before, pa.policy_version_after,
             coalesce((select pr.display_name from public.practitioners pr where pr.id = pa.actor_membership_id and pr.studio_id = pa.studio_id),
                      (select r.display_name from public.studio_receptionists r where r.id = pa.actor_membership_id and r.studio_id = pa.studio_id)) as actor_name,
             case pa.membership_kind
               when 'practitioner' then (select pr.display_name from public.practitioners pr where pr.id = pa.membership_id and pr.studio_id = pa.studio_id)
               when 'receptionist' then (select r.display_name from public.studio_receptionists r where r.id = pa.membership_id and r.studio_id = pa.studio_id)
             end as person_name,
             case pa.membership_kind
               when 'practitioner' then (select case when pr.active then 'active' else 'deactivated' end from public.practitioners pr where pr.id = pa.membership_id and pr.studio_id = pa.studio_id)
               when 'receptionist' then (select case when r.active then 'active' else 'deactivated' end from public.studio_receptionists r where r.id = pa.membership_id and r.studio_id = pa.studio_id)
             end as person_state
        from public.permission_audit pa
       where pa.studio_id = p_studio and (p_before is null or pa.id < p_before)
       order by pa.id desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) x));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Staff role assignment. practitioner <-> receptionist in ONE transaction; deactivate, never delete; refuse self, an owner as
--    source or target, and any move that would leave upcoming appointments assigned to someone who is no longer a practitioner.
--    The receptionist INVITE path is not here.
-- ---------------------------------------------------------------------------
create or replace function public.change_staff_role(
  p_studio uuid, p_membership uuid, p_new_role text, p_expected_current_role text, p_reason text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  a record;
  v_reason text;
  v_user uuid;
  v_name text;
  v_email text;
  v_active boolean;
  v_upcoming bigint;
  v_new_id uuid;
  v_target_kind text;
begin
  select * into a from public.perm_actor(p_studio);
  if not found or a.role <> 'owner' then return public.perm_fail('refused'); end if;
  if p_new_role not in ('practitioner', 'receptionist') or p_expected_current_role not in ('practitioner', 'receptionist') then
    return public.perm_fail('owner_role_fixed');
  end if;
  if p_new_role = p_expected_current_role then return public.perm_fail('nothing_changed'); end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is not null and not public.perm_reason_ok(v_reason) then return public.perm_fail('reason_invalid'); end if;

  if p_expected_current_role = 'practitioner' then
    select pr.user_id, pr.display_name, pr.email, pr.active into v_user, v_name, v_email, v_active
      from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio and pr.role = 'practitioner' for update;
    if not found then
      if exists (select 1 from public.practitioners pr where pr.id = p_membership and pr.studio_id = p_studio and pr.role = 'owner') then
        return public.perm_fail('owner_role_fixed');
      end if;
      return public.perm_fail('not_found');
    end if;
  else
    select r.user_id, r.display_name, r.email, r.active into v_user, v_name, v_email, v_active
      from public.studio_receptionists r where r.id = p_membership and r.studio_id = p_studio for update;
    if not found then return public.perm_fail('not_found'); end if;
  end if;
  if v_user is not null and v_user = auth.uid() then return public.perm_fail('self_change'); end if;
  if not v_active then return public.perm_fail('not_active'); end if;

  if p_expected_current_role = 'practitioner' then
    select count(*) into v_upcoming from public.appointments ap
     where ap.studio_id = p_studio and ap.practitioner_id = p_membership and ap.status = 'confirmed' and ap.starts_at > now();
    if v_upcoming > 0 then
      return public.perm_fail('has_upcoming_appointments', null, null, null, jsonb_build_object('count', v_upcoming));
    end if;
    update public.practitioners set active = false where id = p_membership;
    select r.id into v_new_id from public.studio_receptionists r where r.studio_id = p_studio and v_user is not null and r.user_id = v_user for update;
    if v_new_id is not null then
      update public.studio_receptionists set active = true, deactivated_at = null where id = v_new_id;
    else
      insert into public.studio_receptionists (studio_id, user_id, display_name, email, active, created_by_practitioner_id)
      values (p_studio, v_user, v_name, v_email, true, a.membership_id) returning id into v_new_id;
    end if;
    v_target_kind := 'receptionist';
  else
    if v_email is null then return public.perm_fail('email_required'); end if;
    update public.studio_receptionists set active = false, deactivated_at = now() where id = p_membership;
    select pr.id into v_new_id from public.practitioners pr where pr.studio_id = p_studio and v_user is not null and pr.user_id = v_user and pr.role = 'practitioner' for update;
    if v_new_id is not null then
      update public.practitioners set active = true where id = v_new_id;
    else
      insert into public.practitioners (studio_id, user_id, display_name, email, role, active)
      values (p_studio, v_user, v_name, v_email, 'practitioner', true) returning id into v_new_id;
    end if;
    v_target_kind := 'practitioner';
  end if;

  insert into public.permission_audit (studio_id, actor_user_id, actor_membership_id, kind, role, membership_id, membership_kind, before, after, reason)
  values (p_studio, auth.uid(), a.membership_id, 'staff_role_changed', p_new_role, v_new_id, v_target_kind,
          jsonb_build_object('role', p_expected_current_role, 'membership_id', p_membership),
          jsonb_build_object('role', p_new_role, 'membership_id', v_new_id), v_reason);
  return jsonb_build_object('ok', true, 'membership_id', v_new_id, 'role', p_new_role);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Grants. Every function is revoked from public, anon, authenticated AND service_role by name first (Supabase's default
--    privileges grant all three), then only the commands below are granted, to authenticated alone.
-- ---------------------------------------------------------------------------
revoke all on function public.permission_audit_append_only() from public, anon, authenticated, service_role;
revoke all on function public.studios_permission_policy_seed() from public, anon, authenticated, service_role;
revoke all on function public.perm_rank(text) from public, anon, authenticated, service_role;
revoke all on function public.perm_reason_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.perm_actor(uuid) from public, anon, authenticated, service_role;
revoke all on function public.perm_base_scope(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.perm_effective_scope(uuid, text, text, text[]) from public, anon, authenticated, service_role;
revoke all on function public.perm_effective_map(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.perm_diff(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.perm_affected_people(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.perm_fail(text, text, text, bigint, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.perm_run_changes(uuid, jsonb, text, boolean, bigint, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.perm_run_basis(uuid, text, text, text, bigint, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.has_studio_permission(uuid, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_role_changes(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.save_role_permissions(uuid, bigint, jsonb, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.preview_reset(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.reset_role_to_defaults(uuid, text, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.preview_adopt_new_defaults(uuid) from public, anon, authenticated, service_role;
revoke all on function public.adopt_new_defaults(uuid, bigint, text) from public, anon, authenticated, service_role;
revoke all on function public.get_role_permissions(uuid) from public, anon, authenticated, service_role;
revoke all on function public.effective_access(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_permission_audit(uuid, integer, bigint) from public, anon, authenticated, service_role;
revoke all on function public.change_staff_role(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;

grant execute on function public.has_studio_permission(uuid, text, uuid, uuid, uuid) to authenticated;
grant execute on function public.preview_role_changes(uuid, jsonb) to authenticated;
grant execute on function public.save_role_permissions(uuid, bigint, jsonb, text, boolean) to authenticated;
grant execute on function public.preview_reset(uuid, text) to authenticated;
grant execute on function public.reset_role_to_defaults(uuid, text, bigint, text) to authenticated;
grant execute on function public.preview_adopt_new_defaults(uuid) to authenticated;
grant execute on function public.adopt_new_defaults(uuid, bigint, text) to authenticated;
grant execute on function public.get_role_permissions(uuid) to authenticated;
grant execute on function public.effective_access(uuid, uuid) to authenticated;
grant execute on function public.list_permission_audit(uuid, integer, bigint) to authenticated;
grant execute on function public.change_staff_role(uuid, uuid, text, text, text) to authenticated;

commit;
