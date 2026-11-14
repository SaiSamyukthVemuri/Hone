-- 0348: client tags can be added and removed only by someone who holds the tag-edit permission.
-- POLICY ONLY: the member INSERT and UPDATE policies on client_tags also require the client.edit_tags permission, evaluated by the existing
-- has_studio_permission engine (0287). No table, column, grant, trigger, function or data is created, changed or read.
-- NOT APPLIED. Number 0348 claimed by OPS. Hosted apply needs the owner's per-change approval.
--
-- THE RULE. An active member of the studio may write a client's tags only while the engine allows client.edit_tags for them. The owner always
-- does. While no studio has turned the key off, every member keeps exactly what they have today (the engine resolves an unset key to the
-- studio's recorded starting policy), so this changes nothing until an owner narrows the key.
-- Removing a tag is an UPDATE (it sets deleted_at and deleted_by), so one UPDATE policy covers add, rename and remove. DELETE stays closed (0087).
-- SELECT is unchanged: reading tags is the separate client.view_tags permission and is not part of this change.
--
-- FAIL-CLOSED GUARD (inside this migration). The engine answers "no" for every member when its catalogue row for the key is missing, or when
-- authenticated cannot execute it. Either would lock tag writing for everyone, so the migration refuses to apply in those states. (A studio
-- with no recorded policy row is NOT such a state: the engine treats it as the existing-studio starting policy.)
-- Rollback: supabase/rollbacks/0348_client_tags_edit_key_gate.down.sql (an operator file, never run by supabase).

begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.permission_catalog where key = 'client.edit_tags') then
    raise exception '0348: permission_catalog has no client.edit_tags row; gating on it would deny every member';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.has_studio_permission(uuid,text,uuid,uuid,uuid)', 'EXECUTE') then
    raise exception '0348: authenticated cannot execute has_studio_permission';
  end if;
end $$;

alter policy client_tags_member_insert on public.client_tags to authenticated
  with check (
    public.is_studio_member(studio_id)
    and public.has_studio_permission(studio_id, 'client.edit_tags', client_id)
  );

alter policy client_tags_member_update on public.client_tags to authenticated
  using (
    public.is_studio_member(studio_id)
    and public.has_studio_permission(studio_id, 'client.edit_tags', client_id)
  )
  with check (
    public.is_studio_member(studio_id)
    and public.has_studio_permission(studio_id, 'client.edit_tags', client_id)
  );

do $$
declare
  r record;
  v_found int := 0;
begin
  for r in
    select p.polname, p.polcmd,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) as q,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) as w
      from pg_catalog.pg_policy p
     where p.polrelid = 'public.client_tags'::regclass
  loop
    if r.polcmd in ('a', 'w') then
      v_found := v_found + 1;
      if coalesce(r.w, '') !~ 'has_studio_permission' or coalesce(r.w, '') !~ 'client\.edit_tags'
         or (r.polcmd = 'w' and (coalesce(r.q, '') !~ 'has_studio_permission' or coalesce(r.q, '') !~ 'client\.edit_tags')) then
        raise exception '0348: policy % on client_tags does not require client.edit_tags', r.polname;
      end if;
    elsif r.polcmd in ('d', '*') then
      raise exception '0348: unexpected DELETE or ALL policy % on client_tags', r.polname;
    end if;
  end loop;
  if v_found <> 2 then
    raise exception '0348: expected exactly one INSERT and one UPDATE policy on client_tags, found %', v_found;
  end if;
end $$;

commit;
