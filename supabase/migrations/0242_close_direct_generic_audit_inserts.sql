-- SEC-003. OPS source allocation only: no apply/release authority.
-- Application-first: archive/unarchive/export must use their narrow trusted
-- server writer before closing the old direct member INSERT path.
-- Historical generic rows remain unverified; none are rewritten or removed.
begin;
set local lock_timeout = '5s';

-- This is the permissive member INSERT policy in both0001 and pending0233.
-- Existing SELECT policies and the actor-bound clinical command stay intact.
drop policy if exists "audit_logs: members insert" on public.audit_logs;

-- ACL denial is independent of any other permissive RLS policy. PUBLIC must
-- be included, and column-level INSERT grants must not provide a back door.
revoke insert on table public.audit_logs from public, anon, authenticated;
do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname from pg_catalog.pg_attribute a
      where a.attrelid = 'public.audit_logs'::regclass
        and a.attnum > 0 and not a.attisdropped
  loop
    execute format('revoke insert (%I) on table public.audit_logs from public, anon, authenticated', v_column);
  end loop;

  if has_table_privilege('anon', 'public.audit_logs', 'INSERT')
     or has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
     or has_any_column_privilege('anon', 'public.audit_logs', 'INSERT')
     or has_any_column_privilege('authenticated', 'public.audit_logs', 'INSERT') then
    raise exception 'Direct generic audit inserts remain permitted';
  end if;
  -- Preserve existing trusted authority; do NOT manufacture a new grant if
  -- this environment does not have the expected service writer privilege.
  if not has_table_privilege('service_role', 'public.audit_logs', 'INSERT') then
    raise exception 'Existing trusted audit writer privilege is unavailable';
  end if;
end;
$$;

commit;
