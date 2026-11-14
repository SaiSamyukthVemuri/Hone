-- Rollback of 0343: restore the membership-only INSERT/UPDATE policies exactly as 0087 / 0183 / 0022 defined them.
-- (client_pinned_notes_studio_member_insert returns to its 0022 role set, public, and its practitioners subquery.)
begin;
set local lock_timeout = '5s';

alter policy treatment_goals_studio_member_insert on public.treatment_goals to authenticated
  with check (public.is_studio_member(studio_id));
alter policy treatment_goals_studio_member_update on public.treatment_goals to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
alter policy client_personal_notes_studio_member_insert on public.client_personal_notes to authenticated
  with check (public.is_studio_member(studio_id));
alter policy client_personal_notes_studio_member_update on public.client_personal_notes to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

alter policy client_pinned_notes_studio_member_insert on public.client_pinned_notes to public
  with check (studio_id in (select studio_id from public.practitioners where user_id = auth.uid() and active = true));

alter policy client_budget_context_member_insert on public.client_budget_context to authenticated
  with check (
    public.is_studio_member(client_budget_context.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );
alter policy client_budget_context_member_update on public.client_budget_context to authenticated
  using (public.is_studio_member(client_budget_context.studio_id))
  with check (
    public.is_studio_member(client_budget_context.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_budget_context.updated_by_practitioner_id
        and p.studio_id = client_budget_context.studio_id
        and p.user_id = (select auth.uid())
        and p.active
    )
  );

commit;
