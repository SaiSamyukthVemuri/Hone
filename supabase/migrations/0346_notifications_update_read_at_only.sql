-- 0346: members may only mark notifications read.
-- PRIVILEGE ONLY: UPDATE on public.practitioner_notifications is narrowed to the single column read_at. No table, column, index, policy, function,
-- trigger or data is created, changed or read.
-- NOT APPLIED. Number 0346 claimed by OPS. Hosted apply needs the owner's per-change approval.
--
-- THE RULE. The only write a signed-in member makes to a notification is stamping it read. Notifications are created by the server (the service
-- role and database commands, which are unaffected) and are not edited afterwards.
--
-- WHAT THIS CHANGES
--   * revokes UPDATE on practitioner_notifications from public, anon and authenticated, by name, at table level and at column level;
--   * grants UPDATE (read_at) to authenticated, nothing else;
--   * fails the whole migration if any other column is updatable by anon or authenticated, if read_at is not updatable by authenticated, or if a
--     PUBLIC update grant remains. A column added later is not updatable by default, because no table-level grant is left.
--
-- UNCHANGED ON PURPOSE
--   * The UPDATE and SELECT policies (they still decide which rows a member can see and mark read), and the absence of INSERT and DELETE policies.
--   * service_role and the table owner: untouched, no grant is created for them. Existing rows: none is read, rewritten or removed.
-- Rollback: supabase/rollbacks/0346_notifications_update_read_at_only.down.sql (an operator file, never run by supabase).

begin;
set local lock_timeout = '5s';

revoke update on table public.practitioner_notifications from public, anon, authenticated;
do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = 'public.practitioner_notifications'::regclass
        and a.attnum > 0 and not a.attisdropped
  loop
    execute format('revoke update (%I) on table public.practitioner_notifications from public, anon, authenticated', v_column);
  end loop;
end;
$$;

grant update (read_at) on table public.practitioner_notifications to authenticated;

do $$
declare
  v_column text;
begin
  if has_table_privilege('anon', 'public.practitioner_notifications', 'UPDATE')
     or has_table_privilege('authenticated', 'public.practitioner_notifications', 'UPDATE') then
    raise exception 'A table-level UPDATE grant remains on practitioner_notifications';
  end if;
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = 'public.practitioner_notifications'::regclass
        and a.attnum > 0 and not a.attisdropped
  loop
    if has_column_privilege('anon', 'public.practitioner_notifications', v_column, 'UPDATE') then
      raise exception 'anon can update a notification column: %', v_column;
    end if;
    if v_column <> 'read_at' and has_column_privilege('authenticated', 'public.practitioner_notifications', v_column, 'UPDATE') then
      raise exception 'authenticated can update a notification column other than read_at: %', v_column;
    end if;
  end loop;
  if not has_column_privilege('authenticated', 'public.practitioner_notifications', 'read_at', 'UPDATE') then
    raise exception 'authenticated cannot mark notifications read';
  end if;
  -- PUBLIC is a pseudo-role: has_*_privilege('anon', ...) would also report it, but name it so a stray PUBLIC grant is never overlooked.
  if exists (
    select 1
      from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) a
     where c.oid = 'public.practitioner_notifications'::regclass and a.grantee = 0 and a.privilege_type = 'UPDATE'
  ) or exists (
    select 1
      from pg_catalog.pg_attribute pa, lateral pg_catalog.aclexplode(pa.attacl) a
     where pa.attrelid = 'public.practitioner_notifications'::regclass and pa.attacl is not null and a.grantee = 0 and a.privilege_type = 'UPDATE'
  ) then
    raise exception 'A PUBLIC UPDATE grant on practitioner_notifications remains';
  end if;
end;
$$;

commit;
