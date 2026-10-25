-- 0242 PAUSE GUARD (window-scoped, NOT a migration, NOT a bridge publication).
-- Run by the S1 DB operator immediately BEFORE 0213-0246 are applied; removed
-- by 0242-pause-guard.down.sql once the new app (S3) is READY. While it
-- exists, a browser-role (authenticated/anon) write to clients.archived_at or
-- clients.archived_by is refused, so the OLD app cannot complete an archive or
-- unarchive whose audit write 0242 will refuse (client UPDATE commits before
-- the audit INSERT in the old action). It touches no other column, no other
-- role (owner, service_role and migrations are unaffected) and no audit table.
begin;
set local lock_timeout = '5s';

create function public.pause_client_archive_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.archived_at is distinct from old.archived_at
      or new.archived_by is distinct from old.archived_by)
     and pg_catalog.current_user in ('authenticated', 'anon') then
    raise exception 'client archive and unarchive are paused' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all privileges on function public.pause_client_archive_guard()
  from public, anon, authenticated, service_role;

create trigger clients_00_pause_archive_trg
  before update of archived_at, archived_by on public.clients
  for each row execute function public.pause_client_archive_guard();

commit;
