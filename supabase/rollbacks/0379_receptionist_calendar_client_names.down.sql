-- Revert the scheduling UI before retiring its projections. The directory and
-- the previous booking/calendar functions keep their existing name rules.
begin;
set local lock_timeout = '5s';
drop function if exists public.receptionist_booking_clients_v3(uuid,text,integer);
drop function if exists public.receptionist_calendar_v3(uuid,timestamptz,timestamptz);
commit;
