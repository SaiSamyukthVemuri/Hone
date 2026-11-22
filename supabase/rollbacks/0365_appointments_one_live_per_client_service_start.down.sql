-- DOWN. Removes the one-live-appointment rule; every command and row is untouched, so the previous behaviour returns exactly.
begin;
set local lock_timeout = '5s';

drop index if exists public.appointments_one_live_per_client_service_start;

commit;
