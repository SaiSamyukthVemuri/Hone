-- S0B (P1) PRE-RESTORE: scheduled jobs a restored copy could start by itself. Run only if p0 says cron.job exists.
-- Counts only; the job command text is NEVER returned, only whether any command mentions http, net. or functions.
select
  count(*)                                                        as jobs,
  count(*) filter (where j.active)                                as active_jobs,
  count(*) filter (where j.command ~* '(http|net\.|functions)')   as jobs_mentioning_http_net_functions,
  count(*) filter (where j.active and j.command ~* '(http|net\.|functions)') as active_jobs_mentioning_http_net_functions
from cron.job j;
