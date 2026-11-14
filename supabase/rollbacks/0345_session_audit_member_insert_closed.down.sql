-- Rollback of 0345: restore the member INSERT policy exactly as 0117 defined it, and the table INSERT grant to authenticated.
-- Reversing this re-opens hand-written session_audit rows (free field, values and edited_at) to any active member of the studio.
-- Only `authenticated` gets its grant back: anon and PUBLIC were revoked by 0336 where it is applied, and the policy below can never pass for them
-- (it needs auth.uid()), so they are not re-granted. No column-level grant existed before 0345, so none is recreated.
begin;
set local lock_timeout = '5s';

grant insert on table public.session_audit to authenticated;

drop policy if exists "session_audit_studio_member_insert" on public.session_audit;
create policy "session_audit_studio_member_insert"
  on public.session_audit for insert
  with check (
    edited_by_practitioner_id in (
      select id from public.practitioners
      where user_id = auth.uid() and active = true
    )
    and session_id in (
      select s.id
      from public.sessions s
      join public.clients c on s.client_id = c.id
      where c.studio_id in (
        select studio_id from public.practitioners
        where user_id = auth.uid() and active = true
      )
    )
  );

commit;
