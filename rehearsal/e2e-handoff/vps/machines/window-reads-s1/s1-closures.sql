-- ===========================================================================
-- S1 READ-BACK (window-s1read.sh): EXECUTE privilege closures AFTER the S1 apply
-- One SELECT over pg_catalog only (has_function_privilege). No writes, no table data, no identifiers:
-- function names, argument type lists and three booleans per function.
--
-- The function list is EXACTLY the closures in baseline BASELINE-W1-MACOS-CANDIDATE-3.json (efc94a51...) s1.closures:
--   the three new 0214 functions (initialize_studio_payment_jurisdiction_from_history, studio_account_acceptable_for_jurisdiction,
--   studio_named_stripe_accounts) and the two payment functions that must stay closed. window-s1read.sh refuses
--   if this list and the baseline ever differ.
-- One row per overload of each name (args is the identity argument list). The effective privilege is read, so a grant to
-- PUBLIC or through a role membership counts. window-s1read.sh folds the rows into one entry per name: a role is "true"
-- if ANY overload is executable by it.
--
-- RUN ONLY VIA: run-window-read-macos.sh s1-closures.sql (window-s1read.sh does this)
-- Chain guard: an error "division by zero" means history max is not 0246: stop.
-- EXPECTED: every name present; the comparator (--stage s1, S1-3) compares each flag with the baseline.
-- ===========================================================================
with chain_guard as (
  select 1 / (case when (select max(version) from supabase_migrations.schema_migrations) = '0246'
                   then 1 else 0 end) as at_hosted_0246
)
select
  g.at_hosted_0246,
  p.proname as fn,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as args,
  pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service_role
from chain_guard g
cross join pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('initialize_studio_payment_jurisdiction_from_history', 'studio_account_acceptable_for_jurisdiction', 'studio_named_stripe_accounts', 'reconcile_card_payment_succeeded', 'save_client_card_on_file')
order by p.proname, args;
