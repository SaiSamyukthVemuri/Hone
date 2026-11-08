-- ROLLBACK for 0313 (DRAFT; NOT a migration; never placed in supabase/migrations).
-- Drops the four commands and the follow-ups table. Apply only as a NEW forward
-- migration under its own approval, and only while the app no longer calls
-- redeem_and_book_waitlist_invitation (the previous release path redeems first
-- and books second, which is the defect 0313 repairs). It REFUSES (55000) while
-- any follow-up row exists, because dropping the table would erase the owner's
-- only durable record of an invitation that needs them.
begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.waitlist_invitation_followups) then
    raise exception '0313 rollback refused: follow-up rows exist' using errcode = '55000';
  end if;
end;
$$;

drop function if exists public.resolve_waitlist_invitation_followup(uuid, uuid, uuid);
drop function if exists public.record_waitlist_invitation_followup(text, text);
drop function if exists public.waitlist_invitation_booking_state(text);
drop function if exists public.redeem_and_book_waitlist_invitation(text, text, uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text);
drop table if exists public.waitlist_invitation_followups;

commit;
