-- ===========================================================================
-- 0233 — HON-46: the clinical-records audit is ACTOR-BOUND (Codex P1 4304545551)
-- ===========================================================================
--
-- The HON-46 export writes `clinical_records_previewed` / `_printed` rows to
-- audit_logs as its #828 G-13 record of who looked at or printed a client's
-- clinical record. Until now it inserted them directly, under 0001's
-- "audit_logs: members insert" policy, which checks ONLY is_studio_member.
-- So any active member could write such a row through PostgREST themselves,
-- naming ANY practitioner of the studio as actor_id: a forged record of
-- someone else having printed a clinical record.
--
-- Section by section:
--
--   1. record_clinical_records_audit(client, action, metadata, id) -- the ONE
--      way these two events are written. SECURITY DEFINER; the studio is the
--      client's, and the actor is derived from auth.uid() as that studio's
--      ACTIVE OWNER (the export is owner-only). The action and the metadata
--      keys/values are allow-listed. Values are SHAPED (HIPAA review F2):
--      day/from/to are YYYY-MM-DD, session_id/preview_audit_id are UUIDs, and
--      the key set matches the scope (day: day; range: from+to; session:
--      session_id). A PRINT must cite, as preview_audit_id, an existing
--      clinical_records_previewed row for the SAME client, actor and studio
--      (F3). Every violation raises 22023. Execute: authenticated only,
--      revoked from public, anon AND service_role by name (the 0129/0164
--      lesson).
--   2. audit_actor_is_caller(actor, studio) -- a SECURITY DEFINER predicate
--      for the narrowed policy (it reads practitioners regardless of the
--      caller's own visibility of that table, exactly like is_studio_member).
--   3. "audit_logs: members insert" is REPLACED by a narrower policy: still a
--      member of the row's studio, AND the actor is the caller's OWN
--      practitioner row in that studio, AND the action is not
--      clinical_records_*. The two remaining member-path writers already
--      satisfy it (client_archived / client_unarchived in
--      app/(app)/clients/[id]/actions.ts, studio_export in
--      app/(app)/settings/data/actions.ts: both send actor_id =
--      practitioner.id of the signed-in practitioner). The Twilio inbound
--      route writes through the service-role client, which bypasses RLS, and
--      is unaffected.
--
-- Rolling back: re-create 0001's policy and drop the two functions; the
-- application must first be rolled back to the direct insert.

begin;

set local lock_timeout = '5s';

-- 2. The predicate, created first so the policy can reference it.
create or replace function public.audit_actor_is_caller(target_actor_id uuid, target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select target_actor_id is not null and exists (
    select 1
    from public.practitioners p
    where p.id = target_actor_id
      and p.studio_id = target_studio_id
      and p.user_id = auth.uid()
      and p.active = true
  );
$$;

-- 1. The command.
create or replace function public.record_clinical_records_audit(
  p_client_id uuid,
  p_action text,
  p_metadata jsonb,
  p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_studio uuid;
  v_actor uuid;
  v_key text;
  v_value jsonb;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('clinical_records_previewed', 'clinical_records_printed') then
    raise exception 'unsupported clinical-records audit action' using errcode = '22023';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'metadata must be an object' using errcode = '22023';
  end if;
  -- Allow-listed keys only, string values only: the scope that was looked at
  -- and the preview a print was bound to. Never a name, a note or free text.
  for v_key, v_value in select key, value from jsonb_each(p_metadata) loop
    if v_key not in ('scope', 'day', 'from', 'to', 'session_id', 'preview_audit_id') then
      raise exception 'metadata key % is not allowed', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 64 then
      raise exception 'metadata value for % must be a short string', v_key using errcode = '22023';
    end if;
  end loop;
  if not (p_metadata ? 'scope') or (p_metadata ->> 'scope') not in ('session', 'day', 'range') then
    raise exception 'metadata.scope must be session, day or range' using errcode = '22023';
  end if;
  -- VALUE SHAPES (HIPAA review F2): dates are YYYY-MM-DD, ids are UUIDs.
  if exists (
    select 1 from jsonb_each_text(p_metadata) e
     where e.key in ('day', 'from', 'to') and e.value !~ '^\d{4}-\d{2}-\d{2}$'
  ) then
    raise exception 'metadata dates must be YYYY-MM-DD' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each_text(p_metadata) e
     where e.key in ('session_id', 'preview_audit_id')
       and e.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'metadata ids must be UUIDs' using errcode = '22023';
  end if;
  -- THE KEY SET MATCHES THE SCOPE (F2): exactly the keys that scope uses.
  if (p_metadata ->> 'scope') = 'day'
     and (not (p_metadata ? 'day') or p_metadata ?| array['from', 'to', 'session_id']) then
    raise exception 'scope day requires day and nothing else' using errcode = '22023';
  end if;
  if (p_metadata ->> 'scope') = 'range'
     and (not (p_metadata ?& array['from', 'to']) or p_metadata ?| array['day', 'session_id']) then
    raise exception 'scope range requires from and to and nothing else' using errcode = '22023';
  end if;
  if (p_metadata ->> 'scope') = 'session'
     and (not (p_metadata ? 'session_id') or p_metadata ?| array['day', 'from', 'to']) then
    raise exception 'scope session requires session_id and nothing else' using errcode = '22023';
  end if;
  if p_action = 'clinical_records_previewed' and p_metadata ? 'preview_audit_id' then
    raise exception 'a preview does not reference a preview' using errcode = '22023';
  end if;
  if p_action = 'clinical_records_printed' and not (p_metadata ? 'preview_audit_id') then
    raise exception 'a print must reference the preview it printed' using errcode = '22023';
  end if;

  -- The studio is the CLIENT's; the actor is the caller's own active OWNER
  -- row in that studio. Nothing about either is taken from the arguments.
  select c.studio_id into v_studio from public.clients c where c.id = p_client_id;
  if v_studio is null then
    raise exception 'client not found' using errcode = '42501';
  end if;
  select p.id into v_actor
    from public.practitioners p
   where p.studio_id = v_studio
     and p.user_id = v_uid
     and p.active = true
     and p.role = 'owner';
  if v_actor is null then
    raise exception 'only the studio owner can record a clinical-records export' using errcode = '42501';
  end if;
  -- A PRINT CITES A REAL PREVIEW (HIPAA review F3): an existing
  -- clinical_records_previewed row for the SAME client, actor and studio.
  if p_action = 'clinical_records_printed' and not exists (
    select 1 from public.audit_logs a
     where a.id = (p_metadata ->> 'preview_audit_id')::uuid
       and a.action = 'clinical_records_previewed'
       and a.entity_id = p_client_id
       and a.actor_id = v_actor
       and a.studio_id = v_studio
  ) then
    raise exception 'the cited preview is not this owner''s preview of this client' using errcode = '22023';
  end if;

  insert into public.audit_logs (id, studio_id, actor_id, action, entity_type, entity_id, metadata)
  values (coalesce(p_id, gen_random_uuid()), v_studio, v_actor, p_action, 'client', p_client_id, p_metadata)
  returning id into v_id;
  return v_id;
end;
$$;

-- 3. Narrow direct member inserts.
drop policy if exists "audit_logs: members insert" on public.audit_logs;
create policy "audit_logs: members insert" on public.audit_logs
  for insert to authenticated
  with check (
    public.is_studio_member(studio_id)
    and public.audit_actor_is_caller(actor_id, studio_id)
    and action not like 'clinical_records\_%'
  );

-- Grants. Supabase's ALTER DEFAULT PRIVILEGES grants every new function to
-- anon, authenticated AND service_role; PostgreSQL grants PUBLIC. Revoke each
-- by name, then grant only what is meant.
revoke execute on function public.record_clinical_records_audit(uuid, text, jsonb, uuid) from public;
revoke execute on function public.record_clinical_records_audit(uuid, text, jsonb, uuid) from anon;
revoke execute on function public.record_clinical_records_audit(uuid, text, jsonb, uuid) from service_role;
grant execute on function public.record_clinical_records_audit(uuid, text, jsonb, uuid) to authenticated;

-- The policy predicate runs as the inserting role, so authenticated needs it.
revoke execute on function public.audit_actor_is_caller(uuid, uuid) from public;
revoke execute on function public.audit_actor_is_caller(uuid, uuid) from anon;
revoke execute on function public.audit_actor_is_caller(uuid, uuid) from service_role;
grant execute on function public.audit_actor_is_caller(uuid, uuid) to authenticated;

commit;
