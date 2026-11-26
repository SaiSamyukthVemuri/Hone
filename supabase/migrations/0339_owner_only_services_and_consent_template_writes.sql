-- 0339: INSERT and UPDATE on public.services and public.consent_form_templates are owner-only in the database
-- (HON-44 gaps H1 and H2). NOT APPLIED. Hosted apply needs the owner's per-change approval. Number reserved by OPS.
--
-- WHY. Both settings surfaces are owner-only in the application:
--   services                app/(app)/settings/services/actions.ts (assertOwner; reorder_studio_service and
--                           show_studio_service check is_studio_owner, 0161)
--   consent_form_templates  app/(app)/settings/consent/actions.ts (role = owner and active, then the service role)
-- The write policies underneath (services: 0173; consent_form_templates: 0057) are membership-level; this file
-- aligns them with the application's owner-only rule.
--
-- THE RULE IS NOT NEW. The application already enforces owner-only. ROLES HAND-OFF: when the permission core gates
-- these writes (R1/R3/R4), the four policies below are the ones to replace with the permission predicate.
--
-- WHAT CHANGES: four member policies dropped, four owner policies created, same commands, same role. SELECT policies
-- are untouched. Neither table has a DELETE policy and none is added. No grant, function, column or data change.
-- service_role bypasses RLS as before. The table comment 0057 left on consent_form_templates still says members can
-- INSERT / UPDATE; it is stale after this file and is deliberately not edited here (policies only).
--
-- SERVICES AND 0302. The services statements below are byte-identical to the services half of 0302 (finance M1),
-- which is already applied on hosted; its file reaches this repository with its record PR. On a database that
-- already has 0302 they drop and re-create the same two policies inside this transaction (no change); on a chain
-- without 0302 they make the change. The consent_form_templates statements are new.

begin;

set local lock_timeout = '5s';

-- services (member policies from 0173)
drop policy if exists "services_member_insert" on public.services;
drop policy if exists "services_owner_insert" on public.services;
create policy "services_owner_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_owner(studio_id));

drop policy if exists "services_member_update" on public.services;
drop policy if exists "services_owner_update" on public.services;
create policy "services_owner_update"
  on public.services for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

-- consent_form_templates (member policies from 0057)
drop policy if exists "consent_form_templates_studio_member_insert" on public.consent_form_templates;
drop policy if exists "consent_form_templates_studio_owner_insert" on public.consent_form_templates;
create policy "consent_form_templates_studio_owner_insert"
  on public.consent_form_templates for insert to authenticated
  with check (public.is_studio_owner(studio_id));

drop policy if exists "consent_form_templates_studio_member_update" on public.consent_form_templates;
drop policy if exists "consent_form_templates_studio_owner_update" on public.consent_form_templates;
create policy "consent_form_templates_studio_owner_update"
  on public.consent_form_templates for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

-- Closing assertions, per table: RLS stays on, the member read remains, and the only non-SELECT policies are the
-- two owner writes (so no DELETE policy appeared and no member write survived).
do $$
declare
  t record;
  v_bad text;
begin
  for t in
    select * from (values
      ('services', 'services_member_select', 'services_owner_insert', 'services_owner_update'),
      ('consent_form_templates', 'consent_form_templates_studio_member_select',
       'consent_form_templates_studio_owner_insert', 'consent_form_templates_studio_owner_update')
    ) as v(tbl, sel, ins, upd)
  loop
    if not (select c.relrowsecurity from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = t.tbl) then
      raise exception '0339: row level security must stay enabled on public.%', t.tbl;
    end if;
    if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = t.tbl
                    and policyname = t.sel and cmd = 'SELECT') then
      raise exception '0339: % must remain', t.sel;
    end if;
    select string_agg(policyname || ' (' || cmd || ')', ', ' order by policyname) into v_bad
      from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = t.tbl and cmd <> 'SELECT'
       and not (((policyname = t.ins and cmd = 'INSERT') or (policyname = t.upd and cmd = 'UPDATE'))
                and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'is_studio_owner'
                and coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'is_studio_member');
    if v_bad is not null then
      raise exception '0339: unexpected write policy on public.%: %', t.tbl, v_bad;
    end if;
    if (select count(*) from pg_catalog.pg_policies
         where schemaname = 'public' and tablename = t.tbl and cmd <> 'SELECT') <> 2 then
      raise exception '0339: public.% must have exactly two write policies', t.tbl;
    end if;
  end loop;
end $$;

commit;
