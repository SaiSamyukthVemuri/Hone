-- 0242 PAUSE EXPORT GUARD (window-scoped, NOT a migration, NOT a bridge
-- publication). Companion to 0242-pause-guard.up.sql (archive/unarchive); a
-- separate pair because export has a different release point: it must stay
-- refused after S3 serves traffic, until the operator lifts it on purpose.
--
-- Run by the S1 DB operator together with the archive guard, BEFORE
-- 0213-0246 are applied (the hosted audit_logs table already exists at 0212).
-- While it exists, NO row with action 'studio_export' can be inserted into
-- public.audit_logs by anyone:
--   * B-OLD  (direct browser-role insert at settings/data/actions.ts:1283):
--     before 0242 the member INSERT policy would accept it; the guard refuses
--     it, the old action returns ok:false and hands out no file.
--   * B-1035 (record_studio_export_audit_governed, SECURITY DEFINER): its
--     insert raises, the command errors, recordStudioExportAudit refuses, and
--     the ZIP is withheld.
-- Both builds hand out the export only AFTER the audit row commits, so a
-- refused audit means no file. It touches no other action, column, role or
-- table. The refusal is unconditional (a definer function runs as its owner,
-- so a role test would not catch B-1035).
-- IDEMPOTENT: safe to run twice (create or replace; drop trigger if exists).
begin;
set local lock_timeout = '5s';

create or replace function public.pause_studio_export_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'studio export is paused' using errcode = '55000';
end;
$$;

revoke all privileges on function public.pause_studio_export_guard()
  from public, anon, authenticated, service_role;

drop trigger if exists audit_logs_00_pause_export_trg on public.audit_logs;
create trigger audit_logs_00_pause_export_trg
  before insert on public.audit_logs
  for each row when (new.action = 'studio_export')
  execute function public.pause_studio_export_guard();

commit;
