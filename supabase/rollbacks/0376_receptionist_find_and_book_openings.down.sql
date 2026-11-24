-- Retire the desk booking UI before removing its RPCs. Booked visits and
-- their original receptionist attribution remain in the existing tables.
begin;
set local lock_timeout = '5s';

drop function if exists public.receptionist_book_opening(uuid,uuid,uuid,uuid,timestamptz,timestamptz);
drop function if exists public.receptionist_find_openings(uuid,uuid,uuid,date,date,timestamptz);

commit;
