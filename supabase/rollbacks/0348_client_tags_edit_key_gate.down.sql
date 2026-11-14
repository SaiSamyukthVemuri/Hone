-- Rollback of 0348: restore the 0087 member INSERT and UPDATE policies on client_tags (active-member check only).
-- Reversing this lets any active member of the studio add and remove client tags regardless of the client.edit_tags permission.
begin;
set local lock_timeout = '5s';

alter policy client_tags_member_insert on public.client_tags to authenticated
  with check (public.is_studio_member(studio_id));

alter policy client_tags_member_update on public.client_tags to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

commit;
