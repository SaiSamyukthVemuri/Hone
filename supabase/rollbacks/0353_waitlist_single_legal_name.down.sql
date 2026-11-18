-- Down for 0353: remove the v2 completion command, the single-name CHECK and the flag column. Rollback only; never run against a hosted database without approval.
-- DATA: dropping single_legal_name discards the explicit single-name answer on any entry that has one (those rows have last_name null and would then read as an incomplete profile). Roll the app back to the v1 completion path FIRST, and do not run this with such rows present unless that loss is intended.
begin;
set local lock_timeout = '5s';

drop function if exists public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean);

alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_single_name_check;

alter table public.new_client_waitlist_entries
  drop column if exists single_legal_name;

commit;
