-- S0B (P9) event triggers. Platform ones (name prefixes pgrst_, issue_, graphql, pgaudit, supabase) are counted apart. Counts only.
select count(*) as event_triggers_all,
  count(*) filter (where e.evtname !~ '^(pgrst_|issue_|graphql|pgaudit|supabase)') as event_triggers_other
from pg_event_trigger e;
