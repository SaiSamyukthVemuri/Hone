-- 0088_exposure_incident_owner_access.sql (PR #222)
--
-- Privacy hardening before any studio adds a second practitioner:
-- exposure incident records carry sensitive personal/health
-- information (exposed person's full name, address, phone, exposure
-- details, action taken, staff involved), so reading the history and
-- editing records becomes OWNER-ONLY. Any active studio member can
-- still FILE a new incident (a staff member must be able to report
-- an exposure without being able to browse the full history).
--
-- Policy-only migration: no schema change, no data change, no
-- backfill, no grants, no anon policies. Re-runnable (every create
-- is preceded by drop if exists). Deliberately still NO DELETE
-- policy: these remain inspection-style logbook records.
--
-- Final posture for public.record_keeping_exposure_incidents:
--   SELECT  owner-only   is_studio_owner(studio_id)
--   INSERT  member       is_studio_member(studio_id)   (unchanged)
--   UPDATE  owner-only   is_studio_owner(studio_id) USING + WITH CHECK
--   DELETE  no policy                                  (unchanged)
--
-- Companion change on public.record_keeping_audit_events (SELECT
-- policy only; immutability posture untouched): exposure-incident
-- audit rows carry old/new field values in `changes`, so without a
-- carve-out a non-owner member could read the same sensitive data
-- through the audit table that the new owner tier hides. Members
-- keep reading all other record-type audit rows; exposure-incident
-- audit rows become owner-only.

begin;

-- 1. Exposure incidents: history and corrections are owner-only ---------------

drop policy if exists "record_keeping_exposure_incidents: members select"
  on public.record_keeping_exposure_incidents;
drop policy if exists "record_keeping_exposure_incidents: owner select"
  on public.record_keeping_exposure_incidents;
create policy "record_keeping_exposure_incidents: owner select"
  on public.record_keeping_exposure_incidents for select to authenticated
  using (public.is_studio_owner(studio_id));

drop policy if exists "record_keeping_exposure_incidents: members update"
  on public.record_keeping_exposure_incidents;
drop policy if exists "record_keeping_exposure_incidents: owner update"
  on public.record_keeping_exposure_incidents;
create policy "record_keeping_exposure_incidents: owner update"
  on public.record_keeping_exposure_incidents for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

-- Reporting stays member-wide. Recreated (same expression as 0085)
-- so this file documents the table's complete posture.
drop policy if exists "record_keeping_exposure_incidents: members insert"
  on public.record_keeping_exposure_incidents;
create policy "record_keeping_exposure_incidents: members insert"
  on public.record_keeping_exposure_incidents for insert to authenticated
  with check (public.is_studio_member(studio_id));

-- Deliberately NO delete policy (unchanged from 0085).

-- 2. Audit events: exposure-incident rows are owner-only to read --------------

drop policy if exists "record_keeping_audit_events: members select"
  on public.record_keeping_audit_events;
create policy "record_keeping_audit_events: members select"
  on public.record_keeping_audit_events for select to authenticated
  using (
    public.is_studio_member(studio_id)
    and (
      record_type <> 'exposure_incident'
      or public.is_studio_owner(studio_id)
    )
  );

-- 3. Validate the final posture before committing ------------------------------

do $$
declare
  v_select int;
  v_insert int;
  v_update int;
  v_delete int;
  v_all int;
  v_audit_select int;
  v_audit_other int;
begin
  select count(*) into v_select from pg_policy
    where polrelid = 'public.record_keeping_exposure_incidents'::regclass
      and polcmd = 'r'
      and pg_get_expr(polqual, polrelid) = 'is_studio_owner(studio_id)';
  select count(*) into v_insert from pg_policy
    where polrelid = 'public.record_keeping_exposure_incidents'::regclass
      and polcmd = 'a'
      and pg_get_expr(polwithcheck, polrelid) = 'is_studio_member(studio_id)';
  select count(*) into v_update from pg_policy
    where polrelid = 'public.record_keeping_exposure_incidents'::regclass
      and polcmd = 'w'
      and pg_get_expr(polqual, polrelid) = 'is_studio_owner(studio_id)'
      and pg_get_expr(polwithcheck, polrelid) = 'is_studio_owner(studio_id)';
  select count(*) into v_delete from pg_policy
    where polrelid = 'public.record_keeping_exposure_incidents'::regclass
      and polcmd = 'd';
  select count(*) into v_all from pg_policy
    where polrelid = 'public.record_keeping_exposure_incidents'::regclass
      and polcmd = '*';
  select count(*) into v_audit_select from pg_policy
    where polrelid = 'public.record_keeping_audit_events'::regclass
      and polcmd = 'r'
      and pg_get_expr(polqual, polrelid) like '%exposure_incident%'
      and pg_get_expr(polqual, polrelid) like '%is_studio_owner%';
  select count(*) into v_audit_other from pg_policy
    where polrelid = 'public.record_keeping_audit_events'::regclass
      and polcmd <> 'r';
  if v_select <> 1 or v_insert <> 1 or v_update <> 1
     or v_delete <> 0 or v_all <> 0
     or v_audit_select <> 1 or v_audit_other <> 0 then
    raise exception
      'exposure incident posture validation failed: select=% insert=% update=% delete=% all=% audit_select=% audit_other=%',
      v_select, v_insert, v_update, v_delete, v_all, v_audit_select, v_audit_other;
  end if;
end $$;

commit;
