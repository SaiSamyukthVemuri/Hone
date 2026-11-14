-- Down for 0339: restore the four original member-level write policies, predicates verbatim
-- (services: 0173; consent_form_templates: 0057). This touches no data. It restores membership-level writes on
-- both tables; run it only if the owner-only policies block a legitimate owner write.
-- ON A DATABASE THAT HAS 0302 (hosted): run only the consent_form_templates half. The services owner policies there
-- belong to 0302, and restoring services_member_* would undo 0302. When 0302's file lands in this repository, this
-- down drops its services half.
begin;

set local lock_timeout = '5s';

drop policy if exists "services_owner_insert" on public.services;
drop policy if exists "services_member_insert" on public.services;
create policy "services_member_insert"
  on public.services for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "services_owner_update" on public.services;
drop policy if exists "services_member_update" on public.services;
create policy "services_member_update"
  on public.services for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "consent_form_templates_studio_owner_insert" on public.consent_form_templates;
drop policy if exists "consent_form_templates_studio_member_insert" on public.consent_form_templates;
create policy "consent_form_templates_studio_member_insert"
  on public.consent_form_templates for insert to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "consent_form_templates_studio_owner_update" on public.consent_form_templates;
drop policy if exists "consent_form_templates_studio_member_update" on public.consent_form_templates;
create policy "consent_form_templates_studio_member_update"
  on public.consent_form_templates for update to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

commit;
