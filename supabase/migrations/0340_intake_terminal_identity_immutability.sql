-- 0340: an intake cannot be moved to another client or studio, and a submitted or reviewed one cannot be hidden
-- or restored by a signed-in member (HON-78, audit fingerprint rls/intake-terminal-immutability-unpinned-columns).
-- NOT APPLIED. PROVISIONAL NUMBER: not reserved by OPS; renumber at reservation. Hosted apply needs the owner's
-- per-change approval.
--
-- THE GAP. enforce_intake_terminal_immutability (0118, latest body 0162) pins answers, submitted_at, status and
-- review attribution on a submitted/reviewed row. advance_intake_revision (0243/0248) governs responses, step,
-- submitted_at and status. Neither looks at client_id, studio_id or deleted_at, and the member UPDATE policy has no
-- column predicate. A member calling the Data API with their own session can therefore re-point client A's
-- submitted (and colleague-reviewed) intake at client B of the same studio, or set deleted_at to hide it.
-- 0160 closed the same re-pointing defect for sessions and entries; this table was not in that set.
--
-- INTENDED PERMISSIONS. No application path, SQL function or cron writes any of the three columns on an existing
-- row, for any role (owner included). So the rule is role-independent: no permission predicate is involved and
-- nothing here overlaps the Roles permission core (0287/0289 cover chart tables, 0334 intake READ).
--
-- WHAT CHANGES, two triggers and one small function:
--   1. client_id and studio_id are fixed once the row exists, in every state and for every caller: the
--      established 0160 guard, public.guard_immutable_clinical_lineage, attached exactly as on sessions.
--   2. deleted_at cannot be changed on a submitted/reviewed row by a caller with a JWT. Service-role / admin
--      callers (no JWT) stay trusted, the exemption 0118/0162 use; in-progress rows are untouched.
-- No policy, table grant, column or data change. Same SQLSTATE (check_violation) as the existing guards.

begin;

set local lock_timeout = '5s';

drop trigger if exists client_intake_forms_immutable_lineage on public.client_intake_forms;
create trigger client_intake_forms_immutable_lineage
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
       and t.tgname in ('client_intake_forms_immutable_lineage', 'client_intake_forms_terminal_visibility')
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
