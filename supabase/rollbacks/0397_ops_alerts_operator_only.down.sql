-- DOWN for 0397. EMERGENCY ONLY.
--
-- WARNING: this RE-OPENS member read of ops_alerts. Every active practitioner of a studio can again SELECT every column of every studio-scoped alert,
-- INCLUDING HISTORIC ROWS that carry money, client ids, provider text and (0238) Stripe account ids, and anon and authenticated get full table
-- privileges back (as hosted had them before 0397: relacl anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres). Use it only to recover a broken
-- operator path, then re-apply 0397 as soon as the path is fixed.
--
-- Restores the exact 0067 policy and the captured grants. Refuses to run unless the table is in the 0397 end state.

begin;

set local lock_timeout = '5s';

do $guard$
begin
  if not exists (select 1 from pg_catalog.pg_class c where c.oid = pg_catalog.to_regclass('public.ops_alerts') and c.relrowsecurity) then
    raise exception '0397 down refuses to run: public.ops_alerts is missing or row-level security is off';
  end if;
  if exists (select 1 from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.ops_alerts')) then
    raise exception '0397 down refuses to run: ops_alerts already has a policy';
  end if;
  if pg_catalog.has_table_privilege('anon', 'public.ops_alerts', 'select') or pg_catalog.has_table_privilege('authenticated', 'public.ops_alerts', 'select') then
    raise exception '0397 down refuses to run: anon or authenticated already holds a table privilege';
  end if;
end
$guard$;

grant all on table public.ops_alerts to anon;
grant all on table public.ops_alerts to authenticated;

create policy "ops_alerts_member_read"
  on public.ops_alerts
  for select
  using (
    studio_id is not null
    and public.is_studio_member(studio_id)
  );

do $after$
declare
  v_role text;
  v_priv text;
begin
  if (select pg_catalog.array_agg(p.polname || '|' || p.polcmd::text || '|' || pg_catalog.pg_get_expr(p.polqual, p.polrelid) order by p.polname)
        from pg_catalog.pg_policy p where p.polrelid = pg_catalog.to_regclass('public.ops_alerts'))
     is distinct from array['ops_alerts_member_read|r|((studio_id IS NOT NULL) AND is_studio_member(studio_id))'] then
    raise exception '0397 down refuses to commit: the 0067 policy was not restored exactly';
  end if;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain'] loop
      if not pg_catalog.has_table_privilege(v_role, 'public.ops_alerts', v_priv) then
        raise exception '0397 down refuses to commit: % lacks % on ops_alerts', v_role, v_priv;
      end if;
    end loop;
  end loop;
end
$after$;

commit;
