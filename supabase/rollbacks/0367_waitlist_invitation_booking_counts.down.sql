-- DOWN. Drops the read-only counts function. No table or row is touched.
begin;
set local lock_timeout = '5s';

drop function if exists public.waitlist_invitation_booking_counts(uuid, timestamptz, timestamptz);

commit;
