begin;
set local lock_timeout = '5s';
drop function if exists public.receptionist_appointment_contact(uuid, uuid);
commit;
