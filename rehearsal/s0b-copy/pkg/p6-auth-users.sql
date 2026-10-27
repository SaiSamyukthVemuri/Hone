-- S0B (P6) PRE-RESTORE: number of auth users. Count only: no email, no id.
select count(*) as users from auth.users;
