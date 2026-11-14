-- ROLLBACK for 0319 (DRAFT; NOT a migration; never placed in supabase/migrations).
-- Drops the four commands and the feedback table. Apply only as a NEW forward
-- migration under its own approval, and only while the app no longer calls
-- decline_waitlist_invitation_times_unsuitable (WAITLIST_TIMES_FEEDBACK off).
-- It REFUSES (55000) while any feedback row exists, because dropping the table
-- would erase the recipients' text and the owner's only record that they asked.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.waitlist_times_feedback) then
    raise exception '0319 rollback refused: feedback rows exist' using errcode = '55000';
  end if;
end;
$$;

drop function if exists public.acknowledge_waitlist_times_feedback(uuid, uuid, uuid);
drop function if exists public.list_waitlist_times_feedback(uuid, uuid);
drop function if exists public.count_waitlist_times_feedback(uuid, uuid);
drop function if exists public.decline_waitlist_invitation_times_unsuitable(text, text, text);
drop table if exists public.waitlist_times_feedback;

commit;
