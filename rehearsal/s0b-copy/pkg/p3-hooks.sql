-- S0B (P3) PRE-RESTORE: database webhooks (supabase_functions.hooks). Run only if p0 says the table exists. Count only.
select count(*) as hooks from supabase_functions.hooks;
