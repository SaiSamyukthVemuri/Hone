-- HON-126 (Privacy decision B, confirmed by Sam 2026-11-27): ops alerts are readable by Hone operators only.
--
-- 0067 let every active practitioner of a studio SELECT every column of a studio-scoped alert (policy ops_alerts_member_read), and left the table
-- privileges at the Supabase defaults, so anon and authenticated held full table privileges behind that one policy. Alerts carry money, client ids,
-- provider text and (0238) a Stripe account id. HON-125 (#1845) routes NEW sensitive alerts operator-only; it cannot protect rows already written, or
-- alerts the SQL functions write with a studio_id (their dedupe is keyed on it). This migration closes the table to every client role instead.
--
-- WHAT IT DOES: drops ops_alerts_member_read, and revokes ALL table privileges from public, anon and authenticated BY NAME. RLS stays ON with no policy
-- (default deny). service_role is untouched, and so are the four SECURITY DEFINER functions that write or read the table (claim_stripe_account_country_alert,
-- enqueue_calendar_outbound, enqueue_calendar_outbound_on_delete, reminder_sms_unroutable_studios): they run as postgres and bypass RLS, and none is
-- executable by anon or authenticated. Every application reader and writer already uses the service-role client (tests/security/ops-alert-operator-only-guard).
--
-- GUARDS: a preamble refuses to run unless the table has RLS on and EXACTLY one policy, ops_alerts_member_read, SELECT only, with the 0067 qual. The
-- after-check refuses to commit unless the table has zero policies and RLS on, anon and authenticated hold no table or column privilege of any kind, and
-- service_role still holds select, insert, update and delete. A failed check rolls the whole transaction back, so there is no half state.
--
-- CAPTURED BEFORE (hosted, read-only, 2026-11-27): relacl {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}.
-- Rollback (EMERGENCY ONLY): supabase/rollbacks/0397_ops_alerts_operator_only.down.sql.

begin;

set local lock_timeout = '5s';

do $guard$
declare
  v_policies text[];
begin
  if not exists (select 1 from pg_catalog.pg_class c
                  where c.oid = pg_catalog.to_regclass('public.ops_alerts') and c.relrowsecurity) then
    raise exception '0397 refuses to run: public.ops_alerts is missing or row-level security is off';
  end if;

  select pg_catalog.array_agg(p.polname || '|' || p.polcmd::text || '|' || pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                              order by p.polname)
    into v_policies
    from pg_catalog.pg_policy p
   where p.polrelid = pg_catalog.to_regclass('public.ops_alerts');

  if v_policies is distinct from array['ops_alerts_member_read|r|((studio_id IS NOT NULL) AND is_studio_member(studio_id))'] then
    raise exception '0397 refuses to run: ops_alerts must have exactly the 0067 policy ops_alerts_member_read, found %', v_policies;
  end if;
end
$guard$;

drop policy ops_alerts_member_read on public.ops_alerts;

revoke all on table public.ops_alerts from public;
revoke all on table public.ops_alerts from anon;
revoke all on table public.ops_alerts from authenticated;

do $after$
declare
  v_role text;
  v_priv text;
begin
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.ops_alerts')) then
    raise exception '0397 refuses to commit: ops_alerts still has a policy';
  end if;
  if not exists (select 1 from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.ops_alerts') and c.relrowsecurity) then
    raise exception '0397 refuses to commit: row-level security is not on';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if pg_catalog.has_table_privilege(v_role, 'public.ops_alerts', v_priv) then
        raise exception '0397 refuses to commit: % still holds % on ops_alerts', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['select', 'insert', 'update', 'references'] loop
      if pg_catalog.has_any_column_privilege(v_role, 'public.ops_alerts', v_priv) then
        raise exception '0397 refuses to commit: % still holds a column-level % on ops_alerts', v_role, v_priv;
      end if;
    end loop;
  end loop;
  foreach v_priv in array array['select', 'insert', 'update', 'delete'] loop
    if not pg_catalog.has_table_privilege('service_role', 'public.ops_alerts', v_priv) then
      raise exception '0397 refuses to commit: service_role lost % on ops_alerts', v_priv;
    end if;
  end loop;
end
$after$;

commit;
