-- Down for 0340: remove both intake identity triggers (the shared 0160 function stays). Touches no data. It REOPENS the gap (a member can re-point or hide a
-- submitted/reviewed intake through the Data API); run it only if the guard blocks a legitimate write.
begin;

set local lock_timeout = '5s';

drop trigger if exists client_intake_forms_lineage_fixed on public.client_intake_forms;
drop trigger if exists client_intake_forms_terminal_visibility on public.client_intake_forms;
drop function if exists public.enforce_intake_terminal_visibility();

commit;
