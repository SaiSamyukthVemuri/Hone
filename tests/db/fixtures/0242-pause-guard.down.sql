-- Lifts the 0242 pause guard once S3 (the new app) is READY.
begin;
set local lock_timeout = '5s';
drop trigger if exists clients_00_pause_archive_trg on public.clients;
drop function if exists public.pause_client_archive_guard();
commit;
