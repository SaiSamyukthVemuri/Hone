-- 0345: session_audit rows are written only by the governed session commands. A studio member has no direct INSERT.
-- PRIVILEGE ONLY: one policy dropped, INSERT revoked. No table, column, index, function, trigger or data is created, changed or read.
-- NOT APPLIED. Number 0345 claimed by OPS. Hosted apply needs the owner's per-change approval.
--
-- THE RULE. A session's change history is written only by the governed session commands (edit_session_started_at, 0167; soft_delete_session_area,
-- 0123; finalize_session, 0119, retired by 0159), as the function owner, in the same transaction as the change they record. A member has no
-- direct INSERT.
--
-- WHAT THIS CHANGES
--   * drops the 0008/0117 member INSERT policy "session_audit_studio_member_insert";
--   * revokes INSERT on session_audit, at table and at column level, from public, anon and authenticated, by name (an ACL denial that no other
--     permissive policy can undo; column-level grants cannot provide a way around it). Same pattern as 0242 for audit_logs;
--   * fails the whole migration if any direct INSERT path remains for those roles, or if an INSERT policy remains.
--
-- UNCHANGED ON PURPOSE
--   * The SELECT policy (0008, gated by 0333) and the absence of UPDATE and DELETE policies.
--   * The three commands above: they run as the table owner and are not subject to row-level security or to these revokes.
--   * service_role and the table owner: untouched, no grant is created.
--   * Existing rows: none is read, rewritten or removed.
-- Rollback: supabase/rollbacks/0345_session_audit_member_insert_closed.down.sql (an operator file, never run by supabase).

begin;
set local lock_timeout = '5s';

drop policy if exists "session_audit_studio_member_insert" on public.session_audit;

revoke insert on table public.session_audit from public, anon, authenticated;
do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = 'public.session_audit'::regclass
        and a.attnum > 0 and not a.attisdropped
  loop
    execute format('revoke insert (%I) on table public.session_audit from public, anon, authenticated', v_column);
  end loop;

  if has_table_privilege('anon', 'public.session_audit', 'INSERT')
     or has_table_privilege('authenticated', 'public.session_audit', 'INSERT')
     or has_any_column_privilege('anon', 'public.session_audit', 'INSERT')
     or has_any_column_privilege('authenticated', 'public.session_audit', 'INSERT') then
    raise exception 'Direct session_audit inserts remain permitted';
  end if;
  -- PUBLIC is a pseudo-role: has_*_privilege('anon', ...) would also report it, but name it so a stray PUBLIC grant is never overlooked.
  if exists (
    select 1
      from pg_catalog.pg_class c, lateral pg_catalog.aclexplode(c.relacl) a
     where c.oid = 'public.session_audit'::regclass and a.grantee = 0 and a.privilege_type = 'INSERT'
  ) or exists (
    select 1
      from pg_catalog.pg_attribute pa, lateral pg_catalog.aclexplode(pa.attacl) a
     where pa.attrelid = 'public.session_audit'::regclass and pa.attacl is not null and a.grantee = 0 and a.privilege_type = 'INSERT'
  ) then
    raise exception 'A PUBLIC INSERT grant on session_audit remains';
  end if;
  if exists (
    select 1 from pg_catalog.pg_policy p
     where p.polrelid = 'public.session_audit'::regclass and p.polcmd in ('a', '*')
  ) then
    raise exception 'A session_audit INSERT policy remains';
  end if;
  -- The read side must still be there: this migration closes writes, it must not be able to hide history from the people who read it.
  if not exists (
    select 1 from pg_catalog.pg_policy p
     where p.polrelid = 'public.session_audit'::regclass and p.polcmd = 'r'
  ) then
    raise exception 'session_audit SELECT policy is missing';
  end if;
end;
$$;

commit;
