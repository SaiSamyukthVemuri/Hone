-- PROPOSAL ONLY. Allocate a migration number and rehearse on an owned stack.
-- Never run against hosted databases without the reviewed apply package.
begin;
set local lock_timeout = '5s';

alter table public.studios
  add column studio_managed_appointments boolean not null default false;
comment on column public.studios.studio_managed_appointments is
  'Owner-managed appointments override client self-service without rewriting admission or individual preferences.';

create function public.set_studio_managed_appointments(p_studio_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_enabled is null or p_studio_id is null or auth.uid() is null
     or not public.is_studio_owner(p_studio_id) then
    raise exception using errcode = '42501', message = 'Owner access required';
  end if;
  -- The server selects the active studio; the database proves ownership.
  -- UPDATE takes the same row mutex as the client command guard below.
  update public.studios set studio_managed_appointments = p_enabled
   where id = p_studio_id;
  if not found then
    raise exception using errcode = '42501', message = 'Owner access required';
  end if;
  return p_enabled;
end;
$$;
revoke all on function public.set_studio_managed_appointments(uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_studio_managed_appointments(uuid, boolean) to authenticated;

-- Private to the definer commands. Do not grant a client a studio-policy probe.
-- NO KEY UPDATE serializes mode changes while allowing existing waitlist FK
-- KEY SHARE locks; FOR UPDATE here would invert the entry/studio lock order.
create function public.assert_client_self_service_open(p_studio_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_managed boolean;
begin
  select s.studio_managed_appointments into v_managed
    from public.studios s where s.id = p_studio_id for no key update;
  if not found then return; end if;
  if v_managed then
    raise exception using errcode = '42501', message = 'Client self-service unavailable';
  end if;
end;
$$;
revoke all on function public.assert_client_self_service_open(uuid) from public, anon, authenticated, service_role;

-- Preserve OIDs, arguments, defaults, return rows, ACLs and existing behavior.
-- Prepend one studio-lock guard to the actual migrated definition, rather than
-- copying eight large commands and silently restoring an older implementation.
-- This fails transactionally if a target is missing, overloaded or not PL/pgSQL.
do $patch$
declare
  v_name text;
  v_oid oid;
  v_definition text;
  v_source text;
  v_body text;
  v_guard text;
  v_expr text;
begin
  foreach v_name in array array[
    'create_public_appointment',
    'create_public_appointment_v2',
    'create_public_appointment_for_new_client',
    'create_public_appointment_for_new_client_v2',
    'create_waitlist_public_appointment',
    'redeem_and_book_waitlist_invitation',
    'public_cancel_appointment_with_token',
    'reschedule_appointment_v3'
  ] loop
    select p.oid, pg_catalog.pg_get_functiondef(p.oid), p.prosrc
      into strict v_oid, v_definition, v_source
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
     where n.nspname = 'public' and p.proname = v_name
       and l.lanname = 'plpgsql' and p.prosecdef
       and (v_name <> 'public_cancel_appointment_with_token' or p.pronargs = 7)
       and p.proowner = (select h.proowner from pg_catalog.pg_proc h
                         where h.oid = 'public.assert_client_self_service_open(uuid)'::regprocedure);
    if position('assert_client_self_service_open' in v_source) > 0 then
      raise exception 'Studio-managed guard already present on %', v_name;
    end if;
    v_expr := case
      when v_name = 'public_cancel_appointment_with_token' then
        '(select a.studio_id from public.appointments a where a.cancellation_token_hash = p_token)'
      when v_name in ('reschedule_appointment_v3', 'reschedule_appointment_v2') then
        '(select a.studio_id from public.appointments a where a.id = p_original_appointment_id)'
      else 'p_studio_id'
    end;
    v_guard := E'BEGIN\n  PERFORM public.assert_client_self_service_open(' || v_expr || E');\n';
    v_body := pg_catalog.regexp_replace(v_source, E'(^|\n)[\t ]*begin[\t ]*\n', E'\n' || v_guard, 'i');
    if v_body = v_source or position(v_source in v_definition) = 0 then
      raise exception 'Cannot locate the command body for %', v_name;
    end if;
    execute pg_catalog.replace(v_definition, v_source, v_body);
  end loop;
end;
$patch$;

commit;
