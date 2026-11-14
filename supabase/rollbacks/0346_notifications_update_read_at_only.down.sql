-- Rollback of 0346: restore the table-level UPDATE grant on practitioner_notifications for authenticated.
-- Reversing this restores UPDATE on every column of the table for any member of the studio (the existing UPDATE policy still limits which rows).
-- Only `authenticated` gets its grant back: the policies are `to authenticated`, so anon and PUBLIC could never pass them and are not re-granted.
-- The column-level read_at grant becomes redundant and is left in place.
begin;
set local lock_timeout = '5s';

grant update on table public.practitioner_notifications to authenticated;

commit;
