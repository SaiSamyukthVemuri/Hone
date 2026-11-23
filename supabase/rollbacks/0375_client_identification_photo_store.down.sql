-- DOWN for 0375. EMERGENCY ONLY.
--
-- THIS DESTROYS CONSENT EVIDENCE. It drops the seven tables of the identification-photo
-- store, including the append-only consent and withdrawal records, the switch log and the
-- audit trail. They are immutable by design and cannot be recreated from anything else.
-- Use it only to back out an apply before any real use, or on an explicit owner decision.
--
-- STORAGE OBJECTS MUST BE DRAINED FIRST. This file never touches storage. It refuses while
-- any stored photo row or any pending object deletion exists, because dropping those rows
-- would leave face images in the private bucket that nothing could find or delete. Drain
-- the queue through the Storage API and acknowledge each path (the same drain the app uses),
-- confirm both tables are empty, then run this. The private bucket itself is NOT removed
-- here: SQL cannot delete storage objects. Remove it through the Storage API once it is empty.
--
-- It restores what 0375 changed outside its own tables:
--   * set_client_portrait(uuid, uuid, uuid) gets back the grants it had before 0375:
--     EXECUTE for authenticated only, nothing for public, anon or service_role. The
--     treatment-photo portrait stays off in the application either way.
--   * the pointer guard trigger on clients (portrait_image_id) is dropped.
--   * the client-archive trigger on clients is dropped.
-- Dropping the triggers takes a brief ACCESS EXCLUSIVE lock on clients, bounded by the lock
-- timeout below; if clients is busy the file fails and changes nothing.
begin;
set local lock_timeout = '5s';

-- Locks BEFORE the checks, so nothing can be added between the check and the drop.
lock table public.client_id_photos, public.client_id_photo_pending_object_deletions in access exclusive mode;

do $$
begin
  if exists (select 1 from public.client_id_photos) then
    raise exception 'down refused: stored identification photos still exist; remove them and drain the storage objects first' using errcode = 'P0375';
  end if;
  if exists (select 1 from public.client_id_photo_pending_object_deletions) then
    raise exception 'down refused: storage objects are still queued for deletion; drain and acknowledge them first' using errcode = 'P0375';
  end if;
end;
$$;

drop trigger if exists client_id_photo_on_client_archive on public.clients;
drop trigger if exists clients_portrait_pointer_frozen on public.clients;

drop table if exists public.client_id_photo_pending_object_deletions;
drop table if exists public.client_id_photo_audit;
drop table if exists public.client_id_photos;
drop table if exists public.client_id_photo_consents;
drop table if exists public.studio_client_id_photo_switch_log;
drop table if exists public.studio_client_id_photo_settings;
drop table if exists public.client_id_photo_wording_versions;

drop function if exists public.approve_client_id_photo_wording(text);
drop function if exists public.set_client_id_photo_enabled(uuid, boolean, text);
drop function if exists public.ack_client_id_photo_object_deletion(text);
drop function if exists public.pending_client_id_photo_object_deletions(integer);
drop function if exists public.remove_client_id_photo(uuid);
drop function if exists public.set_client_id_photo(uuid, text, integer, integer, integer);
drop function if exists public.reserve_client_id_photo_path(uuid);
drop function if exists public.withdraw_client_id_photo_consent(uuid);
drop function if exists public.record_client_id_photo_consent(uuid, text, text, text, text);
drop function if exists public.client_id_photo_enabled(uuid);
drop function if exists public.client_id_photo_wording_current(uuid);
drop function if exists public.client_id_photo_can_read(uuid, uuid);
drop function if exists public.client_id_photo_consent_granted(uuid, uuid);
drop function if exists public.client_id_photo_switch_on(uuid);
drop function if exists public.client_id_photo_actor(uuid);
drop function if exists public.client_id_photo_on_client_archive();
drop function if exists public.client_id_photo_queue_object();
drop function if exists public.studio_client_id_photo_switch_log_write();
drop function if exists public.client_id_photo_wording_guard();
drop function if exists public.client_id_photo_immutable();
drop function if exists public.clients_portrait_pointer_frozen();

-- Back to the grants 0231 left: authenticated only.
grant execute on function public.set_client_portrait(uuid, uuid, uuid) to authenticated;

commit;
