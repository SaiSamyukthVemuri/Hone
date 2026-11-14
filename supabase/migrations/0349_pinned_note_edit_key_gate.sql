-- 0349: editing a pinned caution requires the allergies-and-cautions edit permission.
-- FUNCTION ONLY: edit_client_pinned_note (0254) is replaced with the same signature, security attributes, author-or-owner rule and audit row, plus
-- one added check. No table, policy, trigger, grant or data is created, changed or read.
-- NOT APPLIED. Number 0349 claimed by OPS. Hosted apply needs the owner's per-change approval.
--
-- THE RULE. A member may edit a pinned caution only while the permission engine allows client.edit_allergies_cautions for them (the safety group's edit key, separate from the
-- clinical record). The owner always may. Everything else is as before: the caller comes from the session, the note must belong
-- to the named studio and client, and a non-owner may edit only their own notes. A refused call answers false, the same answer a missing or
-- stale note gets, so nothing about the note is disclosed. While no studio has turned the key off, every member keeps what they have today.
--
-- FAIL-CLOSED GUARD (inside this migration). The engine answers "no" for every member when its catalogue row for the key is missing or when
-- authenticated cannot execute it, which would stop every pinned-caution edit, so the migration refuses to apply in those states. It also
-- checks that the replaced function is still SECURITY DEFINER with a fixed search_path and that only authenticated can execute it.
-- Rollback: supabase/rollbacks/0349_pinned_note_edit_key_gate.down.sql (an operator file, never run by supabase).

begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.permission_catalog where key = 'client.edit_allergies_cautions') then
    raise exception '0349: permission_catalog has no client.edit_allergies_cautions row; gating on it would deny every member';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.has_studio_permission(uuid,text,uuid,uuid,uuid)', 'EXECUTE') then
    raise exception '0349: authenticated cannot execute has_studio_permission';
  end if;
end $$;

create or replace function public.edit_client_pinned_note(
  p_studio_id     uuid,
  p_client_id     uuid,
  p_note_id       uuid,
  p_original_text text,
  p_text          text
) returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_actor uuid;
  v_role  text;
  v_rows  integer;
begin
  if p_studio_id is null or p_client_id is null or p_note_id is null
     or p_original_text is null or p_text is null then
    return false;
  end if;
  if pg_catalog.length(p_text) < 1 or pg_catalog.length(p_text) > 200 then
    return false;
  end if;

  select p.id, p.role into v_actor, v_role
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active is true;
  if v_actor is null then
    return false;
  end if;

  if not public.has_studio_permission(p_studio_id, 'client.edit_allergies_cautions', p_client_id) then
    return false;
  end if;

  update public.client_pinned_notes n
     set text = p_text
   where n.id = p_note_id
     and n.studio_id = p_studio_id
     and n.client_id = p_client_id
     and n.text = p_original_text
     and (v_role = 'owner' or n.created_by_practitioner_id = v_actor);
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return false;
  end if;

  insert into public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_studio_id, v_actor, 'pinned_note_edited', 'client_pinned_note', p_note_id,
          pg_catalog.jsonb_build_object('client_id', p_client_id));
  return true;
end;
$$;

do $$
declare
  f record;
begin
  select p.prosecdef, p.proconfig, p.prosrc, p.proowner into f
    from pg_catalog.pg_proc p
   where p.oid = 'public.edit_client_pinned_note(uuid,uuid,uuid,text,text)'::regprocedure;
  if not f.prosecdef or f.proconfig is null or not (f.proconfig @> array['search_path=""']) then
    raise exception '0349: edit_client_pinned_note is not SECURITY DEFINER with a fixed search_path';
  end if;
  if f.prosrc !~ 'has_studio_permission\(p_studio_id, ''client\.edit_allergies_cautions''' then
    raise exception '0349: edit_client_pinned_note does not check client.edit_allergies_cautions';
  end if;
  if not pg_catalog.has_function_privilege('authenticated', 'public.edit_client_pinned_note(uuid,uuid,uuid,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.edit_client_pinned_note(uuid,uuid,uuid,text,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', 'public.edit_client_pinned_note(uuid,uuid,uuid,text,text)', 'EXECUTE') then
    raise exception '0349: edit_client_pinned_note must be executable by authenticated only';
  end if;
end $$;

commit;
