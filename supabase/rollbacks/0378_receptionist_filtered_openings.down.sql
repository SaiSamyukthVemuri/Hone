begin;
set local lock_timeout = '5s';
drop function if exists public.receptionist_find_openings_v2(uuid,uuid,uuid[],date,date,time,time);
commit;
