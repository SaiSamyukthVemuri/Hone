-- 0340: an intake stays attached to the client and studio it was created for, and a submitted or reviewed intake
-- stays visible (HON-78).
-- NOT APPLIED. Number 0340 reserved by OPS. Hosted apply needs the owner's per-change approval.
--
-- WHY. The application treats an intake as fixed to its client and studio, and a submitted or reviewed intake as
-- part of the clinical record that is not withdrawn. The existing guards (0118/0162 terminal immutability,
-- 0243/0248 revision) cover answers, status, step and review attribution; this file makes the database enforce
-- the same rule for client_id, studio_id and deleted_at, as 0160 already does for sessions and entries.
--
-- SCOPE: public.client_intake_forms only. Two triggers and one small function:
--   1. client_id and studio_id are fixed once the row exists: the established 0160 function
--      public.guard_immutable_clinical_lineage, attached exactly as on sessions. No new lineage function.
--   2. deleted_at cannot be changed on a submitted or reviewed row by a caller with a JWT.
-- No policy (SELECT policies included), table grant, RPC, column or data change. No other table.
-- Same SQLSTATE (check_violation) as the existing guards.
--
-- IN-PROGRESS FORMS. client_id and studio_id are fixed in every state, in-progress included (0160 semantics).
-- deleted_at on an in-progress form is NOT restricted here: a member can still set or clear it, as before this
-- file. Nothing has been submitted on such a row, and whether staff may withdraw an open request is a product
-- decision this file does not take.
--
-- SERVICE ROLE. The lineage guard has no caller exemption, so client_id and studio_id are fixed for the service
-- role and for definer functions too (as on sessions since 0160). The deleted_at rule applies only when
-- auth.uid() is not null; service-role / admin callers keep the trusted exemption 0118/0162 give them.
--
-- LEGITIMATE WRITERS (none writes client_id, studio_id or deleted_at on an existing row; no application path,
-- SQL function or cron writes deleted_at on this table at all):
--   create        lib/intake/queries.ts ensureIntakeForClient, createIntakeRequestForClient   service role INSERT
--                 (INSERT is revoked from authenticated by 0163; BEFORE UPDATE triggers do not fire)
--   token save /  app/intake/[token]/actions.ts and the assisted flow in app/(app)/clients/[id]/intake/actions.ts
--   submit        -> lib/intake/write-revision.ts -> public.write_intake_revision (0243), service role: sets
--                 responses, current_step, status, submitted_at only
--   review        app/(app)/clients/[id]/intake/actions.ts markIntakeReviewedAction   user session: status,
--                 reviewed_at, reviewed_by
--   notes         same file, saveIntakeNotesAction   user session: practitioner_notes
--   reissue /     same file (request update, get link, resend) and app/api/cron/appointment-reminders/route.ts
--   resend        -> lib/intake/queries.ts stampIntakeLinkIssued   service role: intake_link_* columns only
--
-- EXISTING GUARDS are not edited, dropped or re-created: client_intake_forms_terminal_immutability (0118/0162),
-- client_intake_forms_zz_advance_revision (0243/0248), client_intake_forms_questionnaire_snapshot (0246).
-- BEFORE triggers fire in name order; the two names added here do not change the relative order of those three.
-- The lineage trigger is named client_intake_forms_lineage_fixed, not *_immutable_lineage, because
-- tests/db/immutable-clinical-lineage.db.test.ts pins the exact set of 0160 triggers by that suffix.

begin;

set local lock_timeout = '5s';

drop trigger if exists client_intake_forms_lineage_fixed on public.client_intake_forms;
create trigger client_intake_forms_lineage_fixed
  before update of client_id, studio_id on public.client_intake_forms
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

create or replace function public.enforce_intake_terminal_visibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is not null and old.status in ('submitted', 'reviewed') then
    raise exception 'A submitted intake cannot be hidden or restored.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- A trigger function is never called directly; firing it needs no EXECUTE privilege.
revoke all on function public.enforce_intake_terminal_visibility() from public, anon, authenticated, service_role;

drop trigger if exists client_intake_forms_terminal_visibility on public.client_intake_forms;
create trigger client_intake_forms_terminal_visibility
  before update on public.client_intake_forms
  for each row
  when (new.deleted_at is distinct from old.deleted_at)
  execute function public.enforce_intake_terminal_visibility();

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.client_intake_forms'::regclass
       and t.tgname in ('client_intake_forms_lineage_fixed', 'client_intake_forms_terminal_visibility')
       and t.tgenabled = 'O' and not t.tgisinternal
     having count(*) = 2
  ) then
    raise exception '0340: both intake identity triggers must be installed and enabled';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.client_intake_forms'::regclass
       and t.tgname = 'client_intake_forms_terminal_immutability' and t.tgenabled = 'O'
  ) then
    raise exception '0340: the 0118/0162 terminal guard must remain installed';
  end if;
end $$;

commit;
