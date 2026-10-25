-- Lifts the 0242 pause EXPORT guard. Run by the operator on purpose, after the
-- new app (S3) is READY and the export smoke is about to run; independent of
-- 0242-pause-guard.down.sql (archive/unarchive).
begin;
set local lock_timeout = '5s';
drop trigger if exists audit_logs_00_pause_export_trg on public.audit_logs;
drop function if exists public.pause_studio_export_guard();
commit;
