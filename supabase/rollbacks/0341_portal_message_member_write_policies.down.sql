-- Down for 0341. Restores exactly what 0341 removed and nothing broader:
--   INSERT and UPDATE on the two tables for anon and authenticated (the state before this migration), and
--   the three 0055 member write policies with their original definitions.
-- PUBLIC is granted nothing. Touches no data. Run it only if 0341 blocks a legitimate write.
begin;

set local lock_timeout = '5s';

grant insert, update on table public.client_portal_messages to anon, authenticated;
grant insert, update on table public.client_portal_message_replies to anon, authenticated;

drop policy if exists "client_portal_messages_studio_member_insert" on public.client_portal_messages;
create policy "client_portal_messages_studio_member_insert"
  on public.client_portal_messages for insert
  to authenticated
  with check (public.is_studio_member(studio_id));

drop policy if exists "client_portal_messages_studio_member_update" on public.client_portal_messages;
create policy "client_portal_messages_studio_member_update"
  on public.client_portal_messages for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

drop policy if exists "client_portal_message_replies_studio_member_update" on public.client_portal_message_replies;
create policy "client_portal_message_replies_studio_member_update"
  on public.client_portal_message_replies for update
  to authenticated
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

commit;
