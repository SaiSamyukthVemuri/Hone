-- Rollback of 0349: restore edit_client_pinned_note exactly as 0254 defined it (no permission check).
-- Reversing this lets any member who may edit a pinned caution do so regardless of the clin.view_records permission.
begin;
set local lock_timeout = '5s';

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

  -- The caller is derived from auth.uid() and the NAMED studio, never supplied.
  -- No row, an inactive row, or no session all answer false, the same answer a
  -- missing or stale note gets, so nothing about who wrote a caution is disclosed.
  select p.id, p.role into v_actor, v_role
    from public.practitioners p
   where p.user_id = auth.uid()
     and p.studio_id = p_studio_id
     and p.active is true;
  if v_actor is null then
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

commit;
